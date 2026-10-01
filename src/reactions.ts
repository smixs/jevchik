import type { MessageReactionCountUpdated, MessageReactionUpdated, ReactionType } from 'grammy/types'
import { DAY_MS } from './ctx.js'
import type { Q } from './db.js'
import { messageFactor, reactionDelta, round4 } from './formulas.js'
import { award, boostFor } from './karma.js'
import { ensureChat, getKarma, upsertMember } from './members.js'
import type { SettingsView } from './settings/settings.js'

export type ReactionClass = 'plus' | 'minus' | 'ignore'

function reactionKey(reaction: ReactionType): string {
  if (reaction.type === 'emoji') return `emoji:${reaction.emoji}`
  if (reaction.type === 'custom_emoji') return `custom:${reaction.custom_emoji_id}`
  return 'paid'
}

export function classify(settings: SettingsView, key: string): ReactionClass {
  const plain = key.startsWith('emoji:') ? key.slice(6) : key
  if (settings.list('reactions_ignore').includes(plain)) return 'ignore'
  if (settings.list('reactions_minus').includes(plain)) return 'minus'
  return 'plus'
}

interface Target {
  authorId: number
  signalCount: number
}

async function findMessage(q: Q, chatId: number, messageId: number): Promise<Target | null> {
  const rows = await q.query('SELECT author_id, signal_count FROM messages WHERE chat_id = $1 AND message_id = $2', [chatId, messageId])
  return rows[0] ? { authorId: rows[0].author_id, signalCount: rows[0].signal_count } : null
}

export interface Pair {
  chatId: number
  actorId: number
  targetId: number
}

export async function pairCount(q: Q, pair: Pair, since: Date, skipLink?: [number, number]): Promise<number> {
  const { chatId, actorId, targetId } = pair
  const rows = await q.query(
    `SELECT (SELECT count(*) FROM reactions WHERE chat_id = $1 AND actor_kind = 'user' AND actor_id = $2 AND target_user_id = $3 AND created_at >= $4)
          + (SELECT count(*) FROM links WHERE chat_id = $1 AND actor_id = $2 AND target_user_id = $3 AND created_at >= $4
               AND NOT (from_message_id = $5 AND to_message_id = $6)) AS n`,
    [chatId, actorId, targetId, since, skipLink?.[0] ?? -1, skipLink?.[1] ?? -1],
  )
  return Number(rows[0].n)
}

interface ReactionCtx {
  q: Q
  settings: SettingsView
  chatId: number
  messageId: number
  actor: { kind: 'user' | 'chat'; id: number }
  target: Target
  now: Date
}

async function minusAllowed(rc: ReactionCtx, karma: number): Promise<boolean> {
  if (rc.actor.kind !== 'user') return false
  if (karma < rc.settings.num('minus_min_karma') || karma <= rc.settings.num('punish_media_karma')) return false
  const since = new Date(rc.now.getTime() - DAY_MS)
  const rows = await rc.q.query(
    `SELECT count(*)::int AS n FROM reactions WHERE chat_id = $1 AND actor_kind = 'user' AND actor_id = $2 AND awarded < 0 AND created_at >= $3`,
    [rc.chatId, rc.actor.id, since],
  )
  return rows[0].n < rc.settings.num('minus_daily_limit')
}

function eventKey(rc: ReactionCtx, type: string, suffix: string): string {
  return `react:${rc.messageId}:${rc.actor.kind}:${rc.actor.id}:${type}:${suffix}`
}

interface Existing {
  active: boolean
  cycle: number
  created_at: Date
}

