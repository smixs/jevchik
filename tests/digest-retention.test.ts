import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { submitOp } from '../src/ops.js'
import { runDigest, runRetention } from '../src/scheduled.js'
import { changeSetting } from '../src/settings/settings.js'
import { tgError } from './support/fakes.js'
import { ADMIN, ALICE, BOB, CAROL, CHAT, DAY, botJoined, createHarness, message, restartHarness, seedMember, type Harness } from './support/harness.js'
import { VECTORS } from './support/vectors.js'
import { get, makeWeb } from './support/web.js'

let h: Harness
const MONDAY = '2026-09-14T06:00:00Z'

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  await h.send(botJoined())
})
afterEach(async () => {
  await h.close()
})

async function seedWeek(): Promise<void> {
  await seedMember(h, ALICE)
  await seedMember(h, BOB)
  await seedMember(h, CAROL)
  const ev = (user: number, delta: number, at: string, key: string) =>
    h.db.query(`INSERT INTO karma_events (chat_id, user_id, delta, reason, source, idempotency_key, created_at) VALUES ($1,$2,$3,'seed','seed',$4,$5)`, [CHAT, user, delta, key, at])
  await ev(1, 5, '2026-09-08T10:00:00Z', 'e1')
  await ev(2, 3, '2026-09-10T10:00:00Z', 'e2')
  await ev(3, -1, '2026-09-10T11:00:00Z', 'e3')
  await ev(2, 9, '2026-09-06T18:59:00Z', 'before-week')
  await ev(1, 20, '2026-09-13T19:01:00Z', 'after-week')
  await h.db.query(
    `INSERT INTO messages (chat_id, message_id, author_id, posted_at, excerpt, karma_sum, is_answer) VALUES ($1,501,1,'2026-09-09T10:00:00Z','Разбор про Jev',5,true),($1,502,2,'2026-09-09T11:00:00Z','Вопрос',9,false)`,
    [CHAT],
  )
  await h.db.query(
    `INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at) VALUES ($1,3,'admin',0,0,0,'banned',$2,$2)`,
    [CHAT, '2026-09-11T10:00:00Z'],
  )
  h.clock.set(MONDAY)
}

const digestSends = () => h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)
const EXPECTED = ['Итоги недели', '', 'Лидеры:', '1. Alice: +5.0', '2. Bob: +3.0', '', 'Лучший ответ: Alice - Разбор про Jev', '', 'Отправлено в баню: 1'].join('\n')

