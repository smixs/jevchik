import type { Ctx } from './ctx.js'
import type { Row } from './db.js'
import { DAY_MS, HELD_TEXT_MAX_DAYS, HOUR_MS } from './ctx.js'
import { createFlow } from './flows.js'
import { decayStep, round4 } from './formulas.js'
import { award } from './karma.js'
import { removeFile } from './import.js'
import { isObserving } from './members.js'
import { expireMemberTextOps, submitOpIn } from './ops.js'
import { getSettings } from './settings/settings.js'
import { maskName } from './text.js'
import { localHour, previousWeekStart, weekKey, weekStart } from './time.js'

async function chatIds(ctx: Ctx): Promise<number[]> {
  return (await ctx.db.query('SELECT chat_id FROM chats ORDER BY chat_id')).map((row) => row.chat_id as number)
}

// ------------------------------------------------------------------ decay

async function decayMember(ctx: Ctx, chatId: number, userId: number, lastActive: Date): Promise<void> {
  const now = ctx.clock.now()
  const settings = await getSettings(ctx.db, chatId)
  const periodMs = settings.num('decay_period_days') * DAY_MS
  const start = lastActive.getTime() + settings.num('silence_days') * DAY_MS
  const periods = Math.floor((now.getTime() - start) / periodMs)
  for (let i = 1; i <= periods; i++) {
    await ctx.db.tx(async (q) => {
      const rows = await q.query('SELECT karma FROM members WHERE chat_id = $1 AND user_id = $2 FOR UPDATE', [chatId, userId])
      const old = rows[0].karma as number
      const next = decayStep(old, settings.num('karma_lower_bound'), settings.num('decay_rate'))
      const delta = round4(next - old)
      if (Math.abs(delta) < 0.0001) return
      await award(q, { chatId, userId, delta, reason: 'decay', source: 'decay', key: `decay:${userId}:${lastActive.getTime()}:${i}`, now, settings })
    })
  }
}

/** Every full period of inactivity after the silence term takes a share of karma; keys make reruns harmless. */
export async function runDecay(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now()
  for (const chatId of await chatIds(ctx)) {
    const settings = await getSettings(ctx.db, chatId)
    const horizon = new Date(now.getTime() - (settings.num('silence_days') + settings.num('decay_period_days')) * DAY_MS)
    const members = await ctx.db.query(
      'SELECT user_id, last_active_at FROM members WHERE chat_id = $1 AND last_active_at IS NOT NULL AND last_active_at <= $2 AND is_bot = false',
      [chatId, horizon],
    )
    for (const m of members) await decayMember(ctx, chatId, m.user_id, new Date(m.last_active_at))
  }
}

// ------------------------------------------------------------------ mute expiry

export async function runMuteExpiry(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now()
  const due = await ctx.db.query('SELECT chat_id, user_id, karma, mute_until FROM members WHERE mute_until IS NOT NULL AND mute_until <= $1', [now])
  for (const m of due) {
    const settings = await getSettings(ctx.db, m.chat_id)
    const still = m.karma <= settings.num('punish_media_karma')
    const until = new Date(m.mute_until).getTime()
    await ctx.db.tx(async (q) => {
      await q.query('UPDATE members SET mute_until = NULL, punish_level = $3 WHERE chat_id = $1 AND user_id = $2', [m.chat_id, m.user_id, still ? 1 : 0])
      await createFlow(q, {
        chatId: m.chat_id,
        kind: still ? 'punish' : 'unpunish',
        key: `unmute:${m.user_id}:${until}`,
        data: { userId: m.user_id, level: 1, untilDate: null },
        now,
      })
    })
  }
}

// ------------------------------------------------------------------ weekly digest

function chatLink(ctx: Ctx, chatId: number): string {
  return `https://t.me/${ctx.env.botUsername}?startapp=lb_${chatId}`
}

function shownName(row: Row): string {
  return row.hidden ? maskName(row.display_name) : row.display_name
}

async function digestText(ctx: Ctx, chatId: number, from: Date, to: Date): Promise<string> {
  const leaders = await ctx.db.query(
    `SELECT m.display_name, m.hidden, sum(e.delta) AS gain FROM karma_events e JOIN members m ON m.chat_id = e.chat_id AND m.user_id = e.user_id
     WHERE e.chat_id = $1 AND e.created_at >= $2 AND e.created_at < $3 GROUP BY m.display_name, m.hidden, e.user_id HAVING sum(e.delta) > 0
     ORDER BY gain DESC, e.user_id LIMIT 3`,
    [chatId, from, to],
  )
  const best = await ctx.db.query(
    `SELECT m.message_id, m.excerpt, mem.display_name, mem.hidden FROM messages m JOIN members mem ON mem.chat_id = m.chat_id AND mem.user_id = m.author_id
     WHERE m.chat_id = $1 AND m.is_answer AND m.posted_at >= $2 AND m.posted_at < $3 AND NOT m.deleted
     ORDER BY GREATEST(m.karma_sum, 0) DESC, m.reply_count DESC, m.message_id DESC LIMIT 1`,
    [chatId, from, to],
  )
  const banned = await ctx.db.query('SELECT count(*)::int AS n FROM bans WHERE chat_id = $1 AND created_at >= $2 AND created_at < $3', [chatId, from, to])
  const lines = ['Итоги недели', '']
  if (leaders.length === 0) lines.push('Лидеров недели нет.')
  else lines.push('Лидеры:')
  leaders.forEach((row, i) => lines.push(`${i + 1}. ${shownName(row)}: +${Number(row.gain).toFixed(1)}`))
  if (best[0]) lines.push('', `Лучший ответ: ${shownName(best[0])}${best[0].excerpt && !best[0].hidden ? ` - ${best[0].excerpt}` : ''}`)
  lines.push('', `Отправлено в баню: ${banned[0].n}`)
  return lines.join('\n')
}

