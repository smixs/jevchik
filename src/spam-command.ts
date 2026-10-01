import type { Message } from 'grammy/types'
import type { Ctx } from './ctx.js'
import type { Q } from './db.js'
import { decisionLine, summarize } from './card-actions.js'
import { createFlow, registerFlow, withReport, type Flow, type StepResult } from './flows.js'
import { authorOf, displayName, replyOf } from './members.js'
import { execOp } from './ops.js'
import { createCard, holdOwnText } from './cards.js'
import { attachmentKind, deleteCommandMessage } from './report.js'
import { withRetry } from './retry.js'
import { jokePicks, markFlow, roleUnknown, STEAM_ACTION_STEPS, targetRole } from './sanctions.js'
import { getSettings } from './settings/settings.js'

/** `/spam` or `/spam@<this bot>` at the start of the message; a command addressed to another bot is not ours. */
export function isSpamCommand(msg: Message, botUsername: string): boolean {
  const entity = msg.entities?.find((e) => e.type === 'bot_command' && e.offset === 0)
  if (!entity || !msg.text) return false
  const [name, bot] = msg.text.slice(0, entity.length).toLowerCase().split('@')
  return name === '/spam' && (bot === undefined || bot === botUsername.toLowerCase())
}

interface Target {
  messageId: number
  userId: number
  name: string
  sentAt: string
  /** A bot, or a message not written by a person (spec 3.6.0, v10): nobody the bot may sanction. */
  isBot: boolean
  /** Why such a target is refused, for the private message to the admin. */
  notPerson?: string
}

function notPersonReason(t: Message): string {
  return t.from?.is_bot && !t.sender_chat ? 'сообщение отправил бот' : 'сообщение отправлено не участником, а от имени канала или Telegram'
}

/** Who sent a message that no member wrote (a bot, Telegram, the group itself), for the refusal. */
function nobody(t: Message): { userId: number; name: string } {
  return { userId: t.from?.id ?? 0, name: t.from ? displayName(t.from) : (t.sender_chat?.title ?? 'chat') }
}

/** Section 3.6.4: a message of a channel is a member's message; the target is the channel. */
function targetOf(msg: Message): Target | null {
  const t = replyOf(msg) as Message | null
  if (!t) return null
  const author = authorOf(t)
  return {
    messageId: t.message_id,
    ...(author ? { userId: author.id, name: author.name } : nobody(t)),
    sentAt: new Date(t.date * 1000).toISOString(),
    isBot: author === null,
    notPerson: author ? undefined : notPersonReason(t),
  }
}

/**
 * The text of the target, carried by the command only until the right of the sender is checked (the first step): an accepted
 * command moves it to the kept texts, a refused one drops it (section 3.10).
 */
function pendingText(msg: Message, target: Target | null): Record<string, unknown> | null {
  const t = replyOf(msg)
  if (!t || !target || target.isBot) return null
  return { authorId: target.userId, authorName: target.name, text: t.text ?? t.caption ?? '', mediaKind: attachmentKind(t as Message) }
}

/** Section 3.6.0: registers the command inside the ingest transaction; everything that needs Telegram runs as a flow. */
export async function startSpamCommand(ctx: Ctx, q: Q, msg: Message): Promise<void> {
  // Sent on behalf of a chat (an anonymous admin, a channel): nobody to check, so no right; only the command is removed.
  const target = msg.sender_chat ? null : targetOf(msg)
  await createFlow(q, {
    chatId: msg.chat.id,
    kind: 'spam_command',
    key: `spamcmd:${msg.chat.id}:${msg.message_id}`,
    data: { senderId: msg.from!.id, senderName: displayName(msg.from!), commandMessageId: msg.message_id, commandSentAt: new Date(msg.date * 1000).toISOString(), target, pending: pendingText(msg, target) },
    now: ctx.clock.now(),
  })
}

/** A fresh answer from Telegram; an error gives no right. */
async function isChatAdmin(ctx: Ctx, chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await withRetry(ctx, () => ctx.tg.getChatMember(chatId, userId))
    return member.status === 'creator' || member.status === 'administrator'
  } catch {
    return false
  }
}

/**
 * One action per message, claimed together with the kept text: only the command that creates the action writes the text, so a
 * refused or repeated command never touches a copy that belongs to another command, a card or a report.
 */
