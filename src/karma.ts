import { createCard } from './cards.js'
import { HOUR_MS } from './ctx.js'
import type { Q } from './db.js'
import { createFlow } from './flows.js'
import { streakBoost } from './formulas.js'
import { addKarma, type KarmaResult } from './ledger.js'
import { isChannelId, isObserving } from './members.js'
import type { SettingsView } from './settings/settings.js'
import { queueTag } from './tags.js'
import { previousWeekStart, weekKey, weekStart } from './time.js'

export interface Member {
  chatId: number
  userId: number
}

export interface AwardArgs {
  chatId: number
  userId: number
  delta: number
  reason: string
  source: string
  messageId?: number | null
  key: string
  now: Date
  settings: SettingsView
  /** Imports only add: amounts <= 0 are skipped and no punishment starts. */
  positiveOnly?: boolean
}

function punishLevel(karma: number, settings: SettingsView): number {
  if (karma <= settings.num('punish_mute_week_karma')) return 3
  if (karma <= settings.num('punish_mute_day_karma')) return 2
  if (karma <= settings.num('punish_media_karma')) return 1
  return 0
}

async function hasBanRecord(q: Q, chatId: number, userId: number): Promise<boolean> {
  return (await q.query('SELECT 1 FROM bans WHERE chat_id = $1 AND user_id = $2', [chatId, userId])).length > 0
}

async function startPunishment(q: Q, a: AwardArgs, level: number): Promise<void> {
  const hours = level === 3 ? a.settings.num('mute_week_hours') : level === 2 ? a.settings.num('mute_day_hours') : 0
  const until = hours > 0 ? new Date(a.now.getTime() + hours * HOUR_MS) : null
  const rows = await q.query('SELECT punish_level, mute_until FROM members WHERE chat_id = $1 AND user_id = $2', [a.chatId, a.userId])
  const previous = { level: rows[0]?.punish_level ?? 0, muteUntil: rows[0]?.mute_until ?? null }
  await q.query('UPDATE members SET punish_level = $3, mute_until = $4 WHERE chat_id = $1 AND user_id = $2', [a.chatId, a.userId, level, until])
  await createFlow(q, {
    chatId: a.chatId,
    kind: 'punish',
    key: `punish:${a.chatId}:${a.userId}:${a.key}`,
    data: { userId: a.userId, level, untilDate: until ? Math.floor(until.getTime() / 1000) : null, previous },
    now: a.now,
  })
}

async function endPunishment(q: Q, a: AwardArgs): Promise<void> {
  await q.query('UPDATE members SET punish_level = 0, mute_until = NULL WHERE chat_id = $1 AND user_id = $2', [a.chatId, a.userId])
  await createFlow(q, {
    chatId: a.chatId,
    kind: 'unpunish',
    key: `unpunish:${a.chatId}:${a.userId}:${a.key}`,
    data: { userId: a.userId },
    now: a.now,
  })
}

const PUNISHMENTS = ['', 'запрет ссылок, медиа и стикеров', 'мьют на 24 часа', 'мьют на 7 суток']

/**
 * Section 3.6.3: in observation mode a punishment is not applied and no card goes to admins; what would apply is kept for the
 * admin screen only. Leaving the zone needs no record: nothing was applied.
 */
async function punishmentSkipped(q: Q, a: AwardArgs, level: number): Promise<void> {
  if (level === 0) return
  const rows = await q.query('SELECT display_name FROM members WHERE chat_id = $1 AND user_id = $2', [a.chatId, a.userId])
  await createCard(q, {
    chatId: a.chatId,
    key: `punish_skipped:${a.chatId}:${a.userId}:${a.key}`,
    kind: 'punish_skipped',
    payload: { targetUserId: a.userId, targetName: rows[0]?.display_name, done: `ничего; после недели наблюдения было бы: ${PUNISHMENTS[level]}` },
    now: a.now,
    screenOnly: true,
  })
}

/**
 * Punishments apply at the moment karma crosses a threshold downwards; leaving the zone restores rights. A channel is never
 * punished for its karma (section 3.6.4).
 */
async function onCrossing(q: Q, a: AwardArgs, result: KarmaResult): Promise<void> {
  if (isChannelId(a.userId)) return
  const before = punishLevel(result.before, a.settings)
  const after = punishLevel(result.after, a.settings)
  if (before === after || (after > 0 && after < before)) return
  if (await isObserving(q, a.chatId, a.settings, a.now)) return punishmentSkipped(q, a, after)
  if (await hasBanRecord(q, a.chatId, a.userId)) return
  if (after > before) await startPunishment(q, a, after)
  else await endPunishment(q, a)
}

export async function award(q: Q, a: AwardArgs): Promise<KarmaResult> {
  if (a.positiveOnly && a.delta <= 0) return { applied: false, delta: 0, before: 0, after: 0 }
  const result = await addKarma(q, {
    chatId: a.chatId,
    userId: a.userId,
    delta: a.delta,
    reason: a.reason,
    source: a.source,
    messageId: a.messageId,
    key: a.key,
    now: a.now,
    lowerBound: a.settings.num('karma_lower_bound'),
  })
  if (result.applied && result.delta !== 0 && !a.positiveOnly) await onCrossing(q, a, result)
  if (result.applied && !a.positiveOnly) await queueTag(q, { chatId: a.chatId, userId: a.userId, key: a.key, karma: result.after, now: a.now, settings: a.settings })
  return result
}

export async function recordActivity(q: Q, member: Member, at: Date, timeZone: string): Promise<void> {
  const { chatId, userId } = member
  await q.query('INSERT INTO member_weeks (chat_id, user_id, week) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [
    chatId,
    userId,
    weekKey(at, timeZone),
  ])
  await q.query('UPDATE members SET last_active_at = GREATEST(COALESCE(last_active_at, $3), $3) WHERE chat_id = $1 AND user_id = $2', [
    chatId,
    userId,
    at,
  ])
}

export async function streakWeeks(q: Q, member: Member, at: Date, timeZone: string): Promise<number> {
  const { chatId, userId } = member
  const rows = await q.query<{ week: string }>('SELECT week FROM member_weeks WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  const weeks = new Set(rows.map((row) => row.week))
  let cursor = weekStart(at, timeZone)
  if (!weeks.has(weekKey(cursor, timeZone))) cursor = previousWeekStart(cursor, timeZone)
  let count = 0
  while (weeks.has(weekKey(cursor, timeZone))) {
    count++
    cursor = previousWeekStart(cursor, timeZone)
  }
  return count
}

export async function boostFor(q: Q, settings: SettingsView, member: Member, at: Date): Promise<number> {
  const weeks = await streakWeeks(q, member, at, settings.str('timezone'))
  return streakBoost(weeks, settings.num('streak_bonus_per_week'), settings.num('streak_bonus_max'))
}
