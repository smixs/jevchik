import { categoryTitle } from '../categories.js'
import type { Ctx } from '../ctx.js'
import { DAY_MS } from '../ctx.js'
import type { Q, Row } from '../db.js'
import { streakWeeks } from '../karma.js'
import { loadJokes } from '../sanctions.js'
import { getSettings } from '../settings/settings.js'
import { maskName } from '../text.js'

export type Period = 'week' | 'month' | 'all'

export function parsePeriod(value: string | undefined): Period {
  return value === 'week' || value === 'month' ? value : 'all'
}

export interface LeaderRow {
  place: number
  public_id: string
  name: string
  karma: number
  is_me: boolean
}

function publicName(row: Row): string {
  return row.hidden ? maskName(row.display_name) : row.display_name
}

export async function leaderboard(ctx: Ctx, chatId: number, period: Period, viewerId: number): Promise<{ rows: LeaderRow[]; me: { place: number; karma: number } | null }> {
  const days = period === 'week' ? 7 : 30
  const since = new Date(ctx.clock.now().getTime() - days * DAY_MS)
  const rows =
    period === 'all'
      ? await ctx.db.query(
          `SELECT public_id, display_name, hidden, user_id, karma AS gain FROM members WHERE chat_id = $1 AND is_bot = false AND karma <> 0 ORDER BY karma DESC, user_id LIMIT 100`,
          [chatId],
        )
      : await ctx.db.query(
          `SELECT m.public_id, m.display_name, m.hidden, m.user_id, s.gain FROM (
             SELECT user_id, sum(delta) AS gain FROM karma_events WHERE chat_id = $1 AND created_at >= $2 GROUP BY user_id HAVING sum(delta) <> 0) s
           JOIN members m ON m.chat_id = $1 AND m.user_id = s.user_id ORDER BY s.gain DESC, m.user_id LIMIT 100`,
          [chatId, since],
        )
  const board = rows.map((r, i) => ({ place: i + 1, public_id: r.public_id as string, name: publicName(r), karma: Number(r.gain), is_me: r.user_id === viewerId }))
  const mine = board.find((r) => r.is_me)
  return { rows: board, me: mine ? { place: mine.place, karma: mine.karma } : null }
}

function messageLink(chat: { chat_id: number; username: string | null }, messageId: number): string | null {
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`
  if (chat.chat_id < -1_000_000_000_000) return `https://t.me/c/${-chat.chat_id - 1_000_000_000_000}/${messageId}`
  return null
}

async function messageList(q: Q, chat: Row, userId: number, order: string): Promise<unknown[]> {
  const rows = await q.query(
    `SELECT message_id, excerpt, karma_sum, reply_count FROM messages
     WHERE chat_id = $1 AND author_id = $2 AND excerpt IS NOT NULL AND NOT deleted ORDER BY ${order} LIMIT 5`,
    [chat.chat_id, userId],
  )
  return rows.map((r) => ({ message_id: r.message_id, excerpt: r.excerpt, link: messageLink(chat as never, r.message_id), karma: Number(r.karma_sum), replies: r.reply_count }))
}

async function chart(q: Q, member: { chatId: number; userId: number; karma: number }, now: Date): Promise<Array<{ date: string; karma: number }>> {
  const { chatId, userId, karma } = member
  const since = new Date(now.getTime() - 90 * DAY_MS)
  const rows = await q.query(
    `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, sum(delta) AS gain FROM karma_events
     WHERE chat_id = $1 AND user_id = $2 AND created_at >= $3 GROUP BY 1 ORDER BY 1`,
    [chatId, userId, since],
  )
  let running = karma - rows.reduce((s, r) => s + Number(r.gain), 0)
  return rows.map((r) => {
    running += Number(r.gain)
    return { date: r.day as string, karma: Math.round(running * 10000) / 10000 }
  })
}

