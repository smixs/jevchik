import { readFileSync } from 'node:fs'
import type { Ctx } from './ctx.js'
import { HOUR_MS } from './ctx.js'
import type { Q } from './db.js'
import { createCard, type CardKind, type CardPayload } from './cards.js'
import { createFlow, registerFlow, type Flow, type Step, type StepResult } from './flows.js'
import { ALL_PERMISSIONS, execOp, NO_PERMISSIONS, TEXT_ONLY_PERMISSIONS, type OpOutcome } from './ops.js'
import type { ChatPermissions } from './ports.js'
import { withRetry } from './retry.js'
import { getSettings } from './settings/settings.js'

export interface Jokes {
  replies: string[]
  explanations: string[]
  images: string[]
}

let jokes: Jokes | null = null

export function loadJokes(): Jokes {
  jokes ??= JSON.parse(readFileSync(new URL('../data-static/jokes.json', import.meta.url), 'utf8')) as Jokes
  return jokes
}

export type Action = 'none' | 'card_protected' | 'steam' | 'delete_card' | 'card_review'

export interface DecideInput {
  karma: number
  isFirst: boolean
  /** Section 3.6.0: the text is judged for a newcomer (and on probation); for anybody else the spam score leads to nothing. */
  judged: boolean
  /** Spec 3.6.0: the profile rule applies only to a newcomer by the message count. */
  newcomer: boolean
  probation: boolean
  spam: number | null
  profilePromo: number | null
  auto: number
  profileAuto: number
  /** The lowered deletion threshold of probation (section 3.6); rule 4 for everybody else is cancelled (section 3.6.2). */
  reviewDelete: number
  review: number
  protect: number
}

export interface Decision {
  rule: number
  action: Action
}

const AT_LEAST = (value: number | null, threshold: number): boolean => value !== null && value >= threshold

function protectedRule(i: DecideInput): Decision {
  return { rule: 2, action: i.judged ? 'card_protected' : 'none' }
}

/** Section 3.6.2: a judged score at the threshold of automatic deletion, or an advertising profile on the first message. */
function steamRule(i: DecideInput, spam: number | null, profileHigh: boolean): boolean {
  return AT_LEAST(spam, i.auto) || (i.isFirst && profileHigh)
}

/**
 * Rules 2-6 of section 3.6 with sections 3.6.0 and 3.6.2, top to bottom, first match wins. Observation mode does not touch
 * spam any more (section 3.6.3). The text score counts only when `judged`; rule 2 still shields a protected member from the
 * profile rule, without a card when the member is not a newcomer. Rule 4 stays only for probation.
 */
export function decide(i: DecideInput): Decision {
  const spam = i.judged ? i.spam : null
  const profileHigh = i.newcomer && AT_LEAST(i.profilePromo, i.profileAuto)
  if (i.karma >= i.protect && (AT_LEAST(spam, i.review) || profileHigh)) return protectedRule(i)
  if (steamRule(i, spam, profileHigh)) return { rule: 3, action: 'steam' }
  if (i.probation && AT_LEAST(spam, i.reviewDelete)) return { rule: 4, action: 'delete_card' }
  if (AT_LEAST(spam, i.review)) return { rule: 5, action: 'card_review' }
  return { rule: 6, action: 'none' }
}

// ---------------------------------------------------------------- flow helpers

const STEP_WORDS: Array<[step: string, done: string, failed: string]> = [
  ['delete', 'удалил сообщение', 'удалить сообщение не смог'],
  ['restrict', 'ограничил участника', 'ограничить участника не смог'],
]

/** Section 3.6.1: what the flow did to the message and its author so far, from the states of its operations. */
async function flowDone(ctx: Ctx, flow: Flow): Promise<string | undefined> {
  const keys = STEP_WORDS.map(([step]) => `${flow.key}:${step}`)
  const rows = await ctx.db.query('SELECT idempotency_key, status FROM operations WHERE chat_id = $1 AND idempotency_key = ANY($2)', [flow.chatId, keys])
  const status = new Map(rows.map((r) => [r.idempotency_key as string, r.status as string]))
  const parts = STEP_WORDS.flatMap(([step, done, failed]) => {
    const state = status.get(`${flow.key}:${step}`)
    if (state === 'completed') return [done]
    return state === 'failed' || state === 'outcome_unknown' ? [failed] : []
  })
  return parts.length > 0 ? parts.join('; ') : undefined
}

