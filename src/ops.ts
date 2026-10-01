import type { Ctx } from './ctx.js'
import { DAY_MS, HELD_TEXT_MAX_DAYS } from './ctx.js'
import type { Q, Row } from './db.js'
import { TelegramError, type ChatMemberInfo, type ChatPermissions, type InlineButton, type TextEntity } from './ports.js'
import { getSettings } from './settings/settings.js'
import { karmaTag } from './text.js'

type OpKind =
  | 'delete_message'
  | 'restrict'
  | 'ban'
  | 'unban'
  | 'ban_sender_chat'
  | 'unban_sender_chat'
  | 'send_message'
  | 'edit_message'
  | 'set_reaction'
  | 'set_tag'
type OpStatus = 'pending' | 'running' | 'completed' | 'failed' | 'outcome_unknown'

interface OpPayload {
  userId?: number
  banId?: string
  messageId?: number
  sentAt?: string
  text?: string
  to?: number
  buttons?: InlineButton[][]
  entities?: TextEntity[]
  permissions?: ChatPermissions
  untilDate?: number
  emoji?: string
  template?: string
  intervalMs?: number
  /** The text quotes a member (a card, a returned message): section 3.10 limits how long it may wait. */
  memberText?: boolean
}

export interface OpSpec {
  chatId: number
  key: string
  kind: OpKind
  payload: OpPayload
}

export interface OpOutcome {
  status: OpStatus
  code: string | null
  result: Record<string, unknown> | null
}

const MAX_ATTEMPTS = 3
const MAX_RATE_LIMIT_ATTEMPTS = 5
const LEASE_MS = 5 * 60_000
const GROUP_SENDS_PER_MINUTE = 20
const TAG_CALLS_PER_MINUTE = 20

/**
 * Who may get a karma tag (section 3.12): not a bot, not a channel (section 3.6.4), not an administrator or the owner, still in the
 * chat, not refused by Telegram.
 */
export const TAG_ELIGIBLE = `NOT m.is_bot AND NOT m.is_channel AND m.tag_exempt IS NULL AND COALESCE(m.status, 'member') NOT IN ('creator', 'administrator', 'left', 'kicked')`

export const NO_PERMISSIONS: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
}

export const ALL_PERMISSIONS: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
}

export const TEXT_ONLY_PERMISSIONS: ChatPermissions = { ...NO_PERMISSIONS, can_send_messages: true }

const IDEMPOTENT_GONE = /PARTICIPANT|user not found|USER_NOT_PARTICIPANT|member not found|chat member not found/i
const ADMIN_TARGET = /administrator|owner|creator|can't be restricted|can't remove chat owner/i
const TAG_NO_RIGHTS = /rights|CHAT_ADMIN_REQUIRED|not an administrator|forbidden/i
const TAG_NOT_CHANGEABLE = /administrator|owner|creator|can't change|can't be changed|USER_ADMIN_INVALID/i
/** The member cannot be reached: left the chat or the account is deactivated (403 "Forbidden: user is deactivated"). */
const TAG_MEMBER_GONE = /PARTICIPANT|user not found|member not found|deactivated/i

function toOutcome(row: Row): OpOutcome {
  return { status: row.status as OpStatus, code: row.last_error_code ?? null, result: row.result ?? null }
}

export async function submitOpIn(q: Q, now: Date, spec: OpSpec): Promise<void> {
  await q.query(
    `INSERT INTO operations (chat_id, operation_kind, idempotency_key, payload, status, next_attempt_at, created_at)
     VALUES ($1,$2,$3,$4,'pending',$5,$5) ON CONFLICT (chat_id, idempotency_key) DO NOTHING`,
    [spec.chatId, spec.kind, spec.key, JSON.stringify(spec.payload), now],
  )
}

export async function submitOp(ctx: Ctx, spec: OpSpec): Promise<void> {
  await submitOpIn(ctx.db, ctx.clock.now(), spec)
}

/** Creates the operation if needed and makes one attempt when it is due. */
export async function execOp(ctx: Ctx, spec: OpSpec): Promise<OpOutcome> {
  await submitOp(ctx, spec)
  const rows = await ctx.db.query('SELECT * FROM operations WHERE chat_id = $1 AND idempotency_key = $2', [spec.chatId, spec.key])
  return attempt(ctx, rows[0])
}

