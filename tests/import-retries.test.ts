import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportIdMatches, startImport } from '../src/import.js'
import { runRetention } from '../src/scheduled.js'
import { changeSetting } from '../src/settings/settings.js'
import { JevError } from '../src/ports.js'
import { ADMIN, ALICE, BOB, CHAT, DAY, botJoined, createHarness, eventsOf, karmaOf, type Harness } from './support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  await h.send(botJoined())
})
afterEach(async () => {
  await h.close()
})

const iso = (daysAgo: number, minutes = 0): string => new Date(h.clock.now().getTime() - daysAgo * DAY + minutes * 60_000).toISOString()
interface Row { id: number; n: number; name: string; text: string; date: string; reply?: number; reactions?: unknown[] }
function build(rows: Row[], id = 1234567890): Buffer {
  return Buffer.from(
    JSON.stringify({
      id,
      messages: rows.map((r) => ({ id: r.id, type: 'message', from: r.name, from_id: `user${r.n}`, text: r.text, date_unixtime: String(Math.floor(Date.parse(r.date) / 1000)), reply_to_message_id: r.reply, reactions: r.reactions })),
    }),
  )
}
async function run(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await h.app.settle()
    h.clock.advance(40_000)
  }
}

describe('the chat id of the export', () => {
  it('a supergroup accepts only its own id and the id without the -100 prefix', () => {
    expect(exportIdMatches(-1001234567890, -1001234567890)).toBe(true)
    expect(exportIdMatches(-1001234567890, 1234567890)).toBe(true)
    expect(exportIdMatches(-1001234567890, 1001234567890)).toBe(false)
    expect(exportIdMatches(-1001234567890, -1234567890)).toBe(false)
    expect(exportIdMatches(-1001234567890, 1234567891)).toBe(false)
  })

  it('an ordinary group accepts its id and its modulus', () => {
    expect(exportIdMatches(-4242, -4242)).toBe(true)
    expect(exportIdMatches(-4242, 4242)).toBe(true)
    expect(exportIdMatches(-4242, 1000000004242)).toBe(false)
    expect(exportIdMatches(-4242, 4243)).toBe(false)
  })

  it('startImport refuses the wrong-but-similar id and leaves nothing behind', async () => {
    const body = build([{ id: 1, n: 1, name: 'Alice', text: 'привет', date: iso(1) }], 1001234567890)
    expect(await startImport(h.ctx, CHAT, ADMIN.id, body)).toEqual({ ok: false, error: 'wrong_chat' })
    expect(readdirSync(h.importDir)).toEqual([])
  })
})

describe('an import only adds, and never starts punishments', () => {
  it('negative or zero amounts are skipped, no punishment flows are created', async () => {
    let base = 0
    const set = async (key: string, value: unknown) => {
      base = (await h.db.query('SELECT max(version)::int AS v FROM chat_settings WHERE key = $1', [key]))[0].v ?? 0
      await changeSetting(h.db, { chatId: CHAT, key, value, baseVersion: base, actor: 1, now: h.clock.now() })
    }
    await set('usefulness_points', [-100, -100, -100, -100, -100])
    await set('base_reaction', -100)
    await set('base_reply', -100)
    await set('karma_lower_bound', -1000)
    h.jev.defaultScript = { usefulness: { score: 3, confidence: 0.9 } }
    const rows: Row[] = []
    for (let i = 1; i <= 6; i++) rows.push({ id: i, n: 1, name: 'Alice', text: `сообщение ${i}`, date: iso(3, i), reactions: [{ type: 'emoji', count: 5, emoji: '👍' }] })
    rows.push({ id: 10, n: 2, name: 'Bob', text: 'ответ', date: iso(3, 20), reply: 1 })
    await startImport(h.ctx, CHAT, ADMIN.id, build(rows))
    await run()
    expect((await h.db.query('SELECT status FROM import_jobs'))[0].status).toBe('done')
    expect(await karmaOf(h, ALICE.id)).toBe(0)
    expect(await karmaOf(h, BOB.id)).toBe(0)
    expect(await eventsOf(h, ALICE.id)).toEqual([])
    expect(await h.db.query(`SELECT 1 FROM flows WHERE kind IN ('punish','unpunish')`)).toEqual([])
    expect(h.tg.count('restrictChatMember')).toBe(0)
  })

  it('positive amounts still count', async () => {
    h.jev.defaultScript = { usefulness: { score: 3, confidence: 0.9 } }
    await startImport(h.ctx, CHAT, ADMIN.id, build([{ id: 1, n: 1, name: 'Alice', text: 'разбор', date: iso(3) }]))
    await run()
    expect(await karmaOf(h, ALICE.id)).toBeGreaterThan(0)
  })
})

