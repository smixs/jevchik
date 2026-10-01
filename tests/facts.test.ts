import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractFacts } from '../src/jev/facts.js'
import { ALICE, createHarness, eventsOf, karmaOf, message, pastObservation, type Harness } from './support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const usefulness = (score: unknown, confidence: unknown) => ({ usefulness: { type: 'score', score, confidence } }) as never

describe('an out-of-range score or confidence is "no data"', () => {
  it('facts', () => {
    for (const [score, confidence] of [[999, 0.9], [-1, 0.9], [4.01, 0.9], [4, 99], [4, -0.1], [4, 'high'], [Number.NaN, 0.5]]) {
      expect(extractFacts(usefulness(score, confidence)), `${score}/${confidence}`).toMatchObject({ level: null, confidence: null })
    }
    expect(extractFacts(usefulness(4, 0.7))).toMatchObject({ level: 4, confidence: 0.7 })
    expect(extractFacts(usefulness(0, 0))).toMatchObject({ level: 0, confidence: 0 })
    expect(extractFacts(usefulness(3.6, 1))).toMatchObject({ level: 4, confidence: 1 })
  })

  it('a garbage score gives no karma and no bot reaction', async () => {
    h.jev.raw = () => ({ answers: usefulness(999, 99) })
    await h.send(message({ id: 1, from: ALICE, text: 'привет' }))
    await h.app.settle()
    expect(await eventsOf(h, ALICE.id)).toEqual([])
    expect(await karmaOf(h, ALICE.id)).toBe(0)
    expect(h.tg.count('setMessageReaction')).toBe(0)
  })
})
