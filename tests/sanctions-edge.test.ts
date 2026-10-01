import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { submitAppeal } from '../src/appeal.js'
import { award } from '../src/karma.js'
import { NO_PERMISSIONS, TEXT_ONLY_PERMISSIONS } from '../src/ops.js'
import { getSettings } from '../src/settings/settings.js'
import { DEFAULT_PERMISSIONS, tgError } from './support/fakes.js'
import { ADMIN, ALICE, CAROL, CHAT, createHarness, message, pastObservation, type Harness } from './support/harness.js'

const SPAM = 'Заработай 500 долларов в день без вложений, пиши в личку!'
const HUMAN = 'Я живой человек, ошибся'
const MINUTE = 60_000
const HOUR = 3_600_000
const FAILED_CARD = 'Не смог выполнить действие в Telegram, подробности на экране админа'
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.jev.script(SPAM, { spam_earnings_crypto: 0.95 })
  h.jev.script(HUMAN, { appeal_genuine: 0.95 })
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const memberCalls = () =>
  h.tg.calls.filter((c) => ['banChatMember', 'unbanChatMember', 'restrictChatMember', 'deleteMessage'].includes(c.method)).map((c) => [c.method, ...c.args])
const cards = () => h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id).map((c) => c.args[1])

async function spin(times: number, stepMs: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    h.clock.advance(stepMs)
    await h.app.settle()
  }
}

// ---------------------------------------------------------------- D4

describe('a ban operation waiting for a retry is cancelled by an accepted or started appeal', () => {
  /** Steam room for Carol, the steam time runs out, the first banChatMember gets 502 and waits for a retry. */
  async function banWaitingForRetry(): Promise<string> {
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    h.tg.calls.length = 0
    h.clock.advance(24 * HOUR + 1_000)
    h.tg.fail('banChatMember', tgError.server(), 1)
    await h.app.settle()
    expect(await h.db.query(`SELECT status, attempt_count FROM operations WHERE operation_kind = 'ban'`)).toEqual([{ status: 'pending', attempt_count: 1 }])
    return (await h.db.query('SELECT ban_id FROM bans'))[0].ban_id
  }

  it('appeal accepted and lifted while the ban waits: the retry does not call banChatMember', async () => {
    await banWaitingForRetry()
    expect(await submitAppeal(h.ctx, CHAT, CAROL.id, HUMAN)).toEqual({ status: 'accepted', lifted: true })
    await spin(10, MINUTE)
    expect(memberCalls()).toEqual([
      ['banChatMember', CHAT, CAROL.id],
      ['restrictChatMember', CHAT, CAROL.id, DEFAULT_PERMISSIONS, undefined],
    ])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query(`SELECT status, last_error_code FROM operations WHERE operation_kind = 'ban'`)).toEqual([
      { status: 'failed', last_error_code: 'cancelled' },
    ])
    expect(await h.db.query(`SELECT status FROM flows WHERE kind = 'ban'`)).toEqual([{ status: 'completed' }])
    expect(cards()).toEqual([])
  })

  it.each(['accepted', 'evaluating'])('appeal %s while the ban waits: no ban, the record stays in the steam room', async (status) => {
    await banWaitingForRetry()
    await h.db.query(`UPDATE bans SET appeal_status = $1, appeal_claimed_at = $2`, [status, h.clock.now()])
    await spin(10, MINUTE)
    expect(memberCalls()).toEqual([['banChatMember', CHAT, CAROL.id]])
    expect(await h.db.query('SELECT state, appeal_status FROM bans')).toEqual([{ state: 'steam', appeal_status: status }])
    expect(await h.db.query(`SELECT status, last_error_code FROM operations WHERE operation_kind = 'ban'`)).toEqual([
      { status: 'failed', last_error_code: 'cancelled' },
    ])
    expect(cards()).toEqual([])
  })

  it('a ban left running by a crashed process is not executed after the appeal lifted the steam room', async () => {
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    const banId = (await h.db.query('SELECT ban_id FROM bans'))[0].ban_id
    h.clock.advance(24 * HOUR + 1_000)
    const now = h.clock.now()
    await h.db.query(
      `INSERT INTO flows (chat_id, kind, idempotency_key, data, step, status, next_attempt_at, created_at) VALUES ($1,'ban',$2,$3,1,'running',$4,$4)`,
      [CHAT, `ban:${banId}`, JSON.stringify({ userId: CAROL.id, banId }), new Date(now.getTime() + HOUR)],
    )
    await h.db.query(
      `INSERT INTO operations (chat_id, operation_kind, idempotency_key, payload, status, next_attempt_at, claimed_at, created_at)
       VALUES ($1,'ban',$2,$3,'running',$4,$4,$4)`,
      [CHAT, `ban:${banId}:ban`, JSON.stringify({ userId: CAROL.id, banId }), now],
    )
    h.tg.calls.length = 0
    expect(await submitAppeal(h.ctx, CHAT, CAROL.id, HUMAN)).toEqual({ status: 'accepted', lifted: true })
    await spin(10, MINUTE)
    h.clock.advance(HOUR)
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(0)
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query(`SELECT status, last_error_code FROM operations WHERE operation_kind = 'ban'`)).toEqual([
      { status: 'failed', last_error_code: 'cancelled' },
    ])
  })

  it('without an appeal the retry bans and the record becomes banned', async () => {
    await banWaitingForRetry()
    await spin(3, MINUTE)
    expect(memberCalls()).toEqual([
      ['banChatMember', CHAT, CAROL.id],
      ['banChatMember', CHAT, CAROL.id],
    ])
    expect(await h.db.query('SELECT state FROM bans')).toEqual([{ state: 'banned' }])
    expect(await h.db.query(`SELECT status, last_error_code FROM operations WHERE operation_kind = 'ban'`)).toEqual([{ status: 'completed', last_error_code: null }])
  })
})

