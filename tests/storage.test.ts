import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDigest, runRetention } from '../src/scheduled.js'
import { changeSetting, getSettings, loadDefaultQuestions, validateInvariants } from '../src/settings/settings.js'
import { JevError } from '../src/ports.js'
import { HttpJevClient } from '../src/adapters/jev.js'
import { fakeServer, reply } from './support/http.js'
import { ADMIN, ALICE, BOB, CAROL, CHAT, DAY, botJoined, callback, command, createHarness, eventsOf, message, pastObservation, reaction, seedMember, setKarma, type Harness } from './support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.tg.members.set(ADMIN.id, 'administrator')
})
afterEach(async () => {
  await h.close()
})

async function scanFor(marker: string): Promise<string[]> {
  const columns = await h.db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('text','jsonb','json')`)
  const hits: string[] = []
  for (const c of columns) {
    const n = (await h.db.query(`SELECT count(*)::int AS n FROM "${c.table_name}" WHERE "${c.column_name}"::text LIKE $1`, [`%${marker}%`]))[0].n
    if (n > 0) hits.push(`${c.table_name}.${c.column_name}`)
  }
  return hits
}

describe('no copy of removed text stays in operations', () => {
  it('spam text, report text and digest excerpts leave operations.payload once the operation is final', async () => {
    await pastObservation(h)
    await h.send(message({ id: 600, from: CAROL, text: 'привет' }))
    h.jev.script('МАРКЕР-СПАМА курс со скидкой', { spam_other_offer: 0.95 })
    await h.send(message({ id: 701, from: CAROL, text: 'МАРКЕР-СПАМА курс со скидкой' }))
    await seedMember(h, BOB, 100)
    await h.send(message({ id: 900, from: ALICE, text: 'МАРКЕР-ЖАЛОБЫ плохое' }))
    await h.send(command({ id: 950, from: BOB, text: '/report', reply_to: { message_id: 900, from: ALICE, text: 'МАРКЕР-ЖАЛОБЫ плохое' } }))
    await h.app.settle()
    const back = h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id).map((c) => (c.args[2] as Array<Array<{ text: string; callback_data: string }>>)[1]).find((b) => b.some((x) => x.text === 'Вернуть'))!
    await h.send(callback({ data: back.find((b) => b.text === 'Вернуть')!.callback_data, from: ADMIN }))
    await h.app.settle()
    expect(h.tg.of('sendMessage').some((c) => String(c.args[1]).includes('МАРКЕР-ЖАЛОБЫ'))).toBe(true)
    h.clock.advance(31 * DAY)
    await runRetention(h.ctx)
    for (const marker of ['МАРКЕР-СПАМА', 'МАРКЕР-ЖАЛОБЫ']) expect(await scanFor(marker), marker).toEqual([])
  })

  it('the digest excerpt is scrubbed after the send', async () => {
    await h.send(botJoined())
    await seedMember(h, ALICE)
    await h.db.query(`INSERT INTO karma_events (chat_id, user_id, delta, reason, source, idempotency_key, created_at) VALUES ($1,1,5,'s','s','e1','2026-09-08T10:00:00Z')`, [CHAT])
    await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at, excerpt, karma_sum, is_answer) VALUES ($1,501,1,'2026-09-09T10:00:00Z','МАРКЕР-СВОДКИ',5,true)`, [CHAT])
    h.clock.set('2026-09-14T06:00:00Z')
    await h.app.settle()
    expect(h.tg.of('sendMessage').some((c) => String(c.args[1]).includes('МАРКЕР-СВОДКИ'))).toBe(true)
    await h.db.query('UPDATE messages SET excerpt = NULL')
    expect(await scanFor('МАРКЕР-СВОДКИ')).toEqual([])
  })

  it('the cleanup catches up on old final operations that still hold text; an old pending one with member text expires, a digest waits', async () => {
    await h.send(botJoined())
    const insert = (key: string, status: string, memberText = true) =>
      h.db.query(`INSERT INTO operations (chat_id, operation_kind, idempotency_key, payload, status, next_attempt_at, created_at) VALUES ($1,'send_message',$2,$3,$4,$5,$5)`, [
        CHAT, key, JSON.stringify({ text: `МАРКЕР-СТАРЫЙ ${key}`, buttons: [[{ text: 'b', url: 'https://t.me/x' }]], ...(memberText ? { memberText: true } : {}) }), status, new Date(h.clock.now().getTime() - 40 * DAY),
      ])
    for (const status of ['completed', 'failed', 'outcome_unknown']) await insert(`old-${status}`, status)
    await insert('waiting', 'pending')
    await insert('digest-waiting', 'pending', false)
    await runRetention(h.ctx)
    const rows = await h.db.query('SELECT idempotency_key, payload, status, last_error_code FROM operations ORDER BY idempotency_key')
    const scrubbed = { buttons: [[{ text: 'b', url: 'https://t.me/x' }]], memberText: true }
    expect(rows).toEqual([
      { idempotency_key: 'digest-waiting', payload: { text: 'МАРКЕР-СТАРЫЙ digest-waiting', buttons: [[{ text: 'b', url: 'https://t.me/x' }]] }, status: 'pending', last_error_code: null },
      { idempotency_key: 'old-completed', payload: scrubbed, status: 'completed', last_error_code: null },
      { idempotency_key: 'old-failed', payload: scrubbed, status: 'failed', last_error_code: null },
      { idempotency_key: 'old-outcome_unknown', payload: scrubbed, status: 'outcome_unknown', last_error_code: null },
      { idempotency_key: 'waiting', payload: scrubbed, status: 'failed', last_error_code: 'expired' },
    ])
  })
})

