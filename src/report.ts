import type { Message } from 'grammy/types'
import { categoryOf } from './categories.js'
import { createCard, holdText } from './cards.js'
import { DAY_MS, type Ctx } from './ctx.js'
import type { Facts } from './jev/facts.js'
import type { Q } from './db.js'
import { createFlow, registerFlow, type Flow, type StepResult } from './flows.js'
import { authorOf, getKarma, isChannelId, replyOf, type Author } from './members.js'
import { isNewcomer, isSilent } from './jev/history.js'
import { execOp, type OpOutcome } from './ops.js'
import type { Rng } from './ports.js'
import { alreadySteamed, startSpamDelete, startSteam } from './sanctions.js'
import { withRetry } from './retry.js'
import type { SettingsView } from './settings/settings.js'

export function isReportCommand(msg: Message): boolean {
  const entity = msg.entities?.find((e) => e.type === 'bot_command' && e.offset === 0)
  if (!entity || !msg.text) return false
  return msg.text.slice(0, entity.length).split('@')[0].toLowerCase() === '/report'
}

interface Registered {
  reportId: number | null
  privileged: boolean
}

/** The command and the member who sent it: a person or a channel (section 3.6.4). */
export interface ReportCommand {
  msg: Message
  reporterId: number
}

/** Section 3.6.4: a message of a channel is a member's message and may be reported; other messages not by members may not. */
function targetAuthor(msg: Message): Author | null {
  const target = replyOf(msg)
  return target ? authorOf(target as Message) : null
}

async function registerReport(q: Q, cmd: ReportCommand, settings: SettingsView, now: Date): Promise<Registered> {
  const { msg, reporterId } = cmd
  const target = replyOf(msg)
  const author = targetAuthor(msg)
  if (!target || !author) return { reportId: null, privileged: false }
  const chatId = msg.chat.id
  const since = new Date(now.getTime() - DAY_MS)
  const recent = await q.query('SELECT count(*)::int AS n FROM reports WHERE chat_id = $1 AND reporter_id = $2 AND created_at >= $3', [chatId, reporterId, since])
  const privileged = (await getKarma(q, chatId, reporterId)) >= settings.num('protect_threshold')
  if (recent[0].n >= settings.num('report_daily_limit')) return { reportId: null, privileged }
  const created = await q.query(
    `INSERT INTO reports (chat_id, target_message_id, target_user_id, reporter_id, privileged, status, created_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6) ON CONFLICT (chat_id, target_message_id) DO NOTHING RETURNING report_id`,
    [chatId, target.message_id, author.id, reporterId, privileged, now],
  )
  return { reportId: created[0]?.report_id ?? null, privileged }
}

const ATTACHMENTS = ['photo', 'video', 'animation', 'sticker', 'video_note', 'voice', 'audio', 'document'] as const

/** The kind of attachment, for a card about a message without text (section 3.6.1). An animation also carries `document`. */
export function attachmentKind(msg: Message): string | null {
  return ATTACHMENTS.find((kind) => msg[kind] !== undefined) ?? null
}

/** Keeps the text of the message a command answers, by the rule for deleted spam (section 3.10). */
async function holdRepliedText(q: Q, msg: Message, keep: { reason: 'report'; days: number; now: Date }): Promise<void> {
  const target = replyOf(msg) as Message
  const author = authorOf(target) as Author
  await holdText(q, {
    chatId: msg.chat.id,
    messageId: target.message_id,
    authorId: author.id,
    authorName: author.name,
    text: target.text ?? target.caption ?? '',
    mediaKind: attachmentKind(target),
    reason: keep.reason,
    days: keep.days,
    now: keep.now,
  })
}

/** Registers a report inside the ingest transaction; everything that needs Telegram runs as a flow. */
export async function startReport(ctx: Ctx, q: Q, cmd: ReportCommand, settings: SettingsView): Promise<void> {
  const now = ctx.clock.now()
  const { msg } = cmd
  const chatId = msg.chat.id
  const target = replyOf(msg)
  const author = targetAuthor(msg)
  const { reportId, privileged } = await registerReport(q, cmd, settings, now)
  if (reportId !== null) await holdRepliedText(q, msg, { reason: 'report', days: settings.num('held_text_days'), now })
  await createFlow(q, {
    chatId,
    kind: 'report',
    key: `report:${chatId}:${msg.message_id}`,
    data: {
      commandMessageId: msg.message_id,
      commandSentAt: new Date(msg.date * 1000).toISOString(),
      rejected: reportId === null,
      reportId,
      privileged,
      targetMessageId: target?.message_id ?? null,
      targetUserId: author?.id ?? null,
      targetName: author?.name ?? null,
      targetSentAt: target ? new Date(target.date * 1000).toISOString() : null,
    },
    now,
  })
}