describe('the file and the job', () => {
  it('the file is written before the job is published: an unwritable directory leaves no job', async () => {
    rmSync(h.importDir, { recursive: true, force: true })
    writeFileSync(h.importDir, 'not a directory')
    await expect(startImport(h.ctx, CHAT, ADMIN.id, build([{ id: 1, n: 1, name: 'Alice', text: 'привет', date: iso(1) }]))).rejects.toThrow()
    expect(await h.db.query('SELECT 1 FROM import_jobs')).toEqual([])
    rmSync(h.importDir, { force: true })
    mkdirSync(h.importDir)
  })

  it('a busy chat leaves no second file', async () => {
    const body = build([{ id: 1, n: 1, name: 'Alice', text: 'привет', date: iso(1) }])
    const results = await Promise.all([startImport(h.ctx, CHAT, ADMIN.id, body), startImport(h.ctx, CHAT, ADMIN.id, body)])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(readdirSync(h.importDir)).toHaveLength(1)
  })

  it('the path is kept while the deletion is unconfirmed, and the cleanup repeats it', async () => {
    await startImport(h.ctx, CHAT, ADMIN.id, build([{ id: 1, n: 1, name: 'Alice', text: 'привет', date: iso(1) }]))
    const path = (await h.db.query('SELECT file_path FROM import_jobs'))[0].file_path as string
    rmSync(path)
    mkdirSync(path)
    writeFileSync(`${path}/keep`, 'x')
    await run(3)
    let job = (await h.db.query('SELECT status, file_path FROM import_jobs'))[0]
    expect(job.status).toBe('failed')
    expect(job.file_path).toBe(path)
    rmSync(path, { recursive: true })
    writeFileSync(path, 'leftover export')
    await runRetention(h.ctx)
    job = (await h.db.query('SELECT status, file_path FROM import_jobs'))[0]
    expect(job.file_path).toBeNull()
    expect(readdirSync(h.importDir)).toEqual([])
  })
})

describe('a message is asked at most three times, and evaluated messages are not asked again', () => {
  it('a message that always fails is skipped as "not processed" and the import goes on', async () => {
    const asked: Record<string, number> = {}
    const original = h.jev.evaluate.bind(h.jev)
    h.jev.evaluate = async (request) => {
      const text = String(request.state.message)
      asked[text] = (asked[text] ?? 0) + 1
      if (text === 'сообщение 3') throw new JevError('transient', 'down')
      return original(request)
    }
    h.jev.defaultScript = { usefulness: { score: 3, confidence: 0.9 } }
    const rows: Row[] = [1, 2, 3, 4, 5].map((i) => ({ id: i, n: 1, name: 'Alice', text: `сообщение ${i}`, date: iso(3, i) }))
    await startImport(h.ctx, CHAT, ADMIN.id, build(rows))
    await run(12)
    expect((await h.db.query('SELECT status FROM import_jobs'))[0].status).toBe('done')
    expect(asked['сообщение 3']).toBe(3)
    for (const i of [1, 2, 4, 5]) expect(asked[`сообщение ${i}`], `message ${i}`).toBe(1)
    expect((await h.db.query(`SELECT status FROM evaluations WHERE message_id = 3`))[0].status).toBe('unprocessed')
    expect((await h.db.query(`SELECT count(*)::int AS n FROM evaluations WHERE status = 'done'`))[0].n).toBe(4)
  })

  it('a second upload does not ask again for the evaluated messages', async () => {
    h.jev.defaultScript = { usefulness: { score: 3, confidence: 0.9 } }
    const rows: Row[] = [1, 2, 3].map((i) => ({ id: i, n: 1, name: 'Alice', text: `сообщение ${i}`, date: iso(3, i) }))
    await startImport(h.ctx, CHAT, ADMIN.id, build(rows))
    await run()
    const before = h.jev.requests.length
    await startImport(h.ctx, CHAT, ADMIN.id, build(rows))
    await run()
    expect(h.jev.requests.length).toBe(before)
  })
})
