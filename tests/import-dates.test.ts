import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db.js'
import { startImport } from '../src/import.js'
import { leaderboard } from '../src/web/queries.js'
import { ADMIN, ALICE, BOB, CAROL, CHAT, DAY, T0, botJoined, createHarness, edited, message, reaction, type Harness } from './support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  await h.send(botJoined())
  h.jev.defaultScript = { usefulness: { score: 3, confidence: 0.9 } }
})
afterEach(async () => {
  await h.close()
})

const at = (daysAgo: number, minutes = 0): string => new Date(Date.parse(T0) - daysAgo * DAY + minutes * 60_000).toISOString()
const OLD = at(20)
const OLD_REPLY = at(20, 5)
const RECENT = at(2)

/** Alice and Carol wrote 20 days ago (Carol answered Alice), Bob 2 days ago. */
function history(): Buffer {
  const row = (id: number, n: number, name: string, date: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'message',
    from: name,
    from_id: `user${n}`,
    text: `сообщение ${id}`,
    date_unixtime: String(Math.floor(Date.parse(date) / 1000)),
    ...extra,
  })
  return Buffer.from(
    JSON.stringify({
      id: 1234567890,
      messages: [
        row(1, 1, 'Alice', OLD, { reactions: [{ type: 'emoji', count: 2, emoji: '👍' }] }),
        row(2, 3, 'Carol', OLD_REPLY, { reply_to_message_id: 1 }),
        row(3, 2, 'Bob', RECENT, { reactions: [{ type: 'emoji', count: 1, emoji: '👍' }] }),
      ],
    }),
  )
}

async function runImport(): Promise<void> {
  expect((await startImport(h.ctx, CHAT, ADMIN.id, history())).ok).toBe(true)
  await h.app.settle()
  expect((await h.db.query('SELECT status FROM import_jobs'))[0].status).toBe('done')
}

async function events(): Promise<Array<{ user_id: number; reason: string; message_id: number | null; created_at: string }>> {
  const rows = await h.db.query('SELECT user_id, reason, message_id, created_at FROM karma_events ORDER BY event_id')
  return rows.map((r) => ({ user_id: r.user_id, reason: r.reason, message_id: r.message_id, created_at: new Date(r.created_at).toISOString() }))
}

async function board(period: 'week' | 'month'): Promise<Array<{ name: string; karma: number }>> {
  return (await leaderboard(h.ctx, CHAT, period, 0)).rows.map((r) => ({ name: r.name, karma: r.karma }))
}

describe('an imported karma event is dated by its message', () => {
  it('Jev, ladder and reaction counter events carry the time of the source message; the week board shows only the last 7 days', async () => {
    await runImport()
    expect(await events()).toEqual([
      { user_id: 1, reason: 'jev_usefulness', message_id: 1, created_at: OLD },
      { user_id: 1, reason: 'reaction_plus', message_id: 1, created_at: OLD },
      { user_id: 3, reason: 'jev_usefulness', message_id: 2, created_at: OLD_REPLY },
      { user_id: 1, reason: 'ladder_reply', message_id: 1, created_at: OLD_REPLY },
      { user_id: 2, reason: 'jev_usefulness', message_id: 3, created_at: RECENT },
      { user_id: 2, reason: 'reaction_plus', message_id: 3, created_at: RECENT },
    ])
    expect(await board('week')).toEqual([{ name: 'Bob', karma: 1.3125 }])
    expect((await board('month')).map((r) => r.name)).toEqual(['Alice', 'Bob', 'Carol'])
  })
})

describe('migration 004 dates the events of an earlier import by their messages', () => {
  it('imported events get the time of their message; live events on imported messages and decay stay as they were', async () => {
    await runImport()
    h.clock.advance(DAY)
    await h.send(reaction({ message_id: 1, from: BOB, new: ['👍'] }))
    await h.send(message({ id: 7000, from: BOB, text: 'живой ответ', reply_to: { message_id: 1, from: ALICE }, date: h.clock.now().toISOString() }))
    await h.app.settle()
    // Live edits of imported messages: a new Jev generation for Alice's message, a thanks instead of a reply for Carol's answer.
    h.jev.script('правка Алисы', { usefulness: { score: 4, confidence: 0.9 } })
    h.jev.script('спасибо большое', { usefulness: { score: 3, confidence: 0.9 }, is_thanks: 0.9 })
    await h.send(edited({ id: 1, from: ALICE, text: 'правка Алисы', date: OLD, edit_date: h.clock.now().toISOString() }))
    await h.send(edited({ id: 2, from: CAROL, text: 'спасибо большое', date: OLD_REPLY, edit_date: h.clock.now().toISOString() }))
    await h.app.settle()
    await h.db.query(
      `INSERT INTO karma_events (chat_id, user_id, delta, reason, source, message_id, idempotency_key, created_at) VALUES ($1,$2,-0.5,'decay','decay',NULL,'decay:test',$3)`,
      [CHAT, ALICE.id, h.clock.now()],
    )
    const right = await events()
    const rightWeek = await board('week')
    expect(right.filter((e) => e.created_at === h.clock.now().toISOString()).map((e) => [e.user_id, e.reason, e.message_id])).toEqual([
      [1, 'reaction_plus', 1],
      [2, 'jev_usefulness', 7000],
      [1, 'ladder_reply', 1],
      [1, 'jev_undo', 1],
      [1, 'jev_usefulness', 1],
      [1, 'ladder_undo', 1],
      [1, 'ladder_thanks', 1],
      [1, 'decay', null],
    ])
    await h.db.query(`UPDATE karma_events SET created_at = $1 WHERE source IN ('import', 'jev', 'ladder') AND created_at < $1`, [T0])
    expect((await board('week')).map((r) => r.name)).toEqual(['Alice', 'Bob', 'Carol'])
    await h.db.query(`DELETE FROM schema_migrations WHERE name = '004_import_event_dates.sql'`)
    await migrate(h.db)
    expect(await events()).toEqual(right)
    expect(await board('week')).toEqual(rightWeek)
    expect(rightWeek.map((r) => r.name)).toEqual(['Alice', 'Bob'])
  })
})