async function reject(ctx: Ctx, flow: Flow): Promise<void> {
  flow.data.rejected = true
  await ctx.db.query('UPDATE flows SET data = data || $2 WHERE flow_id = $1', [flow.flowId, JSON.stringify({ rejected: true })])
  if (flow.data.reportId) {
    await ctx.db.query(`UPDATE reports SET status = 'rejected' WHERE report_id = $1`, [flow.data.reportId])
    await ctx.db.query(`DELETE FROM held_texts WHERE chat_id = $1 AND message_id = $2 AND reason = 'report'`, [flow.chatId, flow.data.targetMessageId])
  }
}

/** A report on an admin is refused; a channel has no role in the group to check (section 3.6.4). */
async function adminCheck(ctx: Ctx, flow: Flow): Promise<StepResult> {
  if (flow.data.rejected || isChannelId(flow.data.targetUserId)) return 'ok'
  try {
    const member = await withRetry(ctx, () => ctx.tg.getChatMember(flow.chatId, flow.data.targetUserId))
    if (member.status === 'creator' || member.status === 'administrator') await reject(ctx, flow)
  } catch {
    await reject(ctx, flow)
  }
  return 'ok'
}

/** The deletion of a command message (/report, /spam) as a kept operation of its flow. */
export function deleteCommandMessage(ctx: Ctx, flow: Flow): Promise<OpOutcome> {
  return execOp(ctx, {
    chatId: flow.chatId,
    key: `${flow.key}:cmd`,
    kind: 'delete_message',
    payload: { messageId: flow.data.commandMessageId, sentAt: flow.data.commandSentAt },
  })
}

/** Section 3.6.3: observation mode keeps only karma punishments; a report works the same during the first week. */
async function deleteCommand(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const outcome = await deleteCommandMessage(ctx, flow)
  return outcome.status === 'pending' || outcome.status === 'running' ? 'wait' : 'ok'
}

async function deleteTarget(ctx: Ctx, flow: Flow): Promise<StepResult> {
  if (flow.data.rejected) return 'stop'
  if (!flow.data.privileged) return 'ok'
  const outcome = await execOp(ctx, {
    chatId: flow.chatId,
    key: `${flow.key}:target`,
    kind: 'delete_message',
    payload: { messageId: flow.data.targetMessageId, sentAt: flow.data.targetSentAt },
  })
  if (outcome.status === 'pending' || outcome.status === 'running') return 'wait'
  if (outcome.status === 'completed') {
    await ctx.db.query('UPDATE messages SET deleted = true, excerpt = NULL WHERE chat_id = $1 AND message_id = $2', [flow.chatId, flow.data.targetMessageId])
  }
  return 'ok'
}

/** What the bot did with the reported message: removed it at once for a privileged reporter, otherwise nothing yet. */
async function reportOutcome(ctx: Ctx, flow: Flow): Promise<{ done?: string }> {
  const d = flow.data
  if (!d.privileged) return {}
  const op = await ctx.db.query('SELECT status FROM operations WHERE chat_id = $1 AND idempotency_key = $2', [flow.chatId, `${flow.key}:target`])
  return { done: op[0]?.status === 'completed' ? 'удалил сообщение (право дозора)' : 'удалить сообщение не смог' }
}

/** Jev's view of the reported message, when it has been evaluated. */
async function targetScore(ctx: Ctx, flow: Flow): Promise<{ spam: number | null; category: string | null }> {
  const rows = await ctx.db.query('SELECT facts FROM messages WHERE chat_id = $1 AND message_id = $2', [flow.chatId, flow.data.targetMessageId])
  const facts = rows[0]?.facts as Facts | null | undefined
  return facts ? { spam: facts.spam ?? null, category: categoryOf(facts) } : { spam: null, category: null }
}

async function reportCard(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const d = flow.data
  await createCard(ctx.db, {
    chatId: flow.chatId,
    key: `report:${d.reportId}`,
    kind: 'report',
    payload: {
      reportId: d.reportId,
      targetUserId: d.targetUserId,
      targetName: d.targetName,
      messageId: d.targetMessageId,
      privileged: d.privileged,
      ...(await targetScore(ctx, flow)),
      ...(await reportOutcome(ctx, flow)),
    },
    now: ctx.clock.now(),
  })
  const card = await ctx.db.query('SELECT card_id FROM admin_cards WHERE chat_id = $1 AND idempotency_key = $2', [flow.chatId, `report:${d.reportId}`])
  await ctx.db.query(`UPDATE reports SET status = 'open', card_id = $2 WHERE report_id = $1 AND status = 'pending'`, [d.reportId, card[0].card_id])
  return 'ok'
}

export function registerReportFlow(): void {
  registerFlow('report', [adminCheck, deleteCommand, deleteTarget, reportCard])
}

export interface ReactionFlag {
  chatId: number
  messageId: number
  flaggerId: number
  settings: SettingsView
  now: Date
  rng: Rng
}

