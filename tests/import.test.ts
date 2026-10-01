import { readdirSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMPORT_MAX_BYTES, exportIdMatches, parseExport, startImport, windowOf } from '../src/import.js'
import { changeSetting } from '../src/settings/settings.js'
import { JevError } from '../src/ports.js'
import { ADMIN, ALICE, BOB, CHAT, DAY, botJoined, createHarness, eventsOf, karmaOf, message, pastObservation, restartHarness, type Harness } from './support/harness.js'
import { VECTORS } from './support/vectors.js'
import { HttpJevClient } from '../src/adapters/jev.js'
import { fakeServer, reply } from './support/http.js'
import { get, makeWeb, send } from './support/web.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  await h.send(botJoined())
})
afterEach(async () => {
  await h.close()
})

const EXPORT_ID = 1234567890
const iso = (daysAgo: number, extraMinutes = 0): string => new Date(h.clock.now().getTime() - daysAgo * DAY + extraMinutes * 60_000).toISOString()

interface Exported {
  id: number
  from: string
  from_id: string
  text: unknown
  date: string
  reply_to_message_id?: number
  reactions?: unknown[]
  type?: string
}

function build(messages: Exported[], id = EXPORT_ID): Buffer {
  const out = messages.map((m) => ({
    type: 'message',
    ...m,
    date_unixtime: String(Math.floor(Date.parse(m.date) / 1000)),
    date: m.date.replace('Z', ''),
  }))
  return Buffer.from(JSON.stringify({ name: 'Chat', type: 'private_supergroup', id, messages: out }))
}

const user = (n: number, name: string) => ({ from: name, from_id: `user${n}` })
const files = (): string[] => readdirSync(h.importDir)

async function runToEnd(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await h.app.settle()
    h.clock.advance(40_000)
  }
}

describe('parsing helpers', () => {
  it('matches the exported chat id to the selected chat', () => {
    expect(exportIdMatches(-1001234567890, 1234567890)).toBe(true)
    expect(exportIdMatches(-1001234567890, 1234567891)).toBe(false)
    expect(exportIdMatches(-4242, 4242)).toBe(true)
    expect(exportIdMatches(-1001234567890, -1001234567890)).toBe(true)
    expect(exportIdMatches(-1001234567890, 0)).toBe(false)
  })

  it('reads plain and rich text, keeps only user messages', () => {
    const parsed = parseExport(
      JSON.stringify({
        id: 1,
        messages: [
          { id: 1, type: 'message', date_unixtime: '1788264000', from: 'A', from_id: 'user7', text: 'plain' },
          { id: 2, type: 'message', date_unixtime: '1788264001', from: 'B', from_id: 'user8', text: ['see ', { type: 'link', text: 'https://x.y' }] },
          { id: 3, type: 'service', date_unixtime: '1788264002', actor: 'C', action: 'join' },
          { id: 4, type: 'message', date_unixtime: '1788264003', from: 'Chan', from_id: 'channel55', text: 'x' },
        ],
      }),
    )
    expect(parsed?.messages.map((m) => [m.id, m.authorId, m.text])).toEqual([[1, 7, 'plain'], [2, 8, 'see https://x.y']])
    expect(parseExport('not json')).toBeNull()
    expect(parseExport('{"id":"x"}')).toBeNull()
    expect(windowOf(parsed!.messages, new Date(1788264100 * 1000), 90)).toHaveLength(2)
  })
})

