import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { award } from '../src/karma.js'
import { NO_PERMISSIONS, TEXT_ONLY_PERMISSIONS } from '../src/ops.js'
import { runDecay } from '../src/scheduled.js'
import { getSettings } from '../src/settings/settings.js'
import { DEFAULT_PERMISSIONS, jevDown, tgError } from './support/fakes.js'
import { ADMIN, ALICE, BOB, CAROL, CHAT, DAY, createHarness, eventsOf, karmaOf, message, pastObservation, reaction, setKarma, T0, type Harness } from './support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.close()
})

async function move(userId: number, delta: number, key: string): Promise<void> {
  const settings = await getSettings(h.db, CHAT)
  await h.db.tx((q) => award(q, { chatId: CHAT, userId, delta, reason: 'test', source: 'test', key, now: h.clock.now(), settings }))
  await h.app.settle()
}

describe('F13: decay', () => {
  beforeEach(async () => {
    await h.send(message({ id: 1000, from: ALICE, text: 'привет' }))
    await h.app.settle()
    await setKarma(h, ALICE.id, 100)
  })

  it('takes 10% per full 30 days after the 14 days of silence, and never repeats', async () => {
    h.clock.advance(43 * DAY)
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(100)
    h.clock.advance(1 * DAY)
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(90)
    await h.app.settle()
    await runDecay(h.ctx)
    expect(await karmaOf(h, ALICE.id)).toBe(90)
    h.clock.advance(30 * DAY)
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(81)
    h.clock.advance(60 * DAY)
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(65.61, 3)
    expect((await eventsOf(h, ALICE.id)).filter((e) => e.reason === 'decay')).toHaveLength(4)
  })

  it('T-decay-twice: two concurrent runs apply each period once', async () => {
    h.clock.advance(75 * DAY)
    await Promise.all([runDecay(h.ctx), runDecay(h.ctx)])
    expect(await karmaOf(h, ALICE.id)).toBe(81)
  })

  it('a missed run catches up on all periods, an interrupted run continues', async () => {
    h.clock.advance(120 * DAY)
    await runDecay(h.ctx)
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(72.9, 4)
    await runDecay(h.ctx)
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(72.9, 4)
  })

  it('stops at the lower bound and treats negative karma by the same formula', async () => {
    await setKarma(h, ALICE.id, -20)
    h.clock.advance(44 * DAY)
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(-22)
    h.clock.advance(300 * DAY)
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(-50)
  })

  it('activity stops the decay; the count restarts from the last activity', async () => {
    h.clock.advance(40 * DAY)
    await h.send(message({ id: 1001, from: ALICE, text: 'я вернулся', date: h.clock.now().toISOString() }))
    await h.app.settle()
    h.clock.advance(10 * DAY)
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(100)
  })

  it('a message flagged as flood above the threshold is not activity', async () => {
    h.jev.script('ааааа', { is_flood: 0.9 })
    h.clock.advance(40 * DAY)
    await h.send(message({ id: 1001, from: ALICE, text: 'ааааа', date: h.clock.now().toISOString() }))
    await h.app.settle()
    h.clock.advance(5 * DAY)
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(90)
  })

  it('a message exactly at the flood threshold does not count as activity either way: below counts, at or above does not', async () => {
    h.jev.script('ббббб', { is_flood: 0.49 })
    h.clock.advance(40 * DAY)
    await h.send(message({ id: 1001, from: ALICE, text: 'ббббб', date: h.clock.now().toISOString() }))
    await h.app.settle()
    h.clock.advance(20 * DAY)
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(100)
  })
})

