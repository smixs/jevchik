import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { award } from '../src/karma.js'
import { NO_PERMISSIONS } from '../src/ops.js'
import { getSettings } from '../src/settings/settings.js'
import { DEFAULT_PERMISSIONS, tgError } from './support/fakes.js'
import { ADMIN, ALICE, CAROL, CHAT, DAY, createHarness, message, pastObservation, restartHarness, type Harness } from './support/harness.js'

const SPAM = 'Заработай 500 долларов в день без вложений, пиши в личку!'
const MINUTE = 60_000
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.jev.script(SPAM, { spam_earnings_crypto: 0.95 })
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const sent = () => h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)
const cards = () => h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id)

async function runningOp(key: string, kind: string, payload: unknown, claimedAgoMs: number): Promise<void> {
  await h.db.query(
    `INSERT INTO operations (chat_id, operation_kind, idempotency_key, payload, status, next_attempt_at, claimed_at, created_at)
     VALUES ($1,$2,$3,$4,'running',$5,$5,$5)`,
    [CHAT, kind, key, JSON.stringify(payload), new Date(h.clock.now().getTime() - claimedAgoMs)],
  )
}

describe('an operation left running by a crashed process is picked up when its lease expires', () => {
  it('fast restart: the steam room continues from the unfinished step', async () => {
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await runningOp(`steam:${CHAT}:${CAROL.id}:700:restrict`, 'restrict', { userId: CAROL.id, permissions: NO_PERMISSIONS }, 0)
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(1)
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    h = await restartHarness(h)
    await h.app.start()
    h.clock.advance(1 * MINUTE)
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(0)
    h.clock.advance(6 * MINUTE)
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(h.tg.count('deleteMessage')).toBe(0)
    expect(await h.db.query('SELECT 1 FROM bans')).toHaveLength(1)
    expect(sent()).toHaveLength(1)
  })

  it('a stale running send becomes outcome_unknown while the process keeps working, and is not repeated', async () => {
    await runningOp('k-send', 'send_message', { text: 'x' }, 6 * MINUTE)
    await h.app.settle()
    expect((await h.db.query(`SELECT status FROM operations WHERE idempotency_key = 'k-send'`))[0].status).toBe('outcome_unknown')
    expect(sent()).toHaveLength(0)
  })

  it('stale running unban and ban operations are executed again', async () => {
    await runningOp('k-ban', 'ban', { userId: CAROL.id }, 6 * MINUTE)
    await runningOp('k-unban', 'unban', { userId: ALICE.id }, 6 * MINUTE)
    await h.app.settle()
    expect(h.tg.of('banChatMember').map((c) => c.args)).toEqual([[CHAT, CAROL.id]])
    expect(h.tg.of('unbanChatMember').map((c) => c.args)).toEqual([[CHAT, ALICE.id]])
  })

  it('a fresh lease is left alone', async () => {
    await runningOp('k-fresh', 'ban', { userId: CAROL.id }, 1 * MINUTE)
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(0)
  })
})