async function groupSendDelay(ctx: Ctx, op: Row): Promise<Date | null> {
  const to = op.payload.to ?? op.chat_id
  if (op.operation_kind !== 'send_message' || to >= 0) return null
  const since = new Date(ctx.clock.now().getTime() - 60_000)
  const rows = await ctx.db.query(
    `SELECT count(*)::int AS n, min(completed_at) AS oldest FROM operations
     WHERE operation_kind = 'send_message' AND status = 'completed' AND completed_at > $2
       AND COALESCE((payload->>'to')::bigint, chat_id) = $1`,
    [to, since],
  )
  if (rows[0].n < GROUP_SENDS_PER_MINUTE) return null
  return new Date(new Date(rows[0].oldest).getTime() + 60_000)
}

/** Section 3.12: one tag call per member per interval, and at most 20 tag calls a minute in a chat. */
async function tagDelay(ctx: Ctx, op: Row): Promise<Date | null> {
  const member = await ctx.db.query('SELECT tag_set_at FROM members WHERE chat_id = $1 AND user_id = $2', [op.chat_id, op.payload.userId])
  const setAt = member[0]?.tag_set_at
  const earliest = setAt ? new Date(new Date(setAt).getTime() + (op.payload.intervalMs ?? 0)) : null
  if (earliest && earliest > ctx.clock.now()) return earliest
  const rows = await ctx.db.query(
    `SELECT count(*)::int AS n, min(claimed_at) AS oldest FROM operations
     WHERE chat_id = $1 AND operation_kind = 'set_tag' AND claimed_at > $2 AND (result IS NULL OR NOT result ? 'skipped')`,
    [op.chat_id, new Date(ctx.clock.now().getTime() - 60_000)],
  )
  if (rows[0].n < TAG_CALLS_PER_MINUTE) return null
  return new Date(new Date(rows[0].oldest).getTime() + 60_000)
}

function dueDelay(ctx: Ctx, op: Row): Promise<Date | null> {
  return op.operation_kind === 'set_tag' ? tagDelay(ctx, op) : groupSendDelay(ctx, op)
}

/** Pending operations whose member text is older than the held-text limit: they fail as `expired` and lose the text. */
const EXPIRED_MEMBER_TEXT = `status = 'pending' AND payload->>'memberText' = 'true' AND created_at <= $1`
const EXPIRE_SET = `status = 'failed', last_error_code = 'expired', last_error_at = $2, payload = payload - 'text'`

function memberTextCutoff(now: Date): Date {
  return new Date(now.getTime() - HELD_TEXT_MAX_DAYS * DAY_MS)
}

/** Section 3.10: a member's text is never sent after it is 30 days old, also after a long stop and before the cleanup ran. */
export async function expireMemberTextOps(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now()
  await ctx.db.query(`UPDATE operations SET ${EXPIRE_SET} WHERE ${EXPIRED_MEMBER_TEXT}`, [memberTextCutoff(now), now])
}

async function expireIfStale(ctx: Ctx, op: Row): Promise<OpOutcome | null> {
  const now = ctx.clock.now()
  const rows = await ctx.db.query(`UPDATE operations SET ${EXPIRE_SET} WHERE ${EXPIRED_MEMBER_TEXT} AND operation_id = $3 RETURNING *`, [
    memberTextCutoff(now),
    now,
    op.operation_id,
  ])
  if (rows.length === 0) return null
  ctx.log.info('operation_expired', { operation_id: op.operation_id, kind: op.operation_kind })
  return toOutcome(rows[0])
}

async function attempt(ctx: Ctx, op: Row): Promise<OpOutcome> {
  const now = ctx.clock.now()
  if (op.status !== 'pending' || new Date(op.next_attempt_at) > now) return toOutcome(op)
  const expired = await expireIfStale(ctx, op)
  if (expired) return expired
  const delay = await dueDelay(ctx, op)
  if (delay) {
    await ctx.db.query('UPDATE operations SET next_attempt_at = $2 WHERE operation_id = $1', [op.operation_id, delay])
    return { status: 'pending', code: 'queued', result: null }
  }
  const claimed = await ctx.db.query(
    `UPDATE operations o SET status = 'running', claimed_at = $2
     WHERE operation_id = $1 AND status = 'pending' AND next_attempt_at <= $2 AND ${BAN_STILL_DUE} RETURNING *`,
    [op.operation_id, now],
  )
  if (claimed.length === 0) return cancelIfNotDue(ctx, op)
  return finish(ctx, claimed[0])
}