describe('F22: the weekly digest', () => {
  it('one operation per chat week: leaders, best answer, bans, a URL button to the Mini App', async () => {
    await seedWeek()
    await h.app.settle()
    expect(digestSends().map((c) => [c.args[1], c.args[2]])).toEqual([
      [EXPECTED, [[{ text: 'Открыть в Mini App', url: 'https://t.me/jevchik_bot?startapp=lb_-1001234567890' }]]],
    ])
    for (let i = 0; i < 3; i++) {
      h.clock.advance(3_600_000)
      await h.app.settle()
    }
    expect(digestSends()).toHaveLength(1)
    expect((await h.db.query(`SELECT idempotency_key, status FROM operations WHERE operation_kind = 'send_message' AND chat_id = $1`, [CHAT]))).toEqual([{ idempotency_key: 'digest:2026-W37', status: 'completed' }])
  })

  it('the next calendar week creates the next operation', async () => {
    await seedWeek()
    await h.app.settle()
    await h.db.query(`INSERT INTO karma_events (chat_id, user_id, delta, reason, source, idempotency_key, created_at) VALUES ($1,2,4,'seed','seed','w38','2026-09-16T10:00:00Z')`, [CHAT])
    h.clock.set('2026-09-21T06:00:00Z')
    await h.app.settle()
    expect(digestSends()).toHaveLength(2)
    expect((await h.db.query(`SELECT idempotency_key FROM operations WHERE operation_kind = 'send_message' ORDER BY operation_id`)).map((r) => r.idempotency_key)).toEqual(['digest:2026-W37', 'digest:2026-W38'])
  })

  it('waits for the local digest hour (10:00 in the chat time zone)', async () => {
    await seedWeek()
    h.clock.set('2026-09-14T04:59:00Z')
    await h.app.settle()
    expect(digestSends()).toHaveLength(0)
    h.clock.set('2026-09-14T05:00:00Z')
    await h.app.settle()
    expect(digestSends()).toHaveLength(1)
  })

  it('is not sent in observation mode or when disabled; a quiet week still gets one with the ban count and the button', async () => {
    await seedWeek()
    await changeSetting(h.db, { chatId: CHAT, key: 'observation_until', value: '2026-09-30T00:00:00Z', baseVersion: 0, actor: 1, now: h.clock.now() })
    await h.app.settle()
    expect(digestSends()).toHaveLength(0)
    await changeSetting(h.db, { chatId: CHAT, key: 'observation_until', value: null, baseVersion: 1, actor: 1, now: h.clock.now() })
    await changeSetting(h.db, { chatId: CHAT, key: 'digest_enabled', value: false, baseVersion: 0, actor: 1, now: h.clock.now() })
    await h.app.settle()
    expect(digestSends()).toHaveLength(0)
    await changeSetting(h.db, { chatId: CHAT, key: 'digest_enabled', value: true, baseVersion: 1, actor: 1, now: h.clock.now() })
    h.clock.set('2026-10-05T06:00:00Z')
    await h.app.settle()
    expect(digestSends().map((c) => [c.args[1], c.args[2]])).toEqual([
      [['Итоги недели', '', 'Лидеров недели нет.', '', 'Отправлено в баню: 0'].join('\n'), [[{ text: 'Открыть в Mini App', url: 'https://t.me/jevchik_bot?startapp=lb_-1001234567890' }]]],
    ])
  })

  it('a participant who hid the page is masked in the digest and the excerpt is left out', async () => {
    await seedWeek()
    await h.db.query('UPDATE members SET hidden = true WHERE user_id = 1')
    await h.app.settle()
    expect(digestSends()[0].args[1]).toBe(['Итоги недели', '', 'Лидеры:', '1. A***: +5.0', '2. Bob: +3.0', '', 'Лучший ответ: A***', '', 'Отправлено в баню: 1'].join('\n'))
  })
})