describe('F13: series of active weeks', () => {
  const at = (iso: string): string => iso
  async function say(id: number, iso: string, from = ALICE): Promise<void> {
    h.clock.set(iso)
    await h.send(message({ id, from, text: `сообщение ${id}`, date: at(iso) }))
    await h.app.settle()
  }
  const weeks = async (): Promise<string[]> => (await h.db.query('SELECT week FROM member_weeks WHERE user_id = 1 ORDER BY week')).map((r) => r.week)

  it('weeks are ISO weeks in the chat time zone', async () => {
    await say(1, '2026-09-06T18:59:00Z')
    await say(2, '2026-09-06T19:01:00Z')
    expect(await weeks()).toEqual(['2026-W36', '2026-W37'])
  })

  it('each adjacent active week adds 5%, at most 25%; a skipped week resets', async () => {
    await say(1, '2026-09-01T12:00:00Z')
    await say(2, '2026-09-08T12:00:00Z')
    await say(3, '2026-09-15T12:00:00Z')
    await say(4, '2026-09-16T12:00:00Z')
    await h.send(message({ id: 50, from: BOB, text: 'привет' }))
    await h.send(reaction({ message_id: 3, from: BOB, new: ['👍'] }))
    expect((await eventsOf(h, ALICE.id)).at(-1)!.delta).toBe(1.15)
    await say(5, '2026-09-22T12:00:00Z')
    await say(6, '2026-09-29T12:00:00Z')
    await say(7, '2026-10-06T12:00:00Z')
    await say(8, '2026-10-13T12:00:00Z')
    await say(9, '2026-10-20T12:00:00Z')
    await h.send(reaction({ message_id: 9, from: BOB, new: ['👍'] }))
    expect((await eventsOf(h, ALICE.id)).at(-1)!.delta).toBe(1.25)
    await say(10, '2026-11-10T12:00:00Z')
    await h.send(reaction({ message_id: 10, from: BOB, new: ['👍'] }))
    expect((await eventsOf(h, ALICE.id)).at(-1)!.delta).toBeCloseTo((1 / (1 + Math.log(2))) * 1.05, 3)
  })

  it('a run of messages by one author makes each next Jev accrual cheaper', async () => {
    for (let i = 1; i <= 3; i++) h.jev.script(`длинный разбор ${i}`, { usefulness: { score: 3, confidence: 0.6 } })
    for (let i = 1; i <= 3; i++) await h.send(message({ id: 10 + i, from: ALICE, text: `длинный разбор ${i}` }))
    await h.app.settle()
    const jev = (await eventsOf(h, ALICE.id)).filter((e) => e.reason === 'jev_usefulness').map((e) => e.delta)
    expect(jev[0]).toBeCloseTo(0.25 * 1.05, 4)
    expect(jev[1]).toBeCloseTo((0.25 / (1 + Math.log(2))) * 1.05, 4)
    expect(jev[2]).toBeCloseTo((0.25 / (1 + Math.log(3))) * 1.05, 4)
    await h.send(message({ id: 20, from: BOB, text: 'перебил' }))
    h.jev.script('длинный разбор 4', { usefulness: { score: 3, confidence: 0.6 } })
    await h.send(message({ id: 21, from: ALICE, text: 'длинный разбор 4' }))
    await h.app.settle()
    expect((await eventsOf(h, ALICE.id)).filter((e) => e.reason === 'jev_usefulness').at(-1)!.delta).toBeCloseTo(0.25 * 1.05, 4)
  })

  it('an unavailable evaluation counts as activity (no data is not flood)', async () => {
    h.jev.failures.push(jevDown(), jevDown(), jevDown())
    await h.send(message({ id: 1, from: ALICE, text: 'нет оценки' }))
    for (let i = 0; i < 4; i++) {
      await h.app.settle()
      h.clock.advance(10_000)
    }
    expect(await weeks()).toEqual(['2026-W36'])
    expect(T0).toBeTruthy()
  })
})