export async function runDigest(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now()
  for (const chatId of await chatIds(ctx)) {
    const settings = await getSettings(ctx.db, chatId)
    if (!settings.bool('digest_enabled') || (await isObserving(ctx.db, chatId, settings, now))) continue
    const tz = settings.str('timezone')
    if (localHour(now, tz) < settings.num('digest_hour')) continue
    const thisWeek = weekStart(now, tz)
    const prev = previousWeekStart(thisWeek, tz)
    const key = `digest:${weekKey(prev, tz)}`
    if (await digestDone(ctx, chatId, key, thisWeek)) continue
    const text = await digestText(ctx, chatId, prev, thisWeek)
    await ctx.db.tx(async (q) => {
      const fresh = await q.query('INSERT INTO job_runs (job, period, subject, ran_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1', ['digest', key, String(chatId), now])
      if (fresh.length === 0) return
      await submitOpIn(q, now, { chatId, key, kind: 'send_message', payload: { text, buttons: [[{ text: 'Открыть в Mini App', url: chatLink(ctx, chatId) }]] } })
    })
  }
}

/** Done already, or the chat did not exist before this week: there is no previous week to report. */
async function digestDone(ctx: Ctx, chatId: number, key: string, thisWeek: Date): Promise<boolean> {
  const seen = await ctx.db.query('SELECT 1 FROM job_runs WHERE job = $1 AND period = $2 AND subject = $3', ['digest', key, String(chatId)])
  const born = await ctx.db.query('SELECT 1 FROM chats WHERE chat_id = $1 AND created_at >= $2', [chatId, thisWeek])
  return seen.length > 0 || born.length > 0
}

// ------------------------------------------------------------------ retention

export async function runRetention(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now()
  await ctx.db.query(
    `UPDATE evaluations SET request = NULL, status = CASE WHEN status IN ('pending','running') THEN 'unprocessed' ELSE status END
     WHERE created_at < $1 AND request IS NOT NULL`,
    [new Date(now.getTime() - 24 * HOUR_MS)],
  )
  for (const chatId of await chatIds(ctx)) {
    const settings = await getSettings(ctx.db, chatId)
    await ctx.db.query(
      `WITH ranked AS (
         SELECT message_id, row_number() OVER (PARTITION BY author_id ORDER BY GREATEST(karma_sum, 0) DESC, reply_count DESC, message_id DESC) AS rn
         FROM messages WHERE chat_id = $1 AND excerpt IS NOT NULL)
       UPDATE messages SET excerpt = NULL
       WHERE chat_id = $1 AND excerpt IS NOT NULL AND posted_at < $2 AND message_id IN (SELECT message_id FROM ranked WHERE rn > $3)`,
      [chatId, new Date(now.getTime() - settings.num('excerpt_days') * DAY_MS), settings.num('best_messages_limit')],
    )
  }
  await ctx.db.query('DELETE FROM held_texts WHERE expires_at <= $1 OR created_at <= $2', [now, new Date(now.getTime() - HELD_TEXT_MAX_DAYS * DAY_MS)])
  // The text a /spam command carries until the right of its sender is checked: never longer than 24 hours, nor past its flow.
  await ctx.db.query(`UPDATE flows SET data = data - 'pending' WHERE data ? 'pending' AND (status <> 'running' OR created_at <= $1)`, [new Date(now.getTime() - 24 * HOUR_MS)])
  await ctx.db.query(`UPDATE operations SET payload = payload - 'text' WHERE status IN ('completed','failed','outcome_unknown') AND payload ? 'text'`)
  await expireMemberTextOps(ctx)
  await ctx.db.query('DELETE FROM processed_updates WHERE received_at < $1', [new Date(now.getTime() - 7 * DAY_MS)])
  await ctx.db.query(`UPDATE import_jobs SET status = 'expired', finished_at = $2 WHERE status IN ('pending','running') AND created_at < $1`, [
    new Date(now.getTime() - 24 * HOUR_MS),
    now,
  ])
  const leftovers = await ctx.db.query(`SELECT job_id, file_path FROM import_jobs WHERE file_path IS NOT NULL AND status NOT IN ('pending','running')`)
  for (const job of leftovers) {
    if (await removeFile(job.file_path)) await ctx.db.query('UPDATE import_jobs SET file_path = NULL WHERE job_id = $1', [job.job_id])
  }
}
