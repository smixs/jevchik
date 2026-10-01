import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pickSignal, LADDER, type Candidates } from '../src/ladder.js'
import { voterWeight } from '../src/formulas.js'
import { ALICE, BOB, createHarness, edited, eventsOf, karmaOf, message, type Harness } from './support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  await h.send(message({ id: 1000, from: ALICE, text: 'Как настроить X?' }))
  await h.app.settle()
})
afterEach(async () => {
  await h.close()
})

const none: Candidates = { mediaReply: false, mediaFits: false, rudeBlocked: false, hasQuote: false, dialog: false, thanks: false }

describe('F5: the ladder of signals', () => {
  it('the order of value is reaction < reply < quote < dialog < thanks', () => {
    expect(LADDER).toEqual(['reaction', 'reply', 'quote', 'dialog', 'thanks'])
    expect(pickSignal(none)).toBe('reply')
    expect(pickSignal({ ...none, hasQuote: true })).toBe('quote')
    expect(pickSignal({ ...none, hasQuote: true, dialog: true })).toBe('dialog')
    expect(pickSignal({ ...none, hasQuote: true, dialog: true, thanks: true })).toBe('thanks')
    expect(pickSignal({ ...none, mediaReply: true, mediaFits: true })).toBe('reaction')
    expect(pickSignal({ ...none, mediaReply: true, mediaFits: false })).toBeNull()
    expect(pickSignal({ ...none, rudeBlocked: true, hasQuote: true, dialog: true })).toBeNull()
  })

  it('a reply gives the reply signal to the author of the original', async () => {
    await h.send(message({ id: 1001, from: BOB, text: 'Вот так', reply_to: { message_id: 1000, from: ALICE } }))
    await h.app.settle()
    expect(await eventsOf(h, ALICE.id)).toEqual([{ delta: 2.1, reason: 'ladder_reply' }])
  })

  it('a quote is worth more than a plain reply', async () => {
    await h.send(message({ id: 1001, from: BOB, text: 'Вот так', quote: true, reply_to: { message_id: 1000, from: ALICE } }))
    await h.app.settle()
    expect(await eventsOf(h, ALICE.id)).toEqual([{ delta: 3.15, reason: 'ladder_quote' }])
  })

  it('thanks is the most expensive signal', async () => {
    h.jev.script('Спасибо огромное!', { is_thanks: 0.9 })
    await h.send(message({ id: 1001, from: BOB, text: 'Спасибо огромное!', quote: true, reply_to: { message_id: 1000, from: ALICE } }))
    await h.app.settle()
    expect(await eventsOf(h, ALICE.id)).toEqual([{ delta: 6.3, reason: 'ladder_thanks' }])
  })

  it('a dialog: the author answers a direct reply within 24 hours; the reply author is credited', async () => {
    await h.send(message({ id: 1001, from: BOB, text: 'Вот так', reply_to: { message_id: 1000, from: ALICE } }))
    await h.app.settle()
    await h.send(message({ id: 1002, from: ALICE, text: 'Понял, а дальше?', date: '2026-09-01T20:00:00Z', reply_to: { message_id: 1001, from: BOB } }))
    await h.app.settle()
    const events = await eventsOf(h, BOB.id)
    expect(events).toHaveLength(1)
    expect(events[0].reason).toBe('ladder_dialog')
    expect(events[0].delta).toBeCloseTo(4 * voterWeight(2.1, 100) * 1.05, 3)
  })

  it('after 24 hours the same answer is only a reply', async () => {
    await h.send(message({ id: 1001, from: BOB, text: 'Вот так', reply_to: { message_id: 1000, from: ALICE } }))
    await h.app.settle()
    await h.send(message({ id: 1002, from: ALICE, text: 'Понял, спасибо не скажу', date: '2026-09-02T13:00:01Z', reply_to: { message_id: 1001, from: BOB } }))
    await h.app.settle()
    expect((await eventsOf(h, BOB.id)).map((e) => e.reason)).toEqual(['ladder_reply'])
  })

  it('a cheaper signal is replaced by a more expensive one on edit: compensation, then a new accrual', async () => {
    await h.send(message({ id: 1001, from: BOB, text: 'Вот так', reply_to: { message_id: 1000, from: ALICE } }))
    await h.app.settle()
    h.jev.script('Вот так, спасибо!', { is_thanks: 0.9 })
    await h.send(edited({ id: 1001, from: BOB, text: 'Вот так, спасибо!', edit_date: '2026-09-01T12:10:00Z', reply_to: { message_id: 1000, from: ALICE } }))
    await h.app.settle()
    expect(await eventsOf(h, ALICE.id)).toEqual([
      { delta: 2.1, reason: 'ladder_reply' },
      { delta: -2.1, reason: 'ladder_undo' },
      { delta: 6.3, reason: 'ladder_thanks' },
    ])
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(6.3, 4)
  })

  it('a rude serious reply counts neither as a reply nor as a dialog', async () => {
    h.jev.script('Сам дурак', { rude: 0.95, tone: { choice: 'serious' } })
    await h.send(message({ id: 1001, from: BOB, text: 'Сам дурак', reply_to: { message_id: 1000, from: ALICE } }))
    await h.app.settle()
    expect(await eventsOf(h, ALICE.id)).toEqual([])
  })

  it('rudeness with a joking tone does not block the reply', async () => {
    h.jev.script('Ну ты даёшь', { rude: 0.95, tone: { choice: 'joke' } })
    await h.send(message({ id: 1001, from: BOB, text: 'Ну ты даёшь', reply_to: { message_id: 1000, from: ALICE } }))
    await h.app.settle()
    expect((await eventsOf(h, ALICE.id)).map((e) => e.reason)).toEqual(['ladder_reply'])
  })

  it('no credit for a reply to yourself or to a bot', async () => {
    await h.send(message({ id: 1001, from: ALICE, text: 'Сам себе', reply_to: { message_id: 1000, from: ALICE } }))
    await h.send(message({ id: 1002, from: BOB, text: 'Боту', reply_to: { message_id: 5, from: { id: 777, first_name: 'Bot', is_bot: true } } }))
    await h.app.settle()
    expect(await eventsOf(h, ALICE.id)).toEqual([])
    expect(await h.db.query('SELECT 1 FROM karma_events')).toEqual([])
  })

  it('a sticker that Jev judged fitting is a reaction; without a description it gives nothing', async () => {
    const sticker = { sticker: { file_id: 'st1', file_unique_id: 'u1', emoji: '😂', is_animated: false, is_video: false, width: 1, height: 1, type: 'regular' } }
    h.jev.script('', { media_fits: 0.9 })
    await h.send(message({ id: 1001, from: BOB, reply_to: { message_id: 1000, from: ALICE }, extra: sticker }))
    await h.app.settle()
    expect(await eventsOf(h, ALICE.id)).toEqual([{ delta: 1.05, reason: 'ladder_reaction' }])
    await h.close()
    h = await createHarness({ vision: false })
    await h.send(message({ id: 1000, from: ALICE, text: 'Как настроить X?' }))
    await h.send(message({ id: 1001, from: BOB, reply_to: { message_id: 1000, from: ALICE }, extra: sticker }))
    await h.app.settle()
    expect(await eventsOf(h, ALICE.id)).toEqual([])
  })
})
