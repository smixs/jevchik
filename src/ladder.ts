import { DAY_MS } from './ctx.js'
import type { Q } from './db.js'
import { messageFactor, pairFactor, voterWeight } from './formulas.js'
import { award, boostFor, type AwardArgs } from './karma.js'
import { getKarma } from './members.js'
import { pairCount } from './reactions.js'
import type { SettingsView } from './settings/settings.js'

export type Signal = 'reaction' | 'reply' | 'quote' | 'dialog' | 'thanks'

export const LADDER: Signal[] = ['reaction', 'reply', 'quote', 'dialog', 'thanks']

const BASE_KEY: Record<Signal, string> = {
  reaction: 'base_reaction',
  reply: 'base_reply',
  quote: 'base_quote',
  dialog: 'base_dialog',
  thanks: 'base_thanks',
}

export interface Candidates {
  mediaReply: boolean
  mediaFits: boolean
  rudeBlocked: boolean
  hasQuote: boolean
  dialog: boolean
  thanks: boolean
}

/** Only the most expensive confirmed signal of a link counts. */
export function pickSignal(c: Candidates): Signal | null {
  const found = new Set<Signal>()
  if (c.mediaReply) {
    if (c.mediaFits) found.add('reaction')
  } else if (!c.rudeBlocked) {
    found.add('reply')
    if (c.hasQuote) found.add('quote')
    if (c.dialog) found.add('dialog')
  }
  if (c.thanks) found.add('thanks')
  return [...LADDER].reverse().find((signal) => found.has(signal)) ?? null
}

export interface LinkArgs {
  chatId: number
  fromMessageId: number
  toMessageId: number
  actorId: number
  targetUserId: number
  signal: Signal | null
  gen: number
  now: Date
  postedAt: Date
  settings: SettingsView
  positiveOnly?: boolean
}

interface LinkRow {
  signal: Signal | null
  awarded: number
  factor: number
}

async function createFactor(q: Q, a: LinkArgs): Promise<number> {
  const target = await q.query('SELECT signal_count FROM messages WHERE chat_id = $1 AND message_id = $2', [a.chatId, a.toMessageId])
  const kPair = (await pairCount(q, { chatId: a.chatId, actorId: a.actorId, targetId: a.targetUserId }, new Date(a.postedAt.getTime() - 30 * DAY_MS), [a.fromMessageId, a.toMessageId])) + 1
  const voter = await getKarma(q, a.chatId, a.actorId)
  const boost = await boostFor(q, a.settings, { chatId: a.chatId, userId: a.targetUserId }, a.postedAt)
  return messageFactor((target[0]?.signal_count ?? 0) + 1) * pairFactor(kPair) * voterWeight(voter, a.settings.num('voter_scale')) * boost
}

async function loadLink(q: Q, a: LinkArgs): Promise<LinkRow | null> {
  const rows = await q.query<LinkRow>(
    'SELECT signal, awarded, factor FROM links WHERE chat_id = $1 AND from_message_id = $2 AND to_message_id = $3 FOR UPDATE',
    [a.chatId, a.fromMessageId, a.toMessageId],
  )
  return rows[0] ?? null
}

function awardBase(a: LinkArgs): Omit<AwardArgs, 'delta' | 'reason' | 'key'> {
  return { chatId: a.chatId, userId: a.targetUserId, messageId: a.toMessageId, now: a.now, settings: a.settings, source: 'ladder', positiveOnly: a.positiveOnly }
}

async function awardSignal(q: Q, a: LinkArgs, given: { signal: Signal; factor: number; key: string }): Promise<number> {
  const { signal, factor, key } = given
  const delta = a.settings.num(BASE_KEY[signal]) * factor
  if (a.positiveOnly && delta < 0) return 0
  return (await award(q, { ...awardBase(a), delta, reason: `ladder_${signal}`, key })).delta
}

async function saveLink(q: Q, a: LinkArgs, stored: { existed: boolean; awarded: number; factor: number }): Promise<void> {
  const { existed, awarded, factor } = stored
  if (!existed) {
    await q.query('UPDATE messages SET signal_count = signal_count + 1 WHERE chat_id = $1 AND message_id = $2', [a.chatId, a.toMessageId])
  }
  await q.query(
    `INSERT INTO links (chat_id, from_message_id, to_message_id, actor_id, target_user_id, signal, awarded, factor, gen, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (chat_id, from_message_id, to_message_id) DO UPDATE SET signal = $6, awarded = $7, gen = $9`,
    [a.chatId, a.fromMessageId, a.toMessageId, a.actorId, a.targetUserId, a.signal, awarded, factor, a.gen, a.now],
  )
}

/** Makes the stored signal of a link equal to the given one: compensating event, then a new accrual. */
function unchanged(row: LinkRow | null, a: LinkArgs): boolean {
  return row ? row.signal === a.signal : a.signal === null
}

async function undoPrevious(q: Q, a: LinkArgs, row: LinkRow | null, key: string): Promise<void> {
  if (!row || row.awarded === 0) return
  await award(q, { ...awardBase(a), delta: -row.awarded, reason: 'ladder_undo', key: `${key}:undo` })
}

export async function settleLink(q: Q, a: LinkArgs): Promise<void> {
  const row = await loadLink(q, a)
  if (unchanged(row, a)) return
  const key = `link:${a.fromMessageId}:${a.toMessageId}:${a.gen}`
  await undoPrevious(q, a, row, key)
  const factor = row ? row.factor : await createFactor(q, a)
  const awarded = a.signal === null ? 0 : await awardSignal(q, a, { signal: a.signal, factor, key })
  await saveLink(q, a, { existed: row !== null, awarded, factor })
}
