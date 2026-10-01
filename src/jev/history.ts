import { DAY_MS } from '../ctx.js'
import type { Q } from '../db.js'

const FIRST_MESSAGE = 'first message of this sender in the chat'

export interface MessageRef {
  chatId: number
  userId: number
  messageId: number
}

/**
 * Section 3.6.0: `sender_history` of the Jev state. N is the number of the sender's earlier messages in this chat, imported ones
 * included; D is the number of whole days from the earliest of them to this message.
 */
export async function senderHistory(q: Q, ref: MessageRef, postedAt: Date): Promise<string> {
  const rows = await q.query<{ n: number; first: Date | null }>(
    'SELECT count(*)::int AS n, min(posted_at) AS first FROM messages WHERE chat_id = $1 AND author_id = $2 AND message_id < $3',
    [ref.chatId, ref.userId, ref.messageId],
  )
  const { n, first } = rows[0]
  return historyText(n, first === null ? null : new Date(first), postedAt)
}

/** The literal of section 3.6.0 for `n` earlier messages, the earliest at `first`. */
export function historyText(n: number, first: Date | null, postedAt: Date): string {
  if (n === 0 || first === null) return FIRST_MESSAGE
  const days = Math.max(0, Math.floor((postedAt.getTime() - first.getTime()) / DAY_MS))
  return `member of the chat, ${n} earlier messages over ${days} days`
}

/**
 * Section 3.6.0: a newcomer has at most `limit` messages in this chat, imported ones included; 0 makes everybody
 * one. For a new message the messages sent not later than it count (a delayed evaluation or messages that came right after
 * it change nothing); for an edit (`upTo` null) all the member's messages at the moment of the edit count.
 */
export async function isNewcomer(q: Q, member: { chatId: number; userId: number; upTo: number | null }, limit: number): Promise<boolean> {
  if (limit === 0) return true
  const rows = await q.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM messages WHERE chat_id = $1 AND author_id = $2 AND ($3::bigint IS NULL OR message_id <= $3)',
    [member.chatId, member.userId, member.upTo],
  )
  return rows[0].n <= limit
}