interface FlaggedRow {
  author_id: number
  excerpt: string | null
  media_kind: string | null
  facts: Facts | null
  display_name: string
  karma: number
  probation_left: number
  posted_at: Date
}

/**
 * Section 3.7: the admins pressed «Спам» on every flagged newcomer with no karma, so such a member
 * goes to the steam room at once; one with karma, or past the first messages, still waits for the admins.
 */
async function steamsAtOnce(q: Q, f: ReactionFlag, row: FlaggedRow): Promise<boolean> {
  if (Number(row.karma) >= f.settings.num('report_steam_karma')) return false
  // Counted now, not up to the flagged message: an old early message of a long-time member does not make them a newcomer.
  const member = { chatId: f.chatId, userId: row.author_id, upTo: null }
  const limit = f.settings.num('spam_newcomer_messages')
  return row.probation_left > 0 || (await isNewcomer(q, member, limit)) || (await isSilent(q, member, limit))
}

async function steamFlagged(q: Q, f: ReactionFlag, row: FlaggedRow): Promise<void> {
  const text = { chatId: f.chatId, messageId: f.messageId, authorId: row.author_id, authorName: row.display_name, text: row.excerpt ?? '', mediaKind: row.media_kind ?? null }
  await holdText(q, { ...text, reason: 'spam', days: f.settings.num('held_text_days'), now: f.now })
  await q.query('UPDATE messages SET excerpt = NULL WHERE chat_id = $1 AND message_id = $2', [f.chatId, f.messageId])
  const data = {
    chatId: f.chatId,
    userId: row.author_id,
    messageId: f.messageId,
    name: row.display_name,
    sentAt: new Date(row.posted_at).toISOString(),
    category: (row.facts && categoryOf(row.facts)) ?? 'spam_other_offer',
    spam: row.facts?.spam ?? null,
    flagger: f.flaggerId,
  }
  if (await alreadySteamed(q, f.chatId, row.author_id)) await startSpamDelete(q, f.chatId, { ...data, noCard: true }, f.now)
  else await startSteam(q, { rng: f.rng }, data, f.now)
}

/**
 * Section 3.7: the report emoji on a message of a member sends a judged author with little karma to the steam room; anybody
 * else waits for the admins. Then the message is not touched and no karma moves: the admins get the card «Участник пожаловался:
 * похоже на спам, реши» with «Спам» and «Не спам», like the one the model raises. One card per message; a member may flag at
 * most `report_daily_limit` messages a day.
 */
export async function startFlagByReaction(q: Q, f: ReactionFlag): Promise<void> {
  const rows = await q.query<FlaggedRow>(
    `SELECT m.author_id, m.excerpt, m.media_kind, m.facts, m.posted_at, mem.display_name, mem.karma, mem.probation_left FROM messages m
     JOIN members mem ON mem.chat_id = m.chat_id AND mem.user_id = m.author_id WHERE m.chat_id = $1 AND m.message_id = $2 AND NOT m.deleted`,
    [f.chatId, f.messageId],
  )
  const row = rows[0]
  if (!row || row.author_id === f.flaggerId) return
  const since = new Date(f.now.getTime() - DAY_MS)
  // A flag that sent its author to the steam room counts towards the limit like a card does.
  const recent = await q.query(
    `SELECT (SELECT count(*) FROM admin_cards WHERE chat_id = $1 AND kind = 'flagged' AND payload->>'flagger' = $2 AND created_at >= $3)
          + (SELECT count(*) FROM flows WHERE chat_id = $1 AND kind IN ('steam', 'spam_delete') AND data->>'flagger' = $2 AND created_at >= $3) AS n`,
    [f.chatId, String(f.flaggerId), since],
  )
  if (Number(recent[0].n) >= f.settings.num('report_daily_limit')) return
  const key = `flag:${f.chatId}:${f.messageId}`
  const known = await q.query('SELECT 1 FROM admin_cards WHERE chat_id = $1 AND idempotency_key = $2', [f.chatId, key])
  if (known.length > 0) return
  if (await steamsAtOnce(q, f, row)) return steamFlagged(q, f, row)
  if (row.excerpt || row.media_kind) {
    await holdText(q, { chatId: f.chatId, messageId: f.messageId, authorId: row.author_id, authorName: row.display_name, text: row.excerpt ?? '', mediaKind: row.media_kind ?? null, reason: 'card', days: f.settings.num('held_text_days'), now: f.now })
  }
  const facts = row.facts
  await createCard(q, {
    chatId: f.chatId,
    key,
    kind: 'flagged',
    payload: { targetUserId: row.author_id, targetName: row.display_name, messageId: f.messageId, category: facts ? categoryOf(facts) : null, spam: facts?.spam ?? null, flagger: f.flaggerId },
    now: f.now,
  })
}