/**
 * A ban out of the steam room carries its `banId` and is checked again right before every call:
 * an accepted or started appeal, or a record that is gone, cancels it (section 3.6).
 */
const BAN_STILL_DUE = `(o.operation_kind <> 'ban' OR o.payload->>'banId' IS NULL OR EXISTS (
  SELECT 1 FROM bans b WHERE b.ban_id::text = o.payload->>'banId' AND b.state = 'steam' AND b.appeal_status NOT IN ('accepted', 'evaluating')))`

async function cancelIfNotDue(ctx: Ctx, op: Row): Promise<OpOutcome> {
  const cancelled = await ctx.db.query(
    `UPDATE operations o SET status = 'failed', last_error_code = 'cancelled', last_error_at = $2
     WHERE operation_id = $1 AND status = 'pending' AND NOT ${BAN_STILL_DUE} RETURNING 1`,
    [op.operation_id, ctx.clock.now()],
  )
  if (cancelled.length === 0) return { status: 'running', code: null, result: null }
  ctx.log.info('operation_cancelled', { operation_id: op.operation_id, kind: op.operation_kind })
  return { status: 'failed', code: 'cancelled', result: null }
}

async function finish(ctx: Ctx, op: Row): Promise<OpOutcome> {
  let outcome: OpOutcome
  try {
    outcome = { status: 'completed', code: null, result: await perform(ctx, op) }
  } catch (error) {
    outcome = classify(ctx, op, error)
  }
  const now = ctx.clock.now()
  const attempts = op.attempt_count + 1
  const failedAt = outcome.code ? now : null
  const retryAfter = outcome.status === 'pending' ? retryDelay(op, attempts, outcome.result) : 0
  await ctx.db.query(
    `UPDATE operations SET status = $2, attempt_count = $3, next_attempt_at = $4, last_error_code = $5,
       last_error_at = COALESCE($6, last_error_at), result = $7, completed_at = $8,
       payload = CASE WHEN $2 IN ('completed','failed','outcome_unknown') THEN payload - 'text' ELSE payload END
     WHERE operation_id = $1`,
    [
      op.operation_id,
      outcome.status,
      attempts,
      new Date(now.getTime() + retryAfter),
      outcome.code,
      failedAt,
      outcome.result ? JSON.stringify(outcome.result) : null,
      outcome.status === 'completed' ? now : null,
    ],
  )
  await afterFinish(ctx, op, outcome)
  return outcome
}

async function afterFinish(ctx: Ctx, op: Row, outcome: OpOutcome): Promise<void> {
  if (outcome.status === 'failed' || outcome.status === 'outcome_unknown') {
    ctx.log.error('operation_not_completed', { operation_id: op.operation_id, kind: op.operation_kind, status: outcome.status, code: outcome.code })
  }
  if (op.operation_kind === 'set_tag' && TAG_EXEMPT_CODES.has(outcome.code ?? '')) {
    await ctx.db.query('UPDATE members SET tag_exempt = $3 WHERE chat_id = $1 AND user_id = $2', [op.chat_id, op.payload.userId, outcome.code])
  }
}

/** Refusals that mark the member as not subject to a tag. */
const TAG_EXEMPT_CODES = new Set(['target_admin', 'human_tag'])