describe('settings that depend on each other are changed under one lock per chat', () => {
  it('two related thresholds set at once cannot leave the order broken', async () => {
    await h.send(botJoined())
    await h.db.query(`CREATE FUNCTION slow() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$ LANGUAGE plpgsql`)
    await h.db.query(`CREATE TRIGGER slow BEFORE INSERT ON chat_settings FOR EACH ROW EXECUTE FUNCTION slow()`)
    const results = await Promise.allSettled([
      changeSetting(h.db, { chatId: CHAT, key: 'spam_review_threshold', value: 0.45, baseVersion: 0, actor: 1, now: h.clock.now() }),
      changeSetting(h.db, { chatId: CHAT, key: 'spam_review_delete_threshold', value: 0.4, baseVersion: 0, actor: 2, now: h.clock.now() }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const values = (await getSettings(h.db, CHAT)).all()
    expect(validateInvariants(values)).toBeNull()
  })
})

describe('the weekly digest', () => {
  async function seed(): Promise<void> {
    await h.send(botJoined())
    await seedMember(h, ALICE)
    await h.db.query(`INSERT INTO karma_events (chat_id, user_id, delta, reason, source, idempotency_key, created_at) VALUES ($1,1,5,'s','s','e1','2026-09-08T10:00:00Z')`, [CHAT])
    h.clock.set('2026-09-14T06:00:00Z')
  }

  it('the marker and the operation are written in one transaction: an interrupted write loses nothing', async () => {
    await seed()
    await h.db.query(`CREATE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'stop'; END $$ LANGUAGE plpgsql`)
    await h.db.query(`CREATE TRIGGER boom BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION boom()`)
    await expect(runDigest(h.ctx)).rejects.toThrow('stop')
    expect(await h.db.query('SELECT 1 FROM job_runs')).toEqual([])
    await h.db.query('DROP TRIGGER boom ON operations')
    await h.app.settle()
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(1)
  })

  it('a chat that appeared during the current week has no digest for the week before', async () => {
    await h.send(botJoined())
    await h.db.query(`UPDATE chats SET created_at = $1`, ['2026-09-14T01:00:00Z'])
    h.clock.set('2026-09-14T06:00:00Z')
    await h.app.settle()
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(0)
  })
})

describe('a re-added reaction is counted by the current rules', () => {
  beforeEach(async () => {
    await pastObservation(h)
    await h.send(message({ id: 1000, from: ALICE, text: 'полезное' }))
    await h.send(message({ id: 1500, from: BOB, text: 'привет' }))
    await h.app.settle()
  })

  it('a reaction that moved to the ignored list gives nothing when put back', async () => {
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👍'] }))
    await h.send(reaction({ message_id: 1000, from: BOB, old: ['👍'], new: [] }))
    await changeSetting(h.db, { chatId: CHAT, key: 'reactions_ignore', value: ['👍'], baseVersion: 0, actor: 1, now: h.clock.now() })
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👍'] }))
    expect((await eventsOf(h, ALICE.id)).map((e) => e.reason)).toEqual(['reaction_plus', 'reaction_undo'])
  })

  it('a minus reaction put back is checked against the minimum karma and the daily limit', async () => {
    await setKarma(h, BOB.id, 5)
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👎'] }))
    await h.send(reaction({ message_id: 1000, from: BOB, old: ['👎'], new: [] }))
    await setKarma(h, BOB.id, 0)
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👎'] }))
    expect((await eventsOf(h, ALICE.id)).map((e) => e.reason)).toEqual(['reaction_minus', 'reaction_undo'])
    await setKarma(h, BOB.id, 5)
    for (let i = 0; i < 5; i++) {
      await h.send(message({ id: 2000 + i, from: CAROL, text: `цель ${i}` }))
      await h.send(reaction({ message_id: 2000 + i, from: BOB, new: ['👎'] }))
    }
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👎'] }))
    const active = await h.db.query(`SELECT count(*)::int AS n FROM reactions WHERE actor_id = $1 AND active AND awarded < 0`, [BOB.id])
    expect(active[0].n).toBe(4)
    expect((await h.db.query(`SELECT count(*)::int AS n FROM reactions WHERE actor_id = $1 AND awarded < 0`, [BOB.id]))[0].n).toBe(5)
  })

  it('a re-added plus reaction uses the current voter weight and pair factor', async () => {
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👍'] }))
    await h.send(reaction({ message_id: 1000, from: BOB, old: ['👍'], new: [] }))
    await setKarma(h, BOB.id, 200)
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👍'] }))
    const events = await eventsOf(h, ALICE.id)
    const first = events[0].delta
    const again = events[2].delta
    expect(again).toBeGreaterThan(0)
    expect(again).not.toBe(first)
    expect(again).toBeCloseTo((1 / (1 + Math.log(2))) * (1 + Math.log(3)) * 1.05, 3)
  })
})

describe('the question set keeps the normative keys and types', () => {
  const change = (value: unknown) => changeSetting(h.db, { chatId: CHAT, key: 'questions', value, baseVersion: 0, actor: 1, now: h.clock.now() })
  const base = () => JSON.parse(JSON.stringify(loadDefaultQuestions())) as Record<string, Record<string, unknown>>

  it('removing or renaming a normative question is refused', async () => {
    for (const name of ['appeal_genuine', 'spam_earnings_crypto', 'spam_topic_pivot', 'spam_channel_bait', 'spam_other_offer', 'profile_promo', 'usefulness', 'tone']) {
      const removed = base()
      delete removed[name]
      await expect(change(removed), `remove ${name}`).rejects.toThrow(name)
      const renamed = base()
      renamed[`${name}_x`] = renamed[name]
      delete renamed[name]
      await expect(change(renamed), `rename ${name}`).rejects.toThrow(name)
    }
  })

  it('changing the type of a normative question is refused', async () => {
    const wrong = base()
    wrong.usefulness = { ...wrong.usefulness, type: 'noul' }
    await expect(change(wrong)).rejects.toThrow('usefulness')
  })

  it('new questions and new wording are allowed', async () => {
    const ok = base()
    ok.extra_question = { type: 'noul', instructions: 'Is `message` about cats?' }
    ok.rude = { ...ok.rude, instructions: 'Is `message` an attack on a person?' }
    await expect(change(ok)).resolves.toEqual({ version: 1 })
  })
})

describe('what is logged from a rejected Jev answer', () => {
  it('the body is cut and does not carry the message text', async () => {
    await h.send(botJoined())
    const secret = 'СЕКРЕТНЫЙ-ТЕКСТ-СООБЩЕНИЯ'
    const server = await fakeServer((seen, _i, res) => {
      const echoed = JSON.parse(seen.body).state.message as string
      reply(res, 422, { error: 'bad', echo: echoed, padding: 'x'.repeat(5000) })
    })
    h.ctx.jev = new HttpJevClient('k', `${server.url}/v1/systemone`, 2000)
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = []
    h.ctx.log = { info: () => {}, warn: () => {}, error: (event, fields) => logs.push({ event, fields }) }
    await h.send(message({ id: 1, from: ALICE, text: secret }))
    await h.app.settle()
    await server.close()
    const entry = logs.find((l) => l.event === 'jev_rejected')!
    expect(entry.fields?.status).toBe(422)
    const body = String(entry.fields?.body)
    expect(body.length).toBeLessThanOrEqual(300)
    expect(JSON.stringify(logs)).not.toContain(secret)
    expect(new JevError('reject', 'x').body).toBeUndefined()
  })
})
