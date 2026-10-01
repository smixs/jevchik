import type { CallbackQuery } from 'grammy/types'
import { startAction, type Admin } from './card-actions.js'
import type { CardAction, CardRow } from './card-text.js'
import type { Ctx } from './ctx.js'
import { runFlowNow } from './flows.js'
import { award } from './karma.js'
import type { Q } from './db.js'
import { displayName } from './members.js'
import { submitOpIn } from './ops.js'
import { withRetry } from './retry.js'
import { getSettings } from './settings/settings.js'
import { TelegramError } from './ports.js'

const POPUP_LIMIT = 200

async function answer(ctx: Ctx, id: string, text: string): Promise<void> {
  await ctx.tg.answerCallbackQuery(id, text).catch(() => {})
}

async function isAdmin(ctx: Ctx, chatId: number, userId: number): Promise<boolean | null> {
  try {
    const member = await withRetry(ctx, () => ctx.tg.getChatMember(chatId, userId))
    return member.status === 'creator' || member.status === 'administrator'
  } catch (error) {
    if (error instanceof TelegramError && error.kind === 'client') return false
    return null
  }
}

async function confirmReport(ctx: Ctx, q: Q, card: CardRow): Promise<string> {
  const now = ctx.clock.now()
  const reportId = card.payload.reportId as number
  const rows = await q.query(
    `UPDATE reports SET status = 'confirmed' WHERE report_id = $1 AND status = 'open' RETURNING target_user_id, reporter_id, target_message_id, privileged`,
    [reportId],
  )
  if (rows.length === 0) return 'жалоба уже разобрана'
  const settings = await getSettings(q, card.chat_id)
  const r = rows[0]
  await award(q, { chatId: card.chat_id, userId: r.target_user_id, delta: settings.num('report_author_delta'), reason: 'report_confirmed', source: 'report', messageId: r.target_message_id, key: `report:${reportId}:author`, now, settings })
  await award(q, { chatId: card.chat_id, userId: r.reporter_id, delta: settings.num('report_reporter_delta'), reason: 'report_reward', source: 'report', key: `report:${reportId}:reporter`, now, settings })
  if (r.privileged) return 'жалоба подтверждена, карма начислена'
  await q.query('UPDATE messages SET deleted = true, excerpt = NULL WHERE chat_id = $1 AND message_id = $2', [card.chat_id, r.target_message_id])
  await submitOpIn(q, now, { chatId: card.chat_id, key: `report:${reportId}:delete`, kind: 'delete_message', payload: { messageId: r.target_message_id } })
  return 'жалоба подтверждена, карма начислена, сообщение удаляется'
}

async function returnReport(ctx: Ctx, q: Q, card: CardRow): Promise<string> {
  const reportId = card.payload.reportId as number
  const rows = await q.query(
    `UPDATE reports SET status = 'returned' WHERE report_id = $1 AND status = 'open' RETURNING target_message_id, privileged`,
    [reportId],
  )
  if (rows.length === 0) return 'жалоба уже разобрана'
  const held = await q.query('SELECT author_name, text FROM held_texts WHERE chat_id = $1 AND message_id = $2', [card.chat_id, rows[0].target_message_id])
  const publish = rows[0].privileged && held[0]
  if (publish) {
    await submitOpIn(q, ctx.clock.now(), { chatId: card.chat_id, key: `report:${reportId}:return`, kind: 'send_message', payload: { text: `${held[0].author_name}: ${held[0].text}`, memberText: true } })
  }
  await q.query('DELETE FROM held_texts WHERE chat_id = $1 AND message_id = $2', [card.chat_id, rows[0].target_message_id])
  return publish ? 'жалоба отклонена, сообщение возвращается в чат' : 'жалоба отклонена'
}

/** «Оставить» on a request to lift a sanction (section 3.6.5): the member sees the refusal in the Mini App. */
async function keepSanction(q: Q, card: CardRow): Promise<string> {
  await q.query(`UPDATE bans SET appeal_status = 'rejected' WHERE chat_id = $1 AND user_id = $2`, [card.chat_id, card.payload.targetUserId])
  return 'наказание оставлено в силе'
}

/** The buttons that only change the database: the report ones and «Не спам» on a message still in the chat. */
function noteAction(ctx: Ctx): (q: Q, card: CardRow, action: CardAction) => Promise<string> {
  return async (q, card, action) => {
    if (action === 'confirm') return confirmReport(ctx, q, card)
    if (action === 'return') return returnReport(ctx, q, card)
    if (action === 'keep') return keepSanction(q, card)
    return 'не спам, сообщение осталось в чате'
  }
}

function popup(summary: string): string {
  return (summary.charAt(0).toUpperCase() + summary.slice(1)).slice(0, POPUP_LIMIT)
}

/** Starts the action under the lock of the card, runs it at once and answers with its result (section 3.6.2). */
async function perform(ctx: Ctx, card: CardRow, action: string, admin: Admin): Promise<string> {
  const started = await ctx.db.tx((q) => startAction(ctx, q, { cardId: card.card_id, action, admin }, noteAction(ctx)))
  if ('refused' in started) return started.refused === 'busy' ? 'Уже выполняю предыдущее решение' : 'Кнопка устарела'
  const flow = await runFlowNow(ctx, card.chat_id, started.key)
  const summary = flow?.data.summary
  return typeof summary === 'string' ? popup(summary) : 'Принято, выполняю; итог появится в карточке'
}

/** Card buttons: only a fresh chat administrator may press them. */
export async function handleCallback(ctx: Ctx, callback: CallbackQuery): Promise<void> {
  const match = /^c:(\d+):(\w+)$/.exec(callback.data ?? '')
  if (!match) return answer(ctx, callback.id, 'Кнопка устарела')
  const rows = await ctx.db.query('SELECT * FROM admin_cards WHERE card_id = $1', [Number(match[1])])
  const card = rows[0] as (CardRow & { status: string }) | undefined
  if (!card || card.status !== 'open') return answer(ctx, callback.id, 'Кнопка устарела')
  const admin = await isAdmin(ctx, card.chat_id, callback.from.id)
  if (admin === null) return answer(ctx, callback.id, 'Попробуйте позже')
  if (!admin) return answer(ctx, callback.id, 'Только для админов чата')
  try {
    return answer(ctx, callback.id, await perform(ctx, card, match[2], { id: callback.from.id, name: displayName(callback.from) }))
  } catch (error) {
    ctx.log.error('callback_failed', { card_id: card.card_id, error: String(error).slice(0, 200) })
    return answer(ctx, callback.id, 'Попробуйте позже')
  }
}