// ---------------------------------------------------------------- D5

describe('a karma punishment that cannot check the role ends with a card and is not recorded as applied', () => {
  async function move(delta: number, key: string): Promise<void> {
    const settings = await getSettings(h.db, CHAT)
    await h.db.tx((q) => award(q, { chatId: CHAT, userId: ALICE.id, delta, reason: 't', source: 't', key, now: h.clock.now(), settings }))
  }
  const member = async () => (await h.db.query('SELECT punish_level, mute_until FROM members WHERE chat_id = $1 AND user_id = $2', [CHAT, ALICE.id]))[0]

  beforeEach(async () => {
    await h.send(message({ id: 1000, from: ALICE, text: 'привет' }))
    await h.app.settle()
    h.tg.calls.length = 0
  })

  it('permanent outage of getChatMember: no restriction, a failure card, level not applied; the next crossing applies', async () => {
    h.tg.fail('getChatMember', tgError.server(), 100)
    await move(-12, 'p1')
    await spin(8, 20_000)
    expect(memberCalls()).toEqual([])
    expect(await h.db.query('SELECT kind, payload FROM admin_cards')).toEqual([
      { kind: 'op_failed', payload: { targetUserId: ALICE.id, targetName: 'Alice', spam: null } },
    ])
    expect(cards()).toEqual([`${FAILED_CARD}\nУчастник: Alice (@alice)`])
    expect(await member()).toEqual({ punish_level: 0, mute_until: null })
    expect(await h.db.query(`SELECT status FROM flows WHERE kind = 'punish'`)).toEqual([{ status: 'completed' }])

    h.tg.failures.delete('getChatMember')
    await move(-15, 'p2')
    await h.app.settle()
    const until = Math.floor((h.clock.now().getTime() + 24 * HOUR) / 1000)
    expect(memberCalls()).toEqual([['restrictChatMember', CHAT, ALICE.id, NO_PERMISSIONS, until]])
    expect(await member()).toEqual({ punish_level: 2, mute_until: new Date(until * 1000) })
  })

  it('an applied lower level stays recorded when the next level cannot check the role', async () => {
    await move(-12, 'p1')
    await h.app.settle()
    expect(memberCalls()).toEqual([['restrictChatMember', CHAT, ALICE.id, TEXT_ONLY_PERMISSIONS, undefined]])
    h.tg.fail('getChatMember', tgError.server(), 100)
    await move(-15, 'p2')
    await spin(8, 20_000)
    expect(memberCalls()).toHaveLength(1)
    expect(await member()).toEqual({ punish_level: 1, mute_until: null })
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([{ kind: 'op_failed' }])
  })
})

// ---------------------------------------------------------------- role: only a successful answer is "member"

describe('any getChatMember error means "unknown", never "ordinary participant"', () => {
  it.each([
    ['chat not found', tgError.bad('Bad Request: chat not found')],
    ['user not found', tgError.bad('Bad Request: user not found')],
    ['forbidden', tgError.bad('Forbidden: bot was kicked', 403)],
  ])('steam room after a single %s answer waits until the role is known', async (_name, error) => {
    h.tg.fail('getChatMember', error, 1)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(memberCalls()).toEqual([])
    h.clock.advance(10_000)
    await h.app.settle()
    expect(memberCalls()).toEqual([
      ['deleteMessage', CHAT, 700],
      ['restrictChatMember', CHAT, CAROL.id, NO_PERMISSIONS, undefined],
    ])
  })

  it('a permanent 400 ends with a failure card and no sanction', async () => {
    h.tg.fail('getChatMember', tgError.bad('Bad Request: chat not found'), 100)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await spin(8, 20_000)
    expect(memberCalls()).toEqual([])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([{ kind: 'op_failed' }])
  })

  it('a karma punishment after a 400 answer waits until the role is known', async () => {
    await h.send(message({ id: 1000, from: ALICE, text: 'привет' }))
    await h.app.settle()
    h.tg.calls.length = 0
    h.tg.fail('getChatMember', tgError.bad('Bad Request: user not found'), 1)
    const settings = await getSettings(h.db, CHAT)
    await h.db.tx((q) => award(q, { chatId: CHAT, userId: ALICE.id, delta: -12, reason: 't', source: 't', key: 'p1', now: h.clock.now(), settings }))
    await h.app.settle()
    expect(memberCalls()).toEqual([])
    h.clock.advance(10_000)
    await h.app.settle()
    expect(memberCalls()).toEqual([['restrictChatMember', CHAT, ALICE.id, TEXT_ONLY_PERMISSIONS, undefined]])
  })
})