describe('digest failures', () => {
  it('T-digest-before-send: the operation exists before the send; after a restart it is sent once', async () => {
    await seedWeek()
    await runDigest(h.ctx)
    expect(h.tg.count('sendMessage')).toBe(0)
    expect((await h.db.query(`SELECT status FROM operations WHERE idempotency_key = 'digest:2026-W37'`))[0].status).toBe('pending')
    h = await restartHarness(h, { start: MONDAY })
    await h.app.start()
    await h.app.settle()
    expect(digestSends()).toHaveLength(1)
  })

  it('T-digest-after-send: a process that died after the send leaves outcome_unknown and nobody repeats it', async () => {
    await seedWeek()
    await runDigest(h.ctx)
    await h.db.query(`UPDATE operations SET status = 'running', claimed_at = $1 WHERE idempotency_key = 'digest:2026-W37'`, [new Date(h.clock.now().getTime() - 10 * 60_000)])
    h = await restartHarness(h, { start: MONDAY })
    await h.app.start()
    await h.app.settle()
    expect(digestSends()).toHaveLength(0)
    expect((await h.db.query(`SELECT status FROM operations WHERE idempotency_key = 'digest:2026-W37'`))[0].status).toBe('outcome_unknown')
  })

  it('a running operation with a fresh lease is left alone', async () => {
    await seedWeek()
    await runDigest(h.ctx)
    await h.db.query(`UPDATE operations SET status = 'running', claimed_at = $1 WHERE idempotency_key = 'digest:2026-W37'`, [h.clock.now()])
    await h.app.start()
    expect((await h.db.query(`SELECT status FROM operations WHERE idempotency_key = 'digest:2026-W37'`))[0].status).toBe('running')
  })

  it('T-digest-unknown: a lost answer is outcome_unknown, never retried, visible to admins', async () => {
    await seedWeek()
    h.tg.fail('sendMessage', tgError.lost())
    for (let i = 0; i < 3; i++) {
      await h.app.settle()
      h.clock.advance(120_000)
    }
    expect(digestSends()).toHaveLength(1)
    h.tg.members.set(ADMIN.id, 'administrator')
    h.clock.set('2026-09-01T12:00:00Z')
    const web = await makeWeb(h)
    const ops = await (await get(web, '/api/admin/operations', VECTORS.admin_admin)).json()
    expect(ops.operations).toEqual([expect.objectContaining({ operation_kind: 'send_message', status: 'outcome_unknown', last_error_code: 'lost_response' })])
  })

  it('T-digest-race: two processes at once send one digest', async () => {
    await seedWeek()
    const other = await createHarness({ start: MONDAY, database: { db: h.db, drop: async () => {} } })
    await Promise.all([h.app.tick({ scheduled: true }), other.app.tick({ scheduled: true })])
    await h.app.settle()
    await other.app.settle()
    const total = h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT).length + other.tg.of('sendMessage').filter((c) => c.args[0] === CHAT).length
    expect(total).toBe(1)
    expect(await h.db.query(`SELECT 1 FROM operations WHERE idempotency_key = 'digest:2026-W37'`)).toHaveLength(1)
  })

  it('T-tg-429: a rate-limited send waits for retry_after and then goes through', async () => {
    await seedWeek()
    h.tg.fail('sendMessage', tgError.rate(30))
    await h.app.settle()
    expect(digestSends()).toHaveLength(1)
    h.clock.advance(29_000)
    await h.app.settle()
    expect(digestSends()).toHaveLength(1)
    h.clock.advance(2000)
    await h.app.settle()
    expect(digestSends()).toHaveLength(2)
    expect((await h.db.query(`SELECT status, attempt_count FROM operations WHERE idempotency_key = 'digest:2026-W37'`))[0]).toEqual({ status: 'completed', attempt_count: 2 })
  })

  it('T-tg-429: no more than 20 messages a minute go to one group; the rest wait in the queue', async () => {
    for (let i = 0; i < 25; i++) await submitOp(h.ctx, { chatId: CHAT, key: `bulk${i}`, kind: 'send_message', payload: { text: `m${i}` } })
    await h.app.settle()
    expect(digestSends()).toHaveLength(20)
    h.clock.advance(30_000)
    await h.app.settle()
    expect(digestSends()).toHaveLength(20)
    h.clock.advance(31_000)
    await h.app.settle()
    expect(digestSends()).toHaveLength(25)
    expect(digestSends().map((c) => c.args[1])).toEqual(Array.from({ length: 25 }, (_, i) => `m${i}`))
  })

  it('messages to private chats are not counted against the group limit', async () => {
    for (let i = 0; i < 25; i++) await submitOp(h.ctx, { chatId: CHAT, key: `dm${i}`, kind: 'send_message', payload: { text: `m${i}`, to: ADMIN.id } })
    await h.app.settle()
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id)).toHaveLength(25)
  })
})

