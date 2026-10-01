import type { Message } from 'grammy/types'
import { categoryOf } from './categories.js'
import { createCard, holdText } from './cards.js'
import { DAY_MS, type Ctx } from './ctx.js'
import type { Facts } from './jev/facts.js'
import type { Q } from './db.js'
import { createFlow, registerFlow, type Flow, type StepResult } from './flows.js'
import { getKarma } from './members.js'
import { execOp, type OpOutcome } from './ops.js'
import { withRetry } from './retry.js'
import type { SettingsView } from './settings/settings.js'
import { displayName, fromPerson, replyOf } from './members.js'

export function isReportCommand(msg: Message): boolean {
  const entity = msg.entities?.find((e) => e.type === 'bot_command' && e.offset === 0)
  if (!entity || !msg.text) return false
  return msg.text.slice(0, entity.length).split('@')[0].toLowerCase() === '/report'
}

interface Registered {
  reportId: number | null
  privileged: boolean
}

async function registerReport(q: Q, msg: Message, settings: SettingsView, now: Date): Promise<Registered> {
  const target = replyOf(msg)
  if (!target?.from || !fromPerson(target as Message)) return { reportId: null, privileged: false }
  const chatId = msg.chat.id
  const reporterId = msg.from!.id
  const since = new Date(now.getTime() - DAY_MS)
  const recent = await q.query('SELECT count(*)::int AS n FROM reports WHERE chat_id = $1 AND reporter_id = $2 AND created_at >= $3', [chatId, reporterId, since])
  const privileged = (await getKarma(q, chatId, reporterId)) >= settings.num('protect_threshold')
  if (recent[0].n >= settings.num('report_daily_limit')) return { reportId: null, privileged }
  const created = await q.query(
    `INSERT INTO reports (chat_id, target_message_id, target_user_id, reporter_id, privileged, status, created_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6) ON CONFLICT (chat_id, target_message_id) DO NOTHING RETURNING report_id`,
    [chatId, target.message_id, target.from.id, reporterId, privileged, now],
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
  await holdText(q, {
    chatId: msg.chat.id,
    messageId: target.message_id,
    authorId: target.from!.id,
    authorName: displayName(target.from!),
    text: target.text ?? target.caption ?? '',
    mediaKind: attachmentKind(target),
    reason: keep.reason,
    days: keep.days,
    now: keep.now,
  })
}

/** Registers a report inside the ingest transaction; everything that needs Telegram runs as a flow. */
export async function startReport(ctx: Ctx, q: Q, msg: Message, settings: SettingsView): Promise<void> {
  const now = ctx.clock.now()
  const chatId = msg.chat.id
  const target = replyOf(msg)
  const { reportId, privileged } = await registerReport(q, msg, settings, now)
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
      targetUserId: target?.from?.id ?? null,
      targetName: target?.from ? displayName(target.from) : null,
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

async function adminCheck(ctx: Ctx, flow: Flow): Promise<StepResult> {
  if (flow.data.rejected) return 'ok'
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