export const EMPTY_PAGE = {
  empty: true,
  name: null,
  hidden: false,
  karma: 0,
  place: null,
  week_delta: 0,
  chart: [],
  thanks_count: 0,
  answers_count: 0,
  caught_spammers_count: 0,
  streak_weeks: 0,
  decay_warning: null,
  messages: { latest: [], top_upvoted: [], most_replied: [] },
}

async function counters(q: Q, chatId: number, userId: number): Promise<{ thanks: number; answers: number; caught: number }> {
  const rows = await q.query(
    `SELECT (SELECT count(*) FROM links WHERE chat_id = $1 AND target_user_id = $2 AND signal = 'thanks')::int AS thanks,
            (SELECT count(*) FROM messages WHERE chat_id = $1 AND author_id = $2 AND is_answer)::int AS answers,
            (SELECT count(DISTINCT target_user_id) FROM reports WHERE chat_id = $1 AND reporter_id = $2 AND status = 'confirmed')::int AS caught`,
    [chatId, userId],
  )
  return { thanks: rows[0].thanks, answers: rows[0].answers, caught: rows[0].caught }
}

export async function memberPage(ctx: Ctx, chatId: number, member: Row, viewerId: number): Promise<Record<string, unknown>> {
  const now = ctx.clock.now()
  const q = ctx.db
  const chat = (await q.query('SELECT chat_id, username FROM chats WHERE chat_id = $1', [chatId]))[0]
  const settings = await getSettings(q, chatId)
  const userId = member.user_id as number
  const karma = Number(member.karma)
  const place = (await q.query('SELECT count(*)::int AS n FROM members WHERE chat_id = $1 AND is_bot = false AND karma > $2', [chatId, karma]))[0].n + 1
  const week = (await q.query('SELECT COALESCE(sum(delta), 0) AS s FROM karma_events WHERE chat_id = $1 AND user_id = $2 AND created_at >= $3', [chatId, userId, new Date(now.getTime() - 7 * DAY_MS)]))[0].s
  const c = await counters(q, chatId, userId)
  const streak = await streakWeeks(q, { chatId, userId }, now, settings.str('timezone'))
  const start = member.last_active_at ? new Date(member.last_active_at).getTime() + settings.num('silence_days') * DAY_MS : null
  const daysLeft = start === null ? null : (start - now.getTime()) / DAY_MS
  return {
    empty: false,
    name: member.user_id === viewerId ? member.display_name : publicName(member),
    hidden: member.hidden,
    karma,
    place,
    week_delta: Number(week),
    chart: await chart(q, { chatId, userId, karma }, now),
    thanks_count: c.thanks,
    answers_count: c.answers,
    caught_spammers_count: c.caught,
    streak_weeks: streak,
    decay_warning: daysLeft !== null && daysLeft > 0 && daysLeft < 3 ? { starts_at: new Date(start!).toISOString(), days_left: Math.round(daysLeft * 100) / 100 } : null,
    messages: {
      latest: await messageList(q, chat, userId, 'posted_at DESC, message_id DESC'),
      top_upvoted: await messageList(q, chat, userId, 'karma_sum DESC, message_id DESC'),
      most_replied: await messageList(q, chat, userId, 'reply_count DESC, message_id DESC'),
    },
  }
}

export async function banList(ctx: Ctx, chatId: number): Promise<unknown[]> {
  const jokes = loadJokes()
  const rows = await ctx.db.query(
    `SELECT b.ban_id, b.category, b.explanation_idx, b.image_idx, b.state, b.created_at, m.display_name
     FROM bans b JOIN members m ON m.chat_id = b.chat_id AND m.user_id = b.user_id WHERE b.chat_id = $1 ORDER BY b.created_at DESC LIMIT 100`,
    [chatId],
  )
  return rows.map((r) => ({
    id: r.ban_id,
    name: maskName(r.display_name),
    category: r.category,
    category_title: categoryTitle(r.category as string),
    explanation: jokes.explanations[r.explanation_idx % jokes.explanations.length],
    image: `/ban-images/${jokes.images[r.image_idx % jokes.images.length]}`,
    state: r.state,
    date: new Date(r.created_at).toISOString(),
  }))
}