describe('F24: storage', () => {
  it('a full text of an ordinary message is written nowhere; the excerpt has at most 200 clusters', async () => {
    const long = `${'слово '.repeat(120)}КОНЕЦ-ТЕКСТА-МАРКЕР`
    await h.send(message({ id: 1, from: ALICE, text: long }))
    await h.app.settle()
    const excerpt = (await h.db.query('SELECT excerpt FROM messages WHERE message_id = 1'))[0].excerpt as string
    expect(Array.from(new Intl.Segmenter().segment(excerpt))).toHaveLength(200)
    const tables = await h.db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('text','jsonb','json')`)
    for (const t of tables) {
      const found = await h.db.query(`SELECT count(*)::int AS n FROM "${t.table_name}" WHERE "${t.column_name}"::text LIKE '%МАРКЕР%'`)
      expect(found[0].n, `${t.table_name}.${t.column_name}`).toBe(0)
    }
  })

  it('the evaluation job keeps its text until the evaluation ends, and not longer than 24 hours', async () => {
    const { JevError } = await import('../src/ports.js')
    h.jev.failures.push(new JevError('rate_limit', 'busy', { status: 429, retryAfter: 3600 * 30 }))
    await h.send(message({ id: 1, from: ALICE, text: 'ожидает оценки' }))
    await h.app.settle()
    expect((await h.db.query('SELECT request FROM evaluations'))[0].request.state.message).toBe('ожидает оценки')
    h.clock.advance(23 * 3_600_000)
    await runRetention(h.ctx)
    expect((await h.db.query('SELECT request FROM evaluations'))[0].request).not.toBeNull()
    h.clock.advance(2 * 3_600_000)
    await runRetention(h.ctx)
    expect((await h.db.query('SELECT status, request FROM evaluations'))[0]).toEqual({ status: 'unprocessed', request: null })
  })

  it('an excerpt lives 7 days, then stays only for the best messages: at most 10 per participant in the fixed order', async () => {
    await seedMember(h, ALICE)
    const karma = [0, 0, 4, 4, 4, 2, 2, 2, 1, 1, 1, 1]
    for (let i = 0; i < 12; i++) {
      await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at, excerpt, karma_sum, reply_count) VALUES ($1,$2,1,$3,$4,$5,0)`, [CHAT, i + 1, new Date(h.clock.now().getTime() - 8 * DAY), `old ${i + 1}`, karma[i]])
    }
    await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at, excerpt, karma_sum) VALUES ($1,13,1,$2,'young',0)`, [CHAT, new Date(h.clock.now().getTime() - DAY)])
    await runRetention(h.ctx)
    const kept = (await h.db.query('SELECT message_id FROM messages WHERE excerpt IS NOT NULL ORDER BY message_id')).map((r) => r.message_id)
    expect(kept).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })

  it('ties go to the message with more replies, then to the newer message', async () => {
    await seedMember(h, ALICE)
    for (let i = 1; i <= 11; i++) {
      await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at, excerpt, karma_sum, reply_count) VALUES ($1,$2,1,$3,'x',2,$4)`, [CHAT, i, new Date(h.clock.now().getTime() - 9 * DAY), i === 4 ? 0 : 1])
    }
    await runRetention(h.ctx)
    const dropped = (await h.db.query('SELECT message_id FROM messages WHERE excerpt IS NULL')).map((r) => r.message_id)
    expect(dropped).toEqual([4])
    await h.db.query(`UPDATE messages SET excerpt = 'x' WHERE message_id = 4`)
    await h.db.query(`UPDATE messages SET reply_count = 0`)
    await runRetention(h.ctx)
    expect((await h.db.query('SELECT message_id FROM messages WHERE excerpt IS NULL')).map((r) => r.message_id)).toEqual([1])
  })

  it('a message that drops out of the best loses its excerpt; each participant is ranked separately', async () => {
    await seedMember(h, ALICE)
    await seedMember(h, BOB)
    for (const user of [1, 2]) {
      for (let i = 1; i <= 10; i++) {
        await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at, excerpt, karma_sum) VALUES ($1,$2,$3,$4,'x',1)`, [CHAT, user * 100 + i, user, new Date(h.clock.now().getTime() - 9 * DAY)])
      }
    }
    await runRetention(h.ctx)
    expect(await h.db.query('SELECT 1 FROM messages WHERE excerpt IS NULL')).toEqual([])
    await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at, excerpt, karma_sum) VALUES ($1,150,1,$2,'better',9)`, [CHAT, new Date(h.clock.now().getTime() - 9 * DAY)])
    await runRetention(h.ctx)
    expect((await h.db.query('SELECT message_id FROM messages WHERE excerpt IS NULL')).map((r) => r.message_id)).toEqual([101])
  })

  it('text of deleted spam and of reported messages is kept for at most 30 days', async () => {
    await seedMember(h, ALICE)
    const at = h.clock.now()
    await h.db.query(`INSERT INTO held_texts (chat_id, message_id, author_id, author_name, text, reason, expires_at, created_at) VALUES ($1,1,1,'Alice','spam text','spam',$2,$3)`, [CHAT, new Date(at.getTime() + 30 * DAY), at])
    h.clock.advance(29 * DAY + 23 * 3_600_000)
    await runRetention(h.ctx)
    expect(await h.db.query('SELECT 1 FROM held_texts')).toHaveLength(1)
    h.clock.advance(1 * 3_600_000)
    await runRetention(h.ctx)
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
  })

  it('the text of a spam message is available to a fresh administrator through the card, and not through public endpoints', async () => {
    await seedMember(h, ALICE)
    await h.db.query(`INSERT INTO held_texts (chat_id, message_id, author_id, author_name, text, reason, expires_at, created_at) VALUES ($1,1,1,'Alice','секретный спам','spam',$2,$3)`, [CHAT, new Date(h.clock.now().getTime() + DAY), h.clock.now()])
    const web = await makeWeb(h)
    for (const path of ['/api/leaderboard?period=all', '/api/bans', '/api/me']) {
      expect(JSON.stringify(await (await get(web, path, VECTORS.outsider_lb)).json())).not.toContain('секретный спам')
    }
  })

  it('T-retention-catchup: after a long stop one run catches up on everything that expired', async () => {
    await seedMember(h, ALICE)
    for (let i = 1; i <= 12; i++) {
      await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at, excerpt, karma_sum) VALUES ($1,$2,1,$3,'x',$4)`, [CHAT, i, h.clock.now(), i])
    }
    await h.db.query(`INSERT INTO held_texts (chat_id, message_id, author_id, author_name, text, reason, expires_at, created_at) VALUES ($1,1,1,'A','t','spam',$2,$3)`, [CHAT, new Date(h.clock.now().getTime() + 30 * DAY), h.clock.now()])
    await h.db.query(`INSERT INTO evaluations (evaluation_id, chat_id, message_id, kind, status, next_attempt_at, created_at, request) VALUES ('e1',$1,1,'message','pending',$2,$2,'{"state":{"message":"x"}}')`, [CHAT, h.clock.now()])
    h.clock.advance(100 * DAY)
    await runRetention(h.ctx)
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
    expect((await h.db.query('SELECT request FROM evaluations'))[0].request).toBeNull()
    expect(await h.db.query('SELECT 1 FROM messages WHERE excerpt IS NOT NULL')).toHaveLength(10)
    await runRetention(h.ctx)
    expect(await h.db.query('SELECT 1 FROM messages WHERE excerpt IS NOT NULL')).toHaveLength(10)
  })

  it('an import file that was never processed is deleted after 24 hours', async () => {
    const { writeFileSync, existsSync } = await import('node:fs')
    const path = `${h.importDir}/stale.json`
    writeFileSync(path, '{}')
    await h.db.query(`INSERT INTO import_jobs (chat_id, status, file_path, created_at) VALUES ($1,'pending',$2,$3)`, [CHAT, path, h.clock.now()])
    h.clock.advance(25 * 3_600_000)
    await runRetention(h.ctx)
    expect(existsSync(path)).toBe(false)
    expect((await h.db.query('SELECT status FROM import_jobs'))[0].status).toBe('expired')
  })
})