describe('F21: import of the history', () => {
  it('rejects a file that names another chat; nothing changes and no file stays', async () => {
    const body = build([{ id: 1, ...user(1, 'Alice'), text: 'привет', date: iso(1) }], 999)
    expect(await startImport(h.ctx, CHAT, ADMIN.id, body)).toEqual({ ok: false, error: 'wrong_chat' })
    await runToEnd()
    expect(files()).toEqual([])
    expect(await h.db.query('SELECT 1 FROM karma_events')).toEqual([])
    expect(h.jev.requests).toHaveLength(0)
    expect(await h.db.query('SELECT 1 FROM import_jobs')).toEqual([])
  })

  it('takes the last 90 days only, positives only, and deletes the file after counting', async () => {
    h.jev.script('подробный разбор', { usefulness: { score: 3, confidence: 0.6 } })
    h.jev.script('старый разбор', { usefulness: { score: 4, confidence: 0.9 } })
    h.jev.script('реклама заработка', { spam_earnings_crypto: 0.99, rude: 0.99, usefulness: { score: 0, confidence: 0.9 } })
    const body = build([
      { id: 1, ...user(1, 'Alice'), text: 'старый разбор', date: iso(91) },
      { id: 2, ...user(1, 'Alice'), text: 'подробный разбор', date: iso(3), reactions: [{ type: 'emoji', count: 3, emoji: '👍' }, { type: 'emoji', count: 5, emoji: '👎' }, { type: 'emoji', count: 2, emoji: '💩' }] },
      { id: 3, ...user(2, 'Bob'), text: 'реклама заработка', date: iso(2), reactions: [{ type: 'emoji', count: 4, emoji: '👎' }] },
      { id: 4, ...user(2, 'Bob'), text: 'да, спасибо', date: iso(2, 5), reply_to_message_id: 2 },
    ])
    const started = await startImport(h.ctx, CHAT, ADMIN.id, body)
    expect(started.ok).toBe(true)
    expect(files()).toHaveLength(1)
    await runToEnd()
    expect(h.jev.requests.map((r) => r.state.message).sort()).toEqual(['да, спасибо', 'подробный разбор', 'реклама заработка'])
    expect((await h.db.query('SELECT status FROM import_jobs'))[0].status).toBe('done')
    expect(files()).toEqual([])
    const alice = await eventsOf(h, ALICE.id)
    expect(alice.map((e) => e.reason)).toEqual(['jev_usefulness', 'reaction_plus', 'ladder_reply'].filter((r) => alice.some((e) => e.reason === r)))
    expect(alice.every((e) => e.delta > 0)).toBe(true)
    expect(alice.find((e) => e.reason === 'reaction_plus')).toBeTruthy()
    expect((await eventsOf(h, BOB.id)).length).toBe(0)
    expect(await karmaOf(h, BOB.id)).toBe(0)
    for (const method of ['deleteMessage', 'restrictChatMember', 'banChatMember', 'sendMessage', 'setMessageReaction']) {
      expect(h.tg.of(method).filter((c) => c.args[0] === CHAT)).toEqual([])
    }
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM admin_cards')).toEqual([])
  })

  it('the boundary of the window is import_days: 89 days in, 91 days out; the setting moves it', async () => {
    h.jev.defaultScript = { usefulness: { score: 3, confidence: 0.6 } }
    const rows = [
      { id: 1, ...user(1, 'Alice'), text: 'на границе внутри', date: iso(89.9) },
      { id: 2, ...user(1, 'Alice'), text: 'на границе снаружи', date: iso(90.1) },
      { id: 3, ...user(1, 'Alice'), text: 'сорок пять дней', date: iso(45) },
    ]
    await startImport(h.ctx, CHAT, ADMIN.id, build(rows))
    await runToEnd()
    expect(h.jev.requests.map((r) => r.state.message).sort()).toEqual(['на границе внутри', 'сорок пять дней'])
    await h.db.query('DELETE FROM evaluations')
    h.jev.requests.length = 0
    await changeSetting(h.db, { chatId: CHAT, key: 'import_days', value: 30, baseVersion: 0, actor: 1, now: h.clock.now() })
    await startImport(h.ctx, CHAT, ADMIN.id, build(rows))
    await runToEnd()
    expect(h.jev.requests).toHaveLength(0)
    expect((await h.db.query(`SELECT count(*)::int AS n FROM import_jobs`))[0].n).toBe(1)
  })

  it('a second upload of the same file does not double the karma', async () => {
    h.jev.script('подробный разбор', { usefulness: { score: 3, confidence: 0.6 } })
    const body = build([
      { id: 2, ...user(1, 'Alice'), text: 'подробный разбор', date: iso(3), reactions: [{ type: 'emoji', count: 2, emoji: '👍' }] },
      { id: 4, ...user(2, 'Bob'), text: 'ответ', date: iso(3, 5), reply_to_message_id: 2 },
    ])
    await startImport(h.ctx, CHAT, ADMIN.id, body)
    await runToEnd()
    const once = await karmaOf(h, ALICE.id)
    const eventCount = (await h.db.query('SELECT count(*)::int AS n FROM karma_events'))[0].n
    expect(once).toBeGreaterThan(0)
    await startImport(h.ctx, CHAT, ADMIN.id, body)
    await runToEnd()
    expect(await karmaOf(h, ALICE.id)).toBe(once)
    expect((await h.db.query('SELECT count(*)::int AS n FROM karma_events'))[0].n).toBe(eventCount)
    expect(files()).toEqual([])
  })

  it('the import does not change who is the first counted author, nor the observation start', async () => {
    const before = (await h.db.query('SELECT observation_started_at FROM chats'))[0].observation_started_at
    await startImport(h.ctx, CHAT, ADMIN.id, build([{ id: 2, ...user(1, 'Alice'), text: 'из истории', date: iso(3) }]))
    await runToEnd()
    expect((await h.db.query('SELECT first_message_id FROM members WHERE user_id = 1'))[0].first_message_id).toBeNull()
    expect((await h.db.query('SELECT observation_started_at FROM chats'))[0].observation_started_at).toEqual(before)
    await pastObservation(h)
    h.jev.script('живое сообщение', { spam_earnings_crypto: 0.95 })
    await h.send(message({ id: 5000, from: ALICE, text: 'живое сообщение' }))
    await h.app.settle()
    expect((await h.db.query('SELECT first_message_id FROM members WHERE user_id = 1'))[0].first_message_id).toBe(5000)
  })

  it('the imported reactions count through the counter rule: no pair factor, no voter weight', async () => {
    await startImport(h.ctx, CHAT, ADMIN.id, build([{ id: 2, ...user(1, 'Alice'), text: 'сообщение', date: iso(3), reactions: [{ type: 'emoji', count: 3, emoji: '👍' }] }]))
    await runToEnd()
    const reaction = (await eventsOf(h, ALICE.id)).find((e) => e.reason === 'reaction_plus')!
    const mf = (k: number): number => 1 / (1 + Math.log(k))
    expect(reaction.delta).toBeCloseTo((mf(1) + mf(2) + mf(3)) * 1.05, 3)
  })
})