class TagRefusal extends Error {
  constructor(public readonly code: 'target_admin' | 'human_tag') {
    super(code)
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A tag of the karma form for the template, whatever the number: `+7`, `-3`, `0` for `{n}`. */
function isKarmaForm(tag: string, template: string): boolean {
  return new RegExp(`^${template.split('{n}').map(escapeRegExp).join('[+-]?\\d+')}$`).test(tag)
}

/** The role and the current tag come from the same answer; a tag a person set is never overwritten. */
function tagIsPresent(member: ChatMemberInfo, want: { tag: string; last: string | null; template: string }): boolean {
  if (member.status === 'creator' || member.status === 'administrator') throw new TagRefusal('target_admin')
  const current = member.tag ?? ''
  if (current === want.tag) return true
  if (current === '' || current === want.last || isKarmaForm(current, want.template)) return false
  throw new TagRefusal('human_tag')
}

/** The member as the tag sees it now, or null when tags are switched off or the member is not subject to a tag. */
async function tagMember(ctx: Ctx, op: Row): Promise<Row | null> {
  if (!(await getSettings(ctx.db, op.chat_id)).bool('karma_tag_enabled')) return null
  const rows = await ctx.db.query(`SELECT m.karma, m.tag_text FROM members m WHERE m.chat_id = $1 AND m.user_id = $2 AND ${TAG_ELIGIBLE}`, [op.chat_id, op.payload.userId])
  return rows[0] ?? null
}

/** An imported history does not say who is a bot; Telegram does, and a bot leaves the rating and gets no tag. */
async function markBot(ctx: Ctx, chatId: number, userId: number): Promise<Record<string, unknown>> {
  await ctx.db.query('UPDATE members SET is_bot = true WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  return { skipped: true, bot: true }
}

/** The tag takes the karma at the moment of sending; a text equal to the one set last is not sent again. */
async function performTag(ctx: Ctx, op: Row): Promise<Record<string, unknown>> {
  const { userId, template } = op.payload as { userId: number; template: string }
  const row = await tagMember(ctx, op)
  if (row === null) return { skipped: true }
  const tag = karmaTag(template, row.karma)
  if (tag === row.tag_text) return { skipped: true }
  const member = await ctx.tg.getChatMember(op.chat_id, userId)
  if (member.is_bot) return markBot(ctx, op.chat_id, userId)
  const present = tagIsPresent(member, { tag, last: row.tag_text, template })
  if (!present) await ctx.tg.setChatMemberTag(op.chat_id, userId, tag)
  await ctx.db.query('UPDATE members SET tag_text = $3, tag_set_at = $4 WHERE chat_id = $1 AND user_id = $2', [op.chat_id, userId, tag, ctx.clock.now()])
  return present ? { skipped: true, adopted: tag } : { tag }
}

function retryDelay(op: Row, attempts: number, result: Record<string, unknown> | null): number {
  if (result && typeof result.retryAfterMs === 'number') return result.retryAfterMs
  return 2 ** attempts * 1000
}

type Payload = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Performer = (ctx: Ctx, op: Row, p: Payload) => Promise<Record<string, unknown> | null>

/** A call that returns nothing to keep. */
async function nothing(call: Promise<void>): Promise<null> {
  await call
  return null
}

/** The Telegram call of each kind of operation, with what it returns to keep. */
const PERFORMERS: Record<OpKind, Performer> = {
  delete_message: (ctx, op, p) => nothing(ctx.tg.deleteMessage(op.chat_id, p.messageId)),
  restrict: (ctx, op, p) => nothing(ctx.tg.restrictChatMember(op.chat_id, p.userId, p.permissions, p.untilDate)),
  ban: (ctx, op, p) => nothing(ctx.tg.banChatMember(op.chat_id, p.userId)),
  unban: (ctx, op, p) => nothing(ctx.tg.unbanChatMember(op.chat_id, p.userId)),
  ban_sender_chat: (ctx, op, p) => nothing(ctx.tg.banChatSenderChat(op.chat_id, p.userId)),
  unban_sender_chat: (ctx, op, p) => nothing(ctx.tg.unbanChatSenderChat(op.chat_id, p.userId)),
  send_message: async (ctx, op, p) => {
    const sent = await ctx.tg.sendMessage(p.to ?? op.chat_id, p.text, { buttons: p.buttons, entities: p.entities })
    return { message_id: sent.message_id }
  },
  edit_message: (ctx, _op, p) => nothing(ctx.tg.editMessageText(p.to, p.messageId, p.text, { buttons: p.buttons, entities: p.entities })),
  set_reaction: (ctx, op, p) => nothing(ctx.tg.setMessageReaction(op.chat_id, p.messageId, p.emoji)),
  set_tag: (ctx, op) => performTag(ctx, op),
}

function perform(ctx: Ctx, op: Row): Promise<Record<string, unknown> | null> {
  return PERFORMERS[op.operation_kind as OpKind](ctx, op, op.payload as Payload)
}

const failed = (code: string): OpOutcome => ({ status: 'failed', code, result: null })
const done = (): OpOutcome => ({ status: 'completed', code: null, result: { gone: true } })

function classifyDelete(ctx: Ctx, op: Row, error: TelegramError): OpOutcome {
  const old = op.payload.sentAt && ctx.clock.now().getTime() - new Date(op.payload.sentAt).getTime() > 2 * DAY_MS
  if (/not found/i.test(error.message) || old) return done()
  return failed(/rights|forbidden/i.test(error.message) || error.code === 403 ? 'no_rights' : 'denied')
}

function classifyMemberAction(kind: OpKind, error: TelegramError): OpOutcome | null {
  if ((kind === 'restrict' || kind === 'unban') && IDEMPOTENT_GONE.test(error.message)) return done()
  if ((kind === 'restrict' || kind === 'ban') && ADMIN_TARGET.test(error.message)) return failed('target_admin')
  return null
}

/** Section 4, T-tag-denied: none of these is retried. */
function classifyTag(error: TelegramError): OpOutcome {
  if (TAG_MEMBER_GONE.test(error.message)) return failed('member_gone')
  if (error.code === 403 || TAG_NO_RIGHTS.test(error.message)) return failed('no_rights')
  return failed(TAG_NOT_CHANGEABLE.test(error.message) ? 'target_admin' : 'tag_denied')
}

function classifyClient(ctx: Ctx, op: Row, error: TelegramError): OpOutcome {
  const kind = op.operation_kind as OpKind
  if (kind === 'delete_message') return classifyDelete(ctx, op, error)
  if (kind === 'set_tag') return classifyTag(error)
  // Section 4, T-card-edit: an unchanged card counts as edited; any other 400 is not repeated.
  if (kind === 'edit_message' && /not modified/i.test(error.message)) return done()
  const member = classifyMemberAction(kind, error)
  if (member) return member
  if (error.code === 403 || /rights|forbidden/i.test(error.message)) return failed('no_rights')
  return failed(kind === 'set_reaction' ? 'reaction_denied' : 'client_error')
}

function retryOrFail(exhausted: boolean, code: string): OpOutcome {
  return { status: exhausted ? 'failed' : 'pending', code, result: null }
}

function classify(ctx: Ctx, op: Row, error: unknown): OpOutcome {
  const exhausted = op.attempt_count + 1 >= MAX_ATTEMPTS
  if (error instanceof TagRefusal) return failed(error.code)
  if (!(error instanceof TelegramError)) return retryOrFail(exhausted, 'unexpected')
  if (error.kind === 'client') return classifyClient(ctx, op, error)
  if (error.kind === 'rate_limit') {
    if (op.attempt_count + 1 >= MAX_RATE_LIMIT_ATTEMPTS) return failed('rate_limit')
    return { status: 'pending', code: 'rate_limit', result: { retryAfterMs: (error.retryAfter ?? 1) * 1000 } }
  }
  if (error.kind === 'unknown_outcome') {
    if (op.operation_kind === 'send_message') return { status: 'outcome_unknown', code: 'lost_response', result: null }
    return retryOrFail(exhausted, 'network')
  }
  return retryOrFail(exhausted, error.kind)
}

/** Operations left running by a stopped process. Sends cannot be replayed safely. */
export async function recoverStaleOps(ctx: Ctx): Promise<void> {
  const cutoff = new Date(ctx.clock.now().getTime() - LEASE_MS)
  await ctx.db.query(
    `UPDATE operations SET status = CASE WHEN operation_kind = 'send_message' THEN 'outcome_unknown' ELSE 'pending' END,
       payload = CASE WHEN operation_kind = 'send_message' THEN payload - 'text' ELSE payload END,
       last_error_code = 'lost_response', last_error_at = $1
     WHERE status = 'running' AND claimed_at < $2`,
    [ctx.clock.now(), cutoff],
  )
}

export async function runDueOps(ctx: Ctx, limit = 50): Promise<number> {
  const rows = await ctx.db.query(
    `SELECT * FROM operations WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY operation_id LIMIT $2`,
    [ctx.clock.now(), limit],
  )
  for (const row of rows) await attempt(ctx, row)
  return rows.length
}
