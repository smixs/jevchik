import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALICE, BOB, CAROL, CHAT, createHarness, eventsOf, karmaOf, message, reaction, reactionCount, setKarma, T0, type Harness } from './support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  await h.send(message({ id: 1000, from: ALICE, text: 'полезное сообщение' }))
  await h.app.settle()
})
afterEach(async () => {
  await h.close()
})

// Alice has a one-week series after her first evaluated message: positive accruals get +5%.
const BOOST = 1.05

describe('F3: reactions', () => {
  it('a plus reaction adds karma to the author; removing it cancels with a compensating event', async () => {
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👍'] }))
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(BOOST, 4)
    await h.send(reaction({ message_id: 1000, from: BOB, old: ['👍'], new: [] }))
    expect(await karmaOf(h, ALICE.id)).toBe(0)
    expect(await eventsOf(h, ALICE.id)).toEqual([
      { delta: 1.05, reason: 'reaction_plus' },
      { delta: -1.05, reason: 'reaction_undo' },
    ])
  })

  it('putting a reaction back is counted anew and cannot be farmed', async () => {
    for (let i = 0; i < 3; i++) {
      await h.send(reaction({ message_id: 1000, from: BOB, new: ['👍'] }))
      await h.send(reaction({ message_id: 1000, from: BOB, old: ['👍'], new: [] }))
    }
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👍'] }))
    expect(await karmaOf(h, ALICE.id)).toBeGreaterThan(0)
    expect(await karmaOf(h, ALICE.id)).toBeLessThan(BOOST)
  })

  it('a minus reaction takes karma away, with the voter weight applied', async () => {
    await h.send(message({ id: 1500, from: BOB, text: 'привет' }))
    await setKarma(h, BOB.id, 5)
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👎'] }))
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(-(1 + Math.log(1.05)), 4)
    expect((await eventsOf(h, ALICE.id))[0].delta).toBe(-1.0488)
  })

  it('a participant with karma below the minimum cannot minus', async () => {
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👎'] }))
    expect(await karmaOf(h, ALICE.id)).toBe(0)
    expect(await eventsOf(h, ALICE.id)).toEqual([])
  })

  it('ignored reactions change nothing', async () => {
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['💩', '🤮', '🤡'] }))
    expect(await eventsOf(h, ALICE.id)).toEqual([])
  })

  it('a reaction to your own message changes nothing', async () => {
    await h.send(reaction({ message_id: 1000, from: ALICE, new: ['👍'] }))
    expect(await eventsOf(h, ALICE.id)).toEqual([])
  })

  it('only the added and removed reactions are processed on a change', async () => {
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👍'] }))
    await h.send(reaction({ message_id: 1000, from: BOB, old: ['👍'], new: ['👍', '🔥'] }))
    const events = await eventsOf(h, ALICE.id)
    expect(events.map((e) => e.reason)).toEqual(['reaction_plus', 'reaction_plus'])
    expect(events[1].delta).toBeCloseTo(BOOST * (1 / (1 + Math.log(2))) * (1 / (1 + Math.log(2))), 3)
  })

  it('the daily limit on minus reactions from one participant', async () => {
    await h.send(message({ id: 1500, from: BOB, text: 'привет' }))
    await setKarma(h, BOB.id, 5)
    for (let i = 0; i < 7; i++) {
      await h.send(message({ id: 2000 + i, from: CAROL, text: `сообщение ${i}` }))
      await h.send(reaction({ message_id: 2000 + i, from: BOB, new: ['👎'] }))
    }
    const rows = await h.db.query(`SELECT count(*)::int AS n FROM reactions WHERE actor_id = $1 AND awarded < 0`, [BOB.id])
    expect(rows[0].n).toBe(5)
  })

  it('an anonymous admin (actor chat) reaction is counted with a zero-karma voter', async () => {
    await h.send(reaction({ message_id: 1000, actor_chat: CHAT, new: ['👍'] }))
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(BOOST, 4)
    const rows = await h.db.query(`SELECT actor_kind FROM reactions WHERE message_id = 1000`)
    expect(rows).toEqual([{ actor_kind: 'chat' }])
  })

  it('the pair factor lowers repeated reactions from one person to another', async () => {
    await h.send(message({ id: 1001, from: ALICE, text: 'второе' }))
    await h.send(reaction({ message_id: 1000, from: BOB, new: ['👍'] }))
    await h.send(reaction({ message_id: 1001, from: BOB, new: ['👍'] }))
    const events = await eventsOf(h, ALICE.id)
    expect(events[0].delta).toBe(1.05)
    expect(events[1].delta).toBeCloseTo(BOOST / (1 + Math.log(2)), 3)
  })
})

describe('T-anon-reaction: reaction counters', () => {
  it('awards the difference against the last snapshot and refunds on a decrease', async () => {
    await h.send(reactionCount({ message_id: 1000, counts: { '👍': 2 }, date: '2026-09-01T12:01:00Z' }))
    const first = 1.05 * (1 + 1 / (1 + Math.log(2)))
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(first, 3)
    await h.send(reactionCount({ message_id: 1000, counts: { '👍': 2 }, date: '2026-09-01T12:02:00Z' }))
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(first, 3)
    await h.send(reactionCount({ message_id: 1000, counts: { '👍': 5 }, date: '2026-09-01T11:00:00Z' }))
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(first, 3)
    await h.send(reactionCount({ message_id: 1000, counts: { '👍': 1 }, date: '2026-09-01T12:03:00Z' }))
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(first / 2, 3)
    await h.send(reactionCount({ message_id: 1000, counts: {}, date: '2026-09-01T12:04:00Z' }))
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(0, 3)
  })

  it('minus and ignored kinds in counters', async () => {
    await h.send(reactionCount({ message_id: 1000, counts: { '👎': 1, '💩': 3 }, date: '2026-09-01T12:01:00Z' }))
    expect(await karmaOf(h, ALICE.id)).toBe(-1)
  })
})

describe('T-unknown-msg and T-karma-atomic', () => {
  it('a reaction to an unknown message is dropped without an error', async () => {
    await h.send(reaction({ message_id: 424242, from: BOB, new: ['👍'] }))
    expect(await h.db.query('SELECT 1 FROM karma_events')).toEqual([])
  })

  it('the event and the cached value are written in one transaction', async () => {
    await h.db.query(`CREATE FUNCTION fail_karma() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql`)
    await h.db.query(`CREATE TRIGGER fail_karma BEFORE UPDATE ON members FOR EACH ROW WHEN (NEW.karma IS DISTINCT FROM OLD.karma) EXECUTE FUNCTION fail_karma()`)
    const update = reaction({ message_id: 1000, from: BOB, new: ['👍'] })
    await expect(h.send(update)).rejects.toThrow('boom')
    expect(await h.db.query('SELECT 1 FROM karma_events')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM processed_updates WHERE update_id = $1', [update.update_id])).toEqual([])
    await h.db.query('DROP TRIGGER fail_karma ON members')
    await h.send(update)
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(BOOST, 4)
    expect(T0).toBeTruthy()
  })
})