/** A flow started by a card button is quiet: the edited card says what happened (section 3.6.2), so no card of its own. */
async function card(ctx: Ctx, flow: Flow, kind: CardKind, extra: CardPayload = {}): Promise<void> {
  const d = flow.data
  if (d.quiet === true) return
  const done = d.messageId == null ? undefined : await flowDone(ctx, flow)
  await createCard(ctx.db, {
    chatId: flow.chatId,
    key: `${kind}:${flow.key}`,
    kind,
    payload: { targetUserId: d.userId, targetName: d.name, messageId: d.messageId, category: d.category, spam: d.spam ?? null, done, ...extra },
    now: ctx.clock.now(),
  })
}

type Role = 'admin' | 'member' | 'unknown'

const ROLE_CHECKS = 3

/** "Cannot tell" is its own answer: only a successful answer with a non-administrator status may be sanctioned. */
export async function targetRole(ctx: Ctx, flow: Flow): Promise<Role> {
  try {
    const member = await withRetry(ctx, () => ctx.tg.getChatMember(flow.chatId, flow.data.userId))
    return member.status === 'creator' || member.status === 'administrator' ? 'admin' : 'member'
  } catch {
    return 'unknown'
  }
}

async function bumpRoleChecks(ctx: Ctx, flow: Flow): Promise<number> {
  const rows = await ctx.db.query(
    `UPDATE flows SET data = data || jsonb_build_object('roleChecks', COALESCE((data->>'roleChecks')::int, 0) + 1)
     WHERE flow_id = $1 RETURNING (data->>'roleChecks')::int AS n`,
    [flow.flowId],
  )
  return rows[0].n as number
}

function waiting(outcome: OpOutcome): boolean {
  return outcome.status === 'pending' || outcome.status === 'running'
}

/** Remembers in the flow why it stopped, for the answer to the admin who pressed a button. */
export async function markFlow(ctx: Ctx, flow: Flow, data: Record<string, unknown>): Promise<void> {
  Object.assign(flow.data, data)
  await ctx.db.query('UPDATE flows SET data = data || $2 WHERE flow_id = $1', [flow.flowId, JSON.stringify(data)])
}

export async function checkTarget(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const role = await targetRole(ctx, flow)
  if (role === 'member') return 'ok'
  if (role === 'admin') {
    await markFlow(ctx, flow, { halt: 'target_admin' })
    await card(ctx, flow, 'target_admin')
    return 'stop'
  }
  return roleUnknown(ctx, flow)
}

/** The role could not be checked: a few more tries, then a failure card and no sanction. */
export async function roleUnknown(ctx: Ctx, flow: Flow): Promise<StepResult> {
  if ((await bumpRoleChecks(ctx, flow)) < ROLE_CHECKS) return 'wait'
  await markFlow(ctx, flow, { halt: 'role_unknown' })
  await card(ctx, flow, 'op_failed')
  return 'stop'
}

export async function deleteStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const outcome = await execOp(ctx, {
    chatId: flow.chatId,
    key: `${flow.key}:delete`,
    kind: 'delete_message',
    payload: { messageId: flow.data.messageId, sentAt: flow.data.sentAt },
  })
  if (waiting(outcome)) return 'wait'
  if (outcome.status === 'failed') await card(ctx, flow, 'delete_denied')
  return 'ok'
}

async function restrictStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const outcome = await execOp(ctx, {
    chatId: flow.chatId,
    key: `${flow.key}:restrict`,
    kind: 'restrict',
    payload: { userId: flow.data.userId, permissions: NO_PERMISSIONS },
  })
  if (waiting(outcome)) return 'wait'
  if (outcome.status === 'completed') return 'ok'
  await card(ctx, flow, failureCard(outcome.code))
  return 'stop'
}