describe('"cannot tell whether the target is an administrator" is not "not an administrator"', () => {
  it('steam: no delete and no restrict while the role is unknown; it continues once known', async () => {
    h.tg.fail('getChatMember', tgError.server(), 3)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(0)
    expect(h.tg.count('restrictChatMember')).toBe(0)
    h.clock.advance(10_000)
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(1)
    expect(h.tg.count('restrictChatMember')).toBe(1)
  })

  it('an administrator found after the outage is still protected', async () => {
    h.tg.fail('getChatMember', tgError.server(), 3)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    h.tg.members.set(CAROL.id, 'administrator')
    h.clock.advance(10_000)
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(0)
    expect(h.tg.count('restrictChatMember')).toBe(0)
  })

  it('a permanent outage ends with a card to admins and no sanction', async () => {
    h.tg.fail('getChatMember', tgError.server(), 100)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    for (let i = 0; i < 8; i++) {
      await h.app.settle()
      h.clock.advance(20_000)
    }
    expect(h.tg.count('deleteMessage')).toBe(0)
    expect(h.tg.count('restrictChatMember')).toBe(0)
    expect(cards()).toHaveLength(1)
  })

  it('the delete flow of probation (rule 4 is left only there, section 3.6.2) waits too', async () => {
    await h.send(message({ id: 600, from: CAROL, text: 'привет' }))
    await h.app.settle()
    await h.db.query('UPDATE members SET probation_left = 5 WHERE user_id = $1', [CAROL.id])
    h.jev.script('реклама курса', { spam_other_offer: 0.6 })
    h.tg.fail('getChatMember', tgError.server(), 3)
    await h.send(message({ id: 701, from: CAROL, text: 'реклама курса' }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(0)
    h.clock.advance(10_000)
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(1)
  })

  it('a "user not found" answer is not a confirmed participant: the delete waits until the role is known', async () => {
    h.tg.fail('getChatMember', tgError.bad('Bad Request: user not found'), 1)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(0)
    h.clock.advance(10_000)
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(1)
  })

  it('karma punishments do not restrict while the role is unknown', async () => {
    await h.send(message({ id: 1000, from: ALICE, text: 'привет' }))
    await h.app.settle()
    h.tg.calls.length = 0
    h.tg.fail('getChatMember', tgError.server(), 3)
    const settings = await getSettings(h.db, CHAT)
    await h.db.tx((q) => award(q, { chatId: CHAT, userId: ALICE.id, delta: -12, reason: 't', source: 't', key: 'p1', now: h.clock.now(), settings }))
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(0)
    h.clock.advance(10_000)
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
  })
})

describe('an accepted or started appeal cancels the transition to the ban', () => {
  async function steamed(): Promise<void> {
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    h.tg.calls.length = 0
  }

  it.each(['accepted', 'evaluating'])('a ban flow created earlier does not ban when the appeal is %s', async (status) => {
    await steamed()
    const ban = (await h.db.query('SELECT ban_id FROM bans'))[0]
    await h.db.query(`UPDATE bans SET appeal_status = $1`, [status])
    await h.db.query(
      `INSERT INTO flows (chat_id, kind, idempotency_key, data, step, status, next_attempt_at, created_at) VALUES ($1,'ban','early',$2,0,'running',$3,$3)`,
      [CHAT, JSON.stringify({ userId: CAROL.id, banId: ban.ban_id }), h.clock.now()],
    )
    h.clock.advance(25 * 3600_000)
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(0)
    expect((await h.db.query('SELECT state FROM bans'))[0].state).toBe('steam')
  })

  it('the check is repeated right before banChatMember (flow parked on the ban step)', async () => {
    await steamed()
    const ban = (await h.db.query('SELECT ban_id FROM bans'))[0]
    await h.db.query(`UPDATE bans SET appeal_status = 'accepted'`)
    await h.db.query(
      `INSERT INTO flows (chat_id, kind, idempotency_key, data, step, status, next_attempt_at, created_at) VALUES ($1,'ban','manual',$2,1,'running',$3,$3)`,
      [CHAT, JSON.stringify({ userId: CAROL.id, banId: ban.ban_id }), h.clock.now()],
    )
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(0)
  })

  it('without an appeal the ban still happens', async () => {
    await steamed()
    h.clock.advance(25 * 3600_000)
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(1)
    expect(DAY).toBeGreaterThan(0)
  })
})

describe('a missing getChat.permissions is not an outage', () => {
  it('lifting a steam-room restriction uses an explicit default set and finishes', async () => {
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    h.tg.chatInfo = {}
    const { submitAppeal } = await import('../src/appeal.js')
    h.jev.script('Я человек, пришёл за советами', { appeal_genuine: 0.95 })
    expect(await submitAppeal(h.ctx, CHAT, CAROL.id, 'Я человек, пришёл за советами')).toEqual({ status: 'accepted', lifted: true })
    expect(h.tg.of('restrictChatMember').at(-1)!.args[2]).toEqual(DEFAULT_PERMISSIONS)
  })

  it('leaving the karma zone restores rights the same way; an outage of getChat still waits', async () => {
    await h.send(message({ id: 1000, from: ALICE, text: 'привет' }))
    await h.app.settle()
    const settings = await getSettings(h.db, CHAT)
    const move = async (delta: number, key: string) => {
      await h.db.tx((q) => award(q, { chatId: CHAT, userId: ALICE.id, delta, reason: 't', source: 't', key, now: h.clock.now(), settings }))
      await h.app.settle()
    }
    await move(-12, 'a')
    h.tg.calls.length = 0
    h.tg.chatInfo = {}
    h.tg.fail('getChat', tgError.server(), 3)
    await move(20, 'b')
    expect(h.tg.count('restrictChatMember')).toBe(0)
    h.clock.advance(10_000)
    await h.app.settle()
    expect(h.tg.of('restrictChatMember').at(-1)!.args[2]).toEqual(DEFAULT_PERMISSIONS)
  })
})