async function newReactionDelta(rc: ReactionCtx, cls: ReactionClass, existing: Existing | undefined): Promise<number | null> {
  const voterKarma = rc.actor.kind === 'user' ? await getKarma(rc.q, rc.chatId, rc.actor.id) : 0
  if (cls === 'minus' && !(await minusAllowed(rc, voterKarma))) return null
  const since = new Date(rc.now.getTime() - 30 * DAY_MS)
  const own = existing && new Date(existing.created_at) >= since ? 1 : 0
  const kPair = (await pairCount(rc.q, { chatId: rc.chatId, actorId: rc.actor.id, targetId: rc.target.authorId }, since)) - own + 1
  const base = rc.settings.num(cls === 'minus' ? 'base_minus' : 'base_reaction')
  const delta = reactionDelta({ base, kMessage: rc.target.signalCount + 1, kPair, voterKarma, scale: rc.settings.num('voter_scale') })
  return delta > 0 ? delta * (await boostFor(rc.q, rc.settings, { chatId: rc.chatId, userId: rc.target.authorId }, rc.now)) : delta
}

/** Every add (also of a reaction that was taken off before) is counted by the rules and settings of the moment. */
async function addReaction(rc: ReactionCtx, type: string, cls: ReactionClass): Promise<void> {
  const existing = (
    await rc.q.query<Existing>(
      `SELECT active, cycle, created_at FROM reactions WHERE chat_id = $1 AND message_id = $2 AND actor_kind = $3 AND actor_id = $4 AND reaction_type = $5 FOR UPDATE`,
      [rc.chatId, rc.messageId, rc.actor.kind, rc.actor.id, type],
    )
  )[0]
  if (existing?.active) return
  const delta = await newReactionDelta(rc, cls, existing)
  if (delta === null) return
  const cycle = (existing?.cycle ?? 0) + 1
  const common = { chatId: rc.chatId, userId: rc.target.authorId, messageId: rc.messageId, now: rc.now, settings: rc.settings, source: 'reaction' }
  const result = await award(rc.q, { ...common, delta, reason: `reaction_${cls}`, key: eventKey(rc, type, `c${cycle}`) })
  await rc.q.query(
    `INSERT INTO reactions (chat_id, message_id, actor_kind, actor_id, reaction_type, target_user_id, active, awarded, cycle, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9)
     ON CONFLICT (chat_id, message_id, actor_kind, actor_id, reaction_type) DO UPDATE SET active = true, awarded = $7, cycle = $8, created_at = $9`,
    [rc.chatId, rc.messageId, rc.actor.kind, rc.actor.id, type, rc.target.authorId, result.delta, cycle, rc.now],
  )
  await rc.q.query('UPDATE messages SET signal_count = signal_count + 1 WHERE chat_id = $1 AND message_id = $2', [rc.chatId, rc.messageId])
  rc.target.signalCount++
}

async function removeReaction(rc: ReactionCtx, type: string): Promise<void> {
  const rows = await rc.q.query(
    `SELECT active, awarded, cycle FROM reactions WHERE chat_id = $1 AND message_id = $2 AND actor_kind = $3 AND actor_id = $4 AND reaction_type = $5 FOR UPDATE`,
    [rc.chatId, rc.messageId, rc.actor.kind, rc.actor.id, type],
  )
  if (!rows[0] || !rows[0].active) return
  await award(rc.q, {
    chatId: rc.chatId,
    userId: rc.target.authorId,
    messageId: rc.messageId,
    now: rc.now,
    settings: rc.settings,
    source: 'reaction',
    delta: -rows[0].awarded,
    reason: 'reaction_undo',
    key: eventKey(rc, type, `c${rows[0].cycle}:undo`),
  })
  await rc.q.query(
    `UPDATE reactions SET active = false WHERE chat_id = $1 AND message_id = $2 AND actor_kind = $3 AND actor_id = $4 AND reaction_type = $5`,
    [rc.chatId, rc.messageId, rc.actor.kind, rc.actor.id, type],
  )
}

function actorOf(update: MessageReactionUpdated, target: Target): { kind: 'user' | 'chat'; id: number } | null {
  if (update.user) return update.user.id === target.authorId ? null : { kind: 'user', id: update.user.id }
  return update.actor_chat ? { kind: 'chat', id: update.actor_chat.id } : null
}