function failureCard(code: string | null): CardKind {
  if (code === 'target_admin') return 'target_admin'
  return code === 'no_rights' ? 'no_rights' : 'op_failed'
}

async function recordStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const settings = await getSettings(ctx.db, flow.chatId, flow.settingsSeq)
  const d = flow.data
  const until = new Date(flow.createdAt.getTime() + settings.num('steam_hours') * HOUR_MS)
  await ctx.db.tx(async (q) => {
    const rows = await q.query(
      `INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'steam',$7,$8) ON CONFLICT (chat_id, user_id) DO NOTHING RETURNING ban_id`,
      [flow.chatId, d.userId, d.category, d.jokeIdx, d.explanationIdx, d.imageIdx, until, flow.createdAt],
    )
    if (rows.length > 0) await q.query('UPDATE members SET bans_count = bans_count + 1 WHERE chat_id = $1 AND user_id = $2', [flow.chatId, d.userId])
  })
  return 'ok'
}

function appealUrl(ctx: Ctx, chatId: number): string {
  return `https://t.me/${ctx.env.botUsername}?startapp=appeal_${chatId}`
}

async function sendStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const text = loadJokes().replies[flow.data.jokeIdx].replaceAll('{name}', flow.data.name)
  const outcome = await execOp(ctx, {
    chatId: flow.chatId,
    key: `${flow.key}:send`,
    kind: 'send_message',
    payload: { text, buttons: [[{ text: 'Я не спамер', url: appealUrl(ctx, flow.chatId) }]] },
  })
  return waiting(outcome) ? 'wait' : 'ok'
}

/** The card says whether the deletion went through (section 3.6.1). */
async function reviewCardStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  if (flow.data.noCard !== true) await card(ctx, flow, 'review')
  return 'ok'
}

// ---------------------------------------------------------------- ban transition

async function banAllowed(ctx: Ctx, flow: Flow): Promise<boolean> {
  const rows = await ctx.db.query('SELECT state, appeal_status FROM bans WHERE ban_id = $1', [flow.data.banId])
  return rows[0]?.state === 'steam' && !['accepted', 'evaluating'].includes(rows[0].appeal_status)
}

async function banStillDue(ctx: Ctx, flow: Flow): Promise<StepResult> {
  return (await banAllowed(ctx, flow)) ? 'ok' : 'stop'
}

export async function banCall(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const started = await ctx.db.query('SELECT 1 FROM operations WHERE chat_id = $1 AND idempotency_key = $2', [flow.chatId, `${flow.key}:ban`])
  if (started.length === 0 && flow.kind === 'ban' && !(await banAllowed(ctx, flow))) return 'stop'
  const outcome = await execOp(ctx, {
    chatId: flow.chatId,
    key: `${flow.key}:ban`,
    kind: 'ban',
    payload: { userId: flow.data.userId, banId: flow.data.banId },
  })
  if (waiting(outcome)) return 'wait'
  if (outcome.status === 'completed') return 'ok'
  if (outcome.code === 'cancelled') return 'stop'
  await card(ctx, flow, failureCard(outcome.code))
  return 'stop'
}

async function banRecord(ctx: Ctx, flow: Flow): Promise<StepResult> {
  await ctx.db.query(`UPDATE bans SET state = 'banned' WHERE ban_id = $1 AND state = 'steam'`, [flow.data.banId])
  return 'ok'
}

// ---------------------------------------------------------------- unban

/** Absent permissions in the answer mean "no overrides": an explicit full set. A failed call is `null`. */
async function defaultPermissions(ctx: Ctx, chatId: number): Promise<ChatPermissions | null> {
  try {
    return (await withRetry(ctx, () => ctx.tg.getChat(chatId))).permissions ?? ALL_PERMISSIONS
  } catch {
    return null
  }
}