describe('T-import-bad', () => {
  it('a file that is not JSON, too large, or empty for 90 days is rejected without side effects', async () => {
    expect(await startImport(h.ctx, CHAT, ADMIN.id, Buffer.from('<html>'))).toEqual({ ok: false, error: 'not_json' })
    expect(await startImport(h.ctx, CHAT, ADMIN.id, Buffer.alloc(IMPORT_MAX_BYTES + 1, 32))).toEqual({ ok: false, error: 'too_large' })
    expect(await startImport(h.ctx, CHAT, ADMIN.id, build([{ id: 1, ...user(1, 'Alice'), text: 'старое', date: iso(100) }]))).toEqual({ ok: false, error: 'empty' })
    expect(await startImport(h.ctx, CHAT, ADMIN.id, build([]))).toEqual({ ok: false, error: 'empty' })
    expect(files()).toEqual([])
    expect(await h.db.query('SELECT 1 FROM karma_events')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM import_jobs')).toEqual([])
  })

  it('a job that breaks midway deletes the file and ends as failed', async () => {
    await startImport(h.ctx, CHAT, ADMIN.id, build([{ id: 1, ...user(1, 'Alice'), text: 'привет', date: iso(1) }]))
    writeFileSync((await h.db.query('SELECT file_path FROM import_jobs'))[0].file_path, 'corrupted')
    await runToEnd()
    expect((await h.db.query('SELECT status FROM import_jobs'))[0].status).toBe('failed')
    expect(files()).toEqual([])
  })

  it('the API answers with an error code for each rejection and 413 for an oversized body', async () => {
    h.tg.members.set(ADMIN.id, 'administrator')
    const web = await makeWeb(h)
    const post = (raw: string | Buffer) => send(web, 'POST', '/api/admin/import', VECTORS.admin_admin, undefined, typeof raw === 'string' ? raw : new Uint8Array(raw))
    expect((await post('nope')).status).toBe(400)
    expect((await post(build([{ id: 1, ...user(1, 'Alice'), text: 'x', date: iso(1) }], 5))).status).toBe(422)
    const big = await web.request('/api/admin/import', { method: 'POST', headers: { authorization: `tma ${VECTORS.admin_admin}`, 'content-length': String(IMPORT_MAX_BYTES + 1) }, body: 'x' })
    expect(big.status).toBe(413)
    const ok = await post(build([{ id: 1, ...user(1, 'Alice'), text: 'привет', date: iso(1) }]))
    expect(ok.status).toBe(200)
    const status = await (await get(web, '/api/admin/import', VECTORS.admin_admin)).json()
    expect(status.job.status).toBe('pending')
    expect(files()).toHaveLength(1)
  })
})

describe('T-import-resume and T-import-race', () => {
  const messages = (): Exported[] =>
    [1, 2, 3, 4, 5, 6].map((n) => ({ id: n, ...user(n % 2 === 0 ? 2 : 1, n % 2 === 0 ? 'Bob' : 'Alice'), text: `разбор номер ${n}`, date: iso(5, n) }))

  async function control(): Promise<{ alice: number; bob: number; events: number }> {
    const c = await createHarness()
    await c.send(botJoined())
    for (let n = 1; n <= 6; n++) c.jev.script(`разбор номер ${n}`, { usefulness: { score: 3, confidence: 0.6 } })
    await startImport(c.ctx, CHAT, ADMIN.id, build(messages()))
    for (let i = 0; i < 4; i++) {
      await c.app.settle()
      c.clock.advance(40_000)
    }
    const result = { alice: await karmaOf(c, ALICE.id), bob: await karmaOf(c, BOB.id), events: (await c.db.query('SELECT count(*)::int AS n FROM karma_events'))[0].n }
    await c.close()
    return result
  }

  it('Jev going down midway leaves an unfinished job; after a restart it continues without double counting', async () => {
    for (let n = 1; n <= 6; n++) h.jev.script(`разбор номер ${n}`, { usefulness: { score: 3, confidence: 0.6 } })
    h.jev.failures.push(new Error('placeholder'))
    h.jev.failures.length = 0
    let calls = 0
    const original = h.jev.evaluate.bind(h.jev)
    h.jev.evaluate = async (request) => {
      calls++
      if (calls === 4) throw new JevError('transient', 'down')
      return original(request)
    }
    await startImport(h.ctx, CHAT, ADMIN.id, build(messages()))
    await h.app.settle()
    const job = (await h.db.query('SELECT status, cursor_index, total FROM import_jobs'))[0]
    expect(job.status).toBe('pending')
    expect(job.cursor_index).toBeLessThan(job.total)
    expect(files()).toHaveLength(1)
    const partial = await karmaOf(h, ALICE.id)
    h = await restartHarness(h)
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
    for (let n = 1; n <= 6; n++) h.jev.script(`разбор номер ${n}`, { usefulness: { score: 3, confidence: 0.6 } })
    h.clock.advance(40_000)
    await runToEnd()
    expect((await h.db.query('SELECT status FROM import_jobs'))[0].status).toBe('done')
    expect(files()).toEqual([])
    const expected = await control()
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(expected.alice, 4)
    expect(await karmaOf(h, BOB.id)).toBeCloseTo(expected.bob, 4)
    expect((await h.db.query('SELECT count(*)::int AS n FROM karma_events'))[0].n).toBe(expected.events)
    expect(partial).toBeLessThanOrEqual(expected.alice)
  })

  it('a job left "running" by a stopped process is picked up again', async () => {
    await startImport(h.ctx, CHAT, ADMIN.id, build(messages()))
    await h.db.query(`UPDATE import_jobs SET status = 'running'`)
    h = await restartHarness(h)
    await h.app.start()
    await runToEnd()
    expect((await h.db.query('SELECT status FROM import_jobs'))[0].status).toBe('done')
  })

  it('T-import-race: only one import per chat is active; the second is rejected and leaves no file', async () => {
    const [a, b] = await Promise.all([startImport(h.ctx, CHAT, ADMIN.id, build(messages())), startImport(h.ctx, CHAT, ADMIN.id, build(messages()))])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, error: 'busy' })
    expect(files()).toHaveLength(1)
    await runToEnd()
    expect(files()).toEqual([])
    expect((await startImport(h.ctx, CHAT, ADMIN.id, build(messages()))).ok).toBe(true)
  })

  it('an import for a chat the bot does not know fails cleanly', async () => {
    const other = -1009999999999
    await h.db.query(`INSERT INTO chats (chat_id, title, observation_started_at, created_at) VALUES ($1,'x',$2,$2)`, [other, h.clock.now()])
    await startImport(h.ctx, other, ADMIN.id, build(messages(), 9999999999))
    await h.db.query('DELETE FROM chats WHERE chat_id = $1', [other])
    await runToEnd()
    expect((await h.db.query('SELECT status, error FROM import_jobs'))[0]).toEqual({ status: 'failed', error: 'unknown_chat' })
    expect(files()).toEqual([])
  })
})