describe('F14: punishments for low karma', () => {
  beforeEach(async () => {
    await pastObservation(h)
    await h.send(message({ id: 1000, from: ALICE, text: 'привет' }))
    await h.app.settle()
    h.tg.calls.length = 0
  })

  const restricts = (): unknown[][] => h.tg.of('restrictChatMember').map((c) => c.args)

  it('<= -10: text only, checked once per crossing', async () => {
    await move(ALICE.id, -9, 'a')
    expect(restricts()).toEqual([])
    await move(ALICE.id, -1, 'b')
    expect(restricts()).toEqual([[CHAT, ALICE.id, TEXT_ONLY_PERMISSIONS, undefined]])
    await move(ALICE.id, -3, 'c')
    expect(restricts()).toHaveLength(1)
  })

  it('<= -25: mute for 24 hours; <= -40: mute for 7 days', async () => {
    await move(ALICE.id, -30, 'a')
    const dayUntil = Math.floor((h.clock.now().getTime() + 24 * 3600_000) / 1000)
    expect(restricts()).toEqual([[CHAT, ALICE.id, NO_PERMISSIONS, dayUntil]])
    await move(ALICE.id, -12, 'b')
    const weekUntil = Math.floor((h.clock.now().getTime() + 7 * 24 * 3600_000) / 1000)
    expect(restricts().at(-1)).toEqual([CHAT, ALICE.id, NO_PERMISSIONS, weekUntil])
    expect(restricts()).toHaveLength(2)
  })

  it('leaving the zone returns the default chat rights; a new crossing punishes again', async () => {
    await move(ALICE.id, -12, 'a')
    await move(ALICE.id, 5, 'b')
    expect(restricts().at(-1)).toEqual([CHAT, ALICE.id, DEFAULT_PERMISSIONS, undefined])
    await move(ALICE.id, -6, 'c')
    expect(restricts().at(-1)).toEqual([CHAT, ALICE.id, TEXT_ONLY_PERMISSIONS, undefined])
    expect(restricts()).toHaveLength(3)
  })

  it('the lower bound is -50', async () => {
    await move(ALICE.id, -80, 'a')
    expect(await karmaOf(h, ALICE.id)).toBe(-50)
    expect((await eventsOf(h, ALICE.id)).at(-1)!.delta).toBe(-50)
  })

  it('after the mute expires the -10 rights apply while karma stays low, otherwise the defaults', async () => {
    await move(ALICE.id, -30, 'a')
    h.tg.calls.length = 0
    h.clock.advance(25 * 3600_000)
    await h.app.settle()
    expect(restricts()).toEqual([[CHAT, ALICE.id, TEXT_ONLY_PERMISSIONS, undefined]])
    await move(ALICE.id, 30, 'b')
    expect(restricts().at(-1)).toEqual([CHAT, ALICE.id, DEFAULT_PERMISSIONS, undefined])
  })

  it('administrators and the owner are not punished', async () => {
    h.tg.members.set(ALICE.id, 'administrator')
    await move(ALICE.id, -30, 'a')
    expect(restricts()).toEqual([])
  })

  it('a participant in the ban record is not punished for karma', async () => {
    await h.db.query(`INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at) VALUES ($1,$2,'admin',0,0,0,'steam',$3,$3)`, [CHAT, ALICE.id, h.clock.now()])
    await move(ALICE.id, -30, 'a')
    expect(restricts()).toEqual([])
  })

  it('a restriction that fails leaves an operation visible on the admin screen', async () => {
    h.tg.fail('restrictChatMember', tgError.server(), 3)
    await move(ALICE.id, -12, 'a')
    for (let i = 0; i < 5; i++) {
      h.clock.advance(20_000)
      await h.app.settle()
    }
    expect((await h.db.query(`SELECT status FROM operations WHERE operation_kind = 'restrict'`))[0].status).toBe('failed')
  })

  it('minus reactions of a participant at -10 and below are not counted', async () => {
    await h.send(message({ id: 1100, from: BOB, text: 'цель' }))
    await h.app.settle()
    await setKarma(h, CAROL.id, -12).catch(() => {})
    await h.send(message({ id: 1101, from: CAROL, text: 'привет' }))
    await setKarma(h, CAROL.id, -12)
    await h.send(reaction({ message_id: 1100, from: CAROL, new: ['👎'] }))
    expect(await karmaOf(h, BOB.id)).toBe(0)
    expect(ADMIN.id).toBeGreaterThan(0)
  })

  it('no punishments during observation', async () => {
    await h.close()
    h = await createHarness()
    await h.send(message({ id: 1000, from: ALICE, text: 'привет' }))
    await h.app.settle()
    await move(ALICE.id, -30, 'a')
    expect(h.tg.count('restrictChatMember')).toBe(0)
  })
})
