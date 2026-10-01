import type { Q } from './db.js'
import { round4 } from './formulas.js'

export interface KarmaEventInput {
  chatId: number
  userId: number
  delta: number
  reason: string
  source: string
  messageId?: number | null
  key: string
  now: Date
  lowerBound: number
}

export interface KarmaResult {
  applied: boolean
  delta: number
  before: number
  after: number
}

/** Writes one journal event and the cached value in the same transaction. Idempotent by key. */
export async function addKarma(q: Q, input: KarmaEventInput): Promise<KarmaResult> {
  const rows = await q.query<{ karma: number }>('SELECT karma FROM members WHERE chat_id = $1 AND user_id = $2 FOR UPDATE', [
    input.chatId,
    input.userId,
  ])
  if (rows.length === 0) throw new Error(`member ${input.chatId}/${input.userId} does not exist`)
  const before = rows[0].karma
  const seen = await q.query('SELECT 1 FROM karma_events WHERE chat_id = $1 AND idempotency_key = $2', [input.chatId, input.key])
  if (seen.length > 0) return { applied: false, delta: 0, before, after: before }
  let delta = round4(input.delta)
  if (delta < 0) delta = round4(Math.max(input.lowerBound, before + delta) - before)
  const after = round4(before + delta)
  await q.query(
    `INSERT INTO karma_events (chat_id, user_id, delta, reason, source, message_id, idempotency_key, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [input.chatId, input.userId, delta, input.reason, input.source, input.messageId ?? null, input.key, input.now],
  )
  await q.query('UPDATE members SET karma = $3 WHERE chat_id = $1 AND user_id = $2', [input.chatId, input.userId, after])
  if (input.messageId != null) {
    await q.query('UPDATE messages SET karma_sum = karma_sum + $3 WHERE chat_id = $1 AND message_id = $2', [
      input.chatId,
      input.messageId,
      delta,
    ])
  }
  return { applied: true, delta, before, after }
}