describe('an import request carries sender_history (section 3.6.0)', () => {
  it('counted over the sorted import and the messages of the author already in the chat, on the wire', async () => {
    const server = await fakeServer((_s, _i, res) => reply(res, 200, { answers: {} }))
    h.ctx.jev = new HttpJevClient('KEY-1', `${server.url}/v1/systemone`, 2000)
    await h.db.query(`INSERT INTO members (chat_id, user_id, display_name, created_at) VALUES ($1, 1, 'Alice', $2) ON CONFLICT DO NOTHING`, [CHAT, h.clock.now()])
    await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at) VALUES ($1, 1, 1, $2)`, [CHAT, iso(20)])
    const body = build([
      { id: 12, ...user(1, 'Alice'), text: 'третье', date: iso(2) },
      { id: 10, ...user(1, 'Alice'), text: 'первое', date: iso(5) },
      { id: 11, ...user(2, 'Bob'), text: 'второе', date: iso(4) },
    ])
    expect((await startImport(h.ctx, CHAT, ADMIN.id, body)).ok).toBe(true)
    await runToEnd()
    await server.close()
    const states = server.seen.map((seen) => JSON.parse(seen.body).state).sort((a, b) => a.message.localeCompare(b.message))
    expect(states.map((s) => [s.message, s.sender_history])).toEqual([
      ['второе', 'first message of this sender in the chat'],
      ['первое', 'member of the chat, 1 earlier messages over 15 days'],
      ['третье', 'member of the chat, 2 earlier messages over 18 days'],
    ])
    expect(states.find((s) => s.message === 'третье')).toEqual({
      message: 'третье',
      replied_to: null,
      previous_messages: ['Alice: первое', 'Bob: второе'],
      sender_history: 'member of the chat, 2 earlier messages over 18 days',
      media_description: null,
      sender_profile: null,
    })
  })
})