export async function handleReaction(q: Q, settings: SettingsView, update: MessageReactionUpdated, now: Date): Promise<void> {
  const chatId = update.chat.id
  const target = await findMessage(q, chatId, update.message_id)
  if (!target) return
  const actor = actorOf(update, target)
  if (!actor) return
  if (update.user) await upsertMember(q, chatId, update.user, now)
  const rc: ReactionCtx = { q, settings, chatId, messageId: update.message_id, actor, target, now }
  const oldKeys = new Set(update.old_reaction.map(reactionKey))
  const newKeys = new Set(update.new_reaction.map(reactionKey))
  for (const type of oldKeys) if (!newKeys.has(type)) await removeReaction(rc, type)
  for (const type of newKeys) {
    const cls = classify(settings, type)
    if (!oldKeys.has(type) && cls !== 'ignore') await addReaction(rc, type, cls)
  }
}

interface CountArgs {
  q: Q
  settings: SettingsView
  chatId: number
  messageId: number
  target: Target
  now: Date
  date: Date
}

async function applyCount(a: CountArgs, type: string, count: number): Promise<void> {
  const rows = await a.q.query(
    'SELECT count, awarded, last_date FROM reaction_counts WHERE chat_id = $1 AND message_id = $2 AND reaction_type = $3 FOR UPDATE',
    [a.chatId, a.messageId, type],
  )
  const old = (rows[0] ?? { count: 0, awarded: 0, last_date: null }) as { count: number; awarded: number; last_date: Date | null }
  if (old.last_date && a.date < new Date(old.last_date)) return
  const cls = classify(a.settings, type)
  const diff = count - old.count
  let effective = 0
  if (diff !== 0 && cls !== 'ignore') effective = await countDelta(a, { type, cls, old, diff })
  await a.q.query(
    `INSERT INTO reaction_counts (chat_id, message_id, reaction_type, count, awarded, last_date) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (chat_id, message_id, reaction_type) DO UPDATE SET count = $4, awarded = reaction_counts.awarded + $5, last_date = $6`,
    [a.chatId, a.messageId, type, count, round4(effective), a.date],
  )
}

interface Change {
  type: string
  cls: ReactionClass
  old: { count: number; awarded: number }
  diff: number
}

async function countDelta(a: CountArgs, change: Change): Promise<number> {
  const { type, cls, old, diff } = change
  const key = `count:${a.messageId}:${type}:${old.count}>${old.count + diff}:${a.date.getTime()}`
  const common = { chatId: a.chatId, userId: a.target.authorId, messageId: a.messageId, now: a.now, settings: a.settings, source: 'reaction_count' }
  if (diff < 0) {
    const refund = old.count > 0 ? (old.awarded * -diff) / old.count : 0
    return (await award(a.q, { ...common, delta: -refund, reason: 'reaction_undo', key })).delta
  }
  const base = a.settings.num(cls === 'minus' ? 'base_minus' : 'base_reaction')
  let total = 0
  for (let i = 0; i < diff; i++) total += base * messageFactor(a.target.signalCount + 1 + i)
  if (total > 0) total *= await boostFor(a.q, a.settings, { chatId: a.chatId, userId: a.target.authorId }, a.now)
  a.target.signalCount += diff
  await a.q.query('UPDATE messages SET signal_count = signal_count + $3 WHERE chat_id = $1 AND message_id = $2', [a.chatId, a.messageId, diff])
  return (await award(a.q, { ...common, delta: total, reason: `reaction_${cls}`, key })).delta
}

export async function handleReactionCount(q: Q, settings: SettingsView, update: MessageReactionCountUpdated, now: Date): Promise<void> {
  const chatId = update.chat.id
  await ensureChat(q, update.chat, now)
  const target = await findMessage(q, chatId, update.message_id)
  if (!target) return
  const date = new Date(update.date * 1000)
  const counts = new Map(update.reactions.map((r) => [reactionKey(r.type), r.total_count]))
  const known = await q.query('SELECT reaction_type FROM reaction_counts WHERE chat_id = $1 AND message_id = $2', [chatId, update.message_id])
  for (const row of known) if (!counts.has(row.reaction_type)) counts.set(row.reaction_type, 0)
  const args: CountArgs = { q, settings, chatId, messageId: update.message_id, target, now, date }
  for (const [type, count] of counts) await applyCount(args, type, count)
}