async function claimAction(ctx: Ctx, flow: Flow): Promise<void> {
  const d = flow.data
  const t = d.target as Target
  const settings = await getSettings(ctx.db, flow.chatId, flow.settingsSeq)
  const now = ctx.clock.now()
  await ctx.db.tx(async (q) => {
    const created = await createFlow(q, {
      chatId: flow.chatId,
      kind: 'admin_spam',
      key: `adminspam:${flow.chatId}:${t.messageId}`,
      data: { userId: t.userId, messageId: t.messageId, name: t.name, sentAt: t.sentAt, category: 'admin', spam: null, isBot: t.isBot, notPerson: t.notPerson, adminId: d.senderId, adminName: d.senderName, ...jokePicks(ctx.rng) },
      now,
    })
    if (created && d.pending) {
      const p = d.pending as { authorId: number; authorName: string; text: string; mediaKind: string | null }
      const own = await holdOwnText(q, { chatId: flow.chatId, messageId: t.messageId, ...p, reason: 'spam', days: settings.num('held_text_days'), now })
      if (own) await q.query(`UPDATE flows SET data = data || '{"heldByCommand": true}' WHERE chat_id = $1 AND idempotency_key = $2`, [flow.chatId, `adminspam:${flow.chatId}:${t.messageId}`])
    }
    await q.query(`UPDATE flows SET data = data - 'pending' WHERE flow_id = $1`, [flow.flowId])
  })
}

async function senderCheck(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const d = flow.data
  if (d.target !== null && (await isChatAdmin(ctx, flow.chatId, d.senderId))) {
    await claimAction(ctx, flow)
    return 'ok'
  }
  await ctx.db.query(`UPDATE flows SET data = data - 'pending' WHERE flow_id = $1`, [flow.flowId])
  return 'ok'
}

async function deleteCommand(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const outcome = await deleteCommandMessage(ctx, flow)
  if (outcome.status === 'pending' || outcome.status === 'running') return 'wait'
  if (outcome.status === 'failed') await commandNotDeleted(ctx, flow)
  return 'ok'
}

/** Section 4, T-del-denied: a refused deletion of the command is shown to admins; the sanction does not depend on it. */
async function commandNotDeleted(ctx: Ctx, flow: Flow): Promise<void> {
  const d = flow.data
  await createCard(ctx.db, {
    chatId: flow.chatId,
    key: `delete_denied:${flow.key}`,
    kind: 'delete_denied',
    payload: { targetUserId: d.senderId, targetName: d.senderName, messageId: d.commandMessageId, done: 'удалить команду /spam не смог', noActions: true },
    now: ctx.clock.now(),
  })
}

/** The target may not be sanctioned: the admin who sent the command learns why, in private. */
async function refuse(ctx: Ctx, flow: Flow, reason: string): Promise<StepResult> {
  await markFlow(ctx, flow, { refused: true })
  const chat = await ctx.db.query('SELECT title FROM chats WHERE chat_id = $1', [flow.chatId])
  await execOp(ctx, {
    chatId: flow.chatId,
    key: `${flow.key}:refused`,
    kind: 'send_message',
    payload: { to: flow.data.adminId, text: `Команда /spam в чате «${chat[0]?.title ?? flow.chatId}» не выполнена: ${reason}.` },
  })
  return 'stop'
}

/**
 * An admin, the owner or a bot is never sanctioned; high karma gives no protection against an admin decision. A channel has
 * no role to check (section 3.6.4, `targetRole`).
 */
async function adminTarget(ctx: Ctx, flow: Flow): Promise<StepResult> {
  if (flow.data.isBot === true) return refuse(ctx, flow, flow.data.notPerson ?? 'сообщение отправил бот')
  const role = await targetRole(ctx, flow)
  if (role === 'admin') return refuse(ctx, flow, `${flow.data.name} - админ или владелец чата`)
  if (role === 'unknown') return roleUnknown(ctx, flow)
  await ctx.db.query('UPDATE messages SET excerpt = NULL WHERE chat_id = $1 AND message_id = $2', [flow.chatId, flow.data.messageId])
  return 'ok'
}

/** Section 3.6.2: the admin who sent /spam gets the result in private, with the button «Не спам, вернуть». */
/** a command refused for any reason (the target, an unknown role) drops the copy it made, never anybody else's. */
async function dropOwnCopy(ctx: Ctx, flow: Flow): Promise<void> {
  if (flow.data.heldByCommand !== true) return
  await ctx.db.query(`DELETE FROM held_texts WHERE chat_id = $1 AND message_id = $2 AND reason = 'spam'`, [flow.chatId, flow.data.messageId])
}

async function commandReport(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const d = flow.data
  if (d.refused === true || typeof d.halt === 'string') await dropOwnCopy(ctx, flow)
  if (d.refused === true) return 'ok'
  const decision = await decisionLine(ctx, flow.chatId, await summarize(ctx, flow), d.adminName)
  await createCard(ctx.db, {
    chatId: flow.chatId,
    key: `spam_command:${flow.key}`,
    kind: 'spam_command',
    payload: { targetUserId: d.userId, targetName: d.name, messageId: d.messageId, category: 'admin', recipient: d.adminId },
    now: ctx.clock.now(),
    decision,
  })
  return 'ok'
}

export function registerSpamCommandFlows(): void {
  registerFlow('spam_command', [senderCheck, deleteCommand])
  registerFlow('admin_spam', withReport([adminTarget, ...STEAM_ACTION_STEPS], commandReport))
}
