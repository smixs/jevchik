import { renderCard, type CardKind, type CardPayload, type CardRow } from './card-text.js'
import type { Ctx } from './ctx.js'
import { DAY_MS, HELD_TEXT_MAX_DAYS } from './ctx.js'
import type { Q } from './db.js'
import { execOp, submitOpIn } from './ops.js'

export { LEFT_IN_CHAT, type CardKind, type CardPayload } from './card-text.js'

export interface NewCard {
  chatId: number
  key: string
  kind: CardKind
  payload: CardPayload
  now: Date
  /** A card born with its decision: the private answer after /spam (section 3.6.2). */
  decision?: string
  /** Kept for the admin screen only, never sent (section 3.6.3). */
  screenOnly?: boolean
}

export async function createCard(q: Q, card: NewCard): Promise<void> {
  await q.query(
    `INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, created_at, decision, status, delivery) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (chat_id, idempotency_key) DO NOTHING`,
    [card.chatId, card.key, card.kind, JSON.stringify(card.payload), card.now, card.decision ?? null, card.screenOnly ? 'resolved' : 'open', card.screenOnly ? 'screen' : 'pending'],
  )
}

export interface HeldText {
  chatId: number
  messageId: number
  authorId: number
  authorName: string
  /** Text or caption; empty for an attachment without a caption. */
  text: string
  mediaKind: string | null
  reason: 'spam' | 'report' | 'card'
  days: number
  now: Date
}

/**
 * Sections 3.6.1 and 3.10: the text of a deleted, reported or carded message, for fresh administrators only, until `days` pass,
 * and never longer than 30 days, even under a longer value stored before the schema limit.
 * A copy kept for a card gives way to a newer one (an edit, a deletion, a report); any other copy stays as it is.
 */
export async function holdText(q: Q, t: HeldText): Promise<void> {
  await q.query(
    `INSERT INTO held_texts (chat_id, message_id, author_id, author_name, text, media_kind, reason, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (chat_id, message_id) DO UPDATE SET author_name = EXCLUDED.author_name, text = EXCLUDED.text, media_kind = EXCLUDED.media_kind,
       reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at
     WHERE held_texts.reason = 'card'`,
    [t.chatId, t.messageId, t.authorId, t.authorName, t.text, t.mediaKind, t.reason, new Date(t.now.getTime() + Math.min(t.days, HELD_TEXT_MAX_DAYS) * DAY_MS), t.now],
  )
}

/** The admins of the chat, or the one admin the card is meant for. */
async function recipients(ctx: Ctx, card: CardRow): Promise<Array<{ user_id: number; is_bot: boolean }>> {
  if (card.payload.recipient != null) return [{ user_id: card.payload.recipient, is_bot: false }]
  try {
    return await ctx.tg.getChatAdministrators(card.chat_id)
  } catch (error) {
    ctx.log.warn('admins_unavailable', { chat_id: card.chat_id, error: String(error) })
    return []
  }
}

/**
 * A copy owned by its writer (the /spam command): written only when there is no copy yet, so that dropping it later never
 * touches a copy of a card or a report. `true` when this call wrote it.
 */
export async function holdOwnText(q: Q, t: HeldText): Promise<boolean> {
  const rows = await q.query(
    `INSERT INTO held_texts (chat_id, message_id, author_id, author_name, text, media_kind, reason, expires_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (chat_id, message_id) DO NOTHING RETURNING 1`,
    [t.chatId, t.messageId, t.authorId, t.authorName, t.text, t.mediaKind, t.reason, new Date(t.now.getTime() + Math.min(t.days, HELD_TEXT_MAX_DAYS) * DAY_MS), t.now],
  )
  return rows.length > 0
}

async function deliver(ctx: Ctx, card: CardRow): Promise<void> {
  const admins = await recipients(ctx, card)
  const { text, entities, buttons } = await renderCard(ctx.db, card, ctx.clock.now())
  let delivered = 0
  let waiting = false
  for (const admin of admins.filter((a) => !a.is_bot)) {
    const outcome = await execOp(ctx, {
      chatId: card.chat_id,
      key: `card:${card.card_id}:${admin.user_id}`,
      kind: 'send_message',
      payload: { to: admin.user_id, text, entities: entities.length > 0 ? entities : undefined, buttons, memberText: true },
    })
    if (outcome.status === 'completed') delivered++
    if (outcome.status === 'pending' || outcome.status === 'running') waiting = true
  }
  if (waiting && delivered === 0) return
  await ctx.db.query('UPDATE admin_cards SET delivery = $2, delivered_count = $3 WHERE card_id = $1', [
    card.card_id,
    delivered > 0 ? 'delivered' : 'undelivered',
    delivered,
  ])
}

/**
 * Sends open cards that have not been delivered yet; a card closed before delivery (for example by a migration) is never sent.
 * A card nobody could receive stays visible on the admin screen.
 */
export async function deliverCards(ctx: Ctx): Promise<number> {
  const cards = await ctx.db.query<CardRow>(`SELECT * FROM admin_cards WHERE delivery = 'pending' AND status = 'open' ORDER BY card_id LIMIT 50`)
  for (const card of cards) await deliver(ctx, card)
  return cards.length
}

/**
 * Section 3.6.2: the card is edited for every admin who got it, with the decisions so far and the actions still allowed.
 * `tag` makes one edit per decision; a failed edit does not undo the decision (T-card-edit).
 */
export async function submitCardEdits(q: Q, card: CardRow, now: Date, tag: string): Promise<void> {
  const { text, entities, buttons } = await renderCard(q, card, now)
  const sent = await q.query(
    `SELECT payload->>'to' AS recipient, result->>'message_id' AS message_id FROM operations
     WHERE chat_id = $1 AND idempotency_key LIKE $2 AND status = 'completed' AND result ? 'message_id' ORDER BY operation_id`,
    [card.chat_id, `card:${card.card_id}:%`],
  )
  for (const row of sent) {
    await submitOpIn(q, now, {
      chatId: card.chat_id,
      key: `cardedit:${card.card_id}:${row.recipient}:${tag}`,
      kind: 'edit_message',
      payload: { to: Number(row.recipient), messageId: Number(row.message_id), text, entities: entities.length > 0 ? entities : undefined, buttons, memberText: true },
    })
  }
}