export async function liftStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const rows = await ctx.db.query('SELECT state FROM bans WHERE chat_id = $1 AND user_id = $2', [flow.chatId, flow.data.userId])
  const state = rows[0]?.state ?? 'banned'
  let outcome: OpOutcome
  if (state === 'steam') {
    const permissions = await defaultPermissions(ctx, flow.chatId)
    if (!permissions) return 'wait'
    outcome = await execOp(ctx, { chatId: flow.chatId, key: `${flow.key}:lift`, kind: 'restrict', payload: { userId: flow.data.userId, permissions } })
  } else {
    outcome = await execOp(ctx, { chatId: flow.chatId, key: `${flow.key}:lift`, kind: 'unban', payload: { userId: flow.data.userId } })
  }
  if (waiting(outcome)) return 'wait'
  return outcome.status === 'completed' ? 'ok' : 'stop'
}

export async function unbanRecord(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const settings = await getSettings(ctx.db, flow.chatId, flow.settingsSeq)
  await ctx.db.tx(async (q) => {
    await q.query('DELETE FROM bans WHERE chat_id = $1 AND user_id = $2', [flow.chatId, flow.data.userId])
    if (flow.data.probation === true) {
      await q.query('UPDATE members SET probation_left = $3 WHERE chat_id = $1 AND user_id = $2', [
        flow.chatId,
        flow.data.userId,
        settings.num('probation_messages'),
      ])
    }
  })
  return 'ok'
}

// ---------------------------------------------------------------- admin ban and karma punishments

export async function adminBanRecord(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const d = flow.data
  await ctx.db.tx(async (q) => {
    const rows = await q.query(
      `INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'banned',$7,$7) ON CONFLICT (chat_id, user_id) DO UPDATE SET state = 'banned' RETURNING (xmax = 0) AS created`,
      [flow.chatId, d.userId, d.category ?? 'admin', d.jokeIdx ?? 0, d.explanationIdx ?? 0, d.imageIdx ?? 0, flow.createdAt],
    )
    if (rows[0].created) await q.query('UPDATE members SET bans_count = bans_count + 1 WHERE chat_id = $1 AND user_id = $2', [flow.chatId, d.userId])
  })
  return 'ok'
}

async function punishStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const d = flow.data
  const permissions = d.level === 1 ? TEXT_ONLY_PERMISSIONS : NO_PERMISSIONS
  const outcome = await execOp(ctx, {
    chatId: flow.chatId,
    key: `${flow.key}:restrict`,
    kind: 'restrict',
    payload: { userId: d.userId, permissions, untilDate: d.untilDate ?? undefined },
  })
  return waiting(outcome) ? 'wait' : 'ok'
}

async function unpunishStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const permissions = await defaultPermissions(ctx, flow.chatId)
  if (!permissions) return 'wait'
  const outcome = await execOp(ctx, {
    chatId: flow.chatId,
    key: `${flow.key}:restrict`,
    kind: 'restrict',
    payload: { userId: flow.data.userId, permissions },
  })
  return waiting(outcome) ? 'wait' : 'ok'
}

async function quietCheck(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const role = await targetRole(ctx, flow)
  if (role === 'member') return 'ok'
  if (role === 'admin') return 'stop'
  if ((await bumpRoleChecks(ctx, flow)) < ROLE_CHECKS) return 'wait'
  await punishmentNotApplied(ctx, flow)
  return 'stop'
}

/** The level was recorded at the crossing; a punishment that never reached Telegram falls back to the one before it. */
async function punishmentNotApplied(ctx: Ctx, flow: Flow): Promise<void> {
  const d = flow.data
  const previous = d.previous ?? { level: 0, muteUntil: null }
  await ctx.db.query('UPDATE members SET punish_level = $3, mute_until = $4 WHERE chat_id = $1 AND user_id = $2 AND punish_level = $5', [
    flow.chatId,
    d.userId,
    previous.level,
    previous.muteUntil,
    d.level,
  ])
  const rows = await ctx.db.query('SELECT display_name FROM members WHERE chat_id = $1 AND user_id = $2', [flow.chatId, d.userId])
  await card(ctx, flow, 'op_failed', { targetName: rows[0]?.display_name })
}

async function opStatus(ctx: Ctx, chatId: number, key: string): Promise<string | null> {
  const rows = await ctx.db.query('SELECT status FROM operations WHERE chat_id = $1 AND idempotency_key = $2', [chatId, key])
  return rows[0]?.status ?? null
}

/** The card buttons follow the message: it counts as deleted once the deletion went through. */
export async function markDeleted(ctx: Ctx, flow: Flow): Promise<StepResult> {
  if ((await opStatus(ctx, flow.chatId, `${flow.key}:delete`)) !== 'completed') return 'ok'
  await ctx.db.query('UPDATE messages SET deleted = true, excerpt = NULL WHERE chat_id = $1 AND message_id = $2', [flow.chatId, flow.data.messageId])
  return 'ok'
}

/** Section 3.6.2: after an automatic deletion admins get «Удалил спам и заглушил автора»; a refused deletion has its own card. */
async function steamedCard(ctx: Ctx, flow: Flow): Promise<StepResult> {
  if ((await opStatus(ctx, flow.chatId, `${flow.key}:delete`)) === 'completed') await card(ctx, flow, 'steamed', { done: undefined })
  return 'ok'
}

/** The steps of the steam room after the role check (section 3.6): delete, restrict, record, joke. */
export const STEAM_ACTION_STEPS: Step[] = [deleteStep, markDeleted, restrictStep, recordStep, sendStep]

export function registerSanctionFlows(): void {
  registerFlow('steam', [checkTarget, ...STEAM_ACTION_STEPS, steamedCard])
  registerFlow('spam_delete', [checkTarget, deleteStep, markDeleted, reviewCardStep])
  registerFlow('ban', [banStillDue, banCall, banRecord])
  registerFlow('unban', [liftStep, unbanRecord])
  registerFlow('admin_ban', [async (ctx, flow) => banCall(ctx, flow), adminBanRecord])
  registerFlow('punish', [quietCheck, punishStep])
  registerFlow('unpunish', [unpunishStep])
}

// ---------------------------------------------------------------- creation helpers

export interface SpamFlowData {
  userId: number
  messageId: number
  name: string
  sentAt: string
  category: string
  spam: number | null
}

/** The joke, the explanation and the picture of a bath record, through the injected random source. */
export function jokePicks(rng: Ctx['rng']): { jokeIdx: number; explanationIdx: number; imageIdx: number } {
  const pick = (n: number): number => Math.min(n - 1, Math.floor(rng.next() * n))
  const set = loadJokes()
  return { jokeIdx: pick(set.replies.length), explanationIdx: pick(set.explanations.length), imageIdx: pick(set.images.length) }
}

export async function startSteam(q: Q, ctx: Pick<Ctx, 'rng'>, data: SpamFlowData & { chatId: number }, at: Date): Promise<void> {
  const { chatId } = data
  await createFlow(q, {
    chatId,
    kind: 'steam',
    key: `steam:${chatId}:${data.userId}:${data.messageId}`,
    data: { ...data, ...jokePicks(ctx.rng) },
    now: at,
  })
}

export async function startSpamDelete(q: Q, chatId: number, data: SpamFlowData & { noCard?: boolean }, at: Date): Promise<void> {
  await createFlow(q, {
    chatId,
    kind: 'spam_delete',
    key: `spamdel:${chatId}:${data.messageId}`,
    data: { ...data },
    now: at,
  })
}

export async function startUnban(q: Q, target: { chatId: number; userId: number; probation: boolean }, key: string, at: Date): Promise<void> {
  const { chatId, userId, probation } = target
  await createFlow(q, { chatId, kind: 'unban', key, data: { userId, probation }, now: at })
}

export async function scheduleDueBans(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now()
  const due = await ctx.db.query(
    `SELECT ban_id, chat_id, user_id FROM bans WHERE state = 'steam' AND steam_until <= $1 AND appeal_status IN ('none','rejected','review')`,
    [now],
  )
  for (const ban of due) {
    await createFlow(ctx.db, {
      chatId: ban.chat_id,
      kind: 'ban',
      key: `ban:${ban.ban_id}`,
      data: { userId: ban.user_id, banId: ban.ban_id },
      now,
    })
  }
  return due.length
}
