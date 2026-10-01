import { describe, expect, it } from 'vitest'
import { decide, type DecideInput } from '../src/sanctions.js'

const base: DecideInput = {
  karma: 0, isFirst: false, judged: true, newcomer: true, probation: false, spam: 0, profilePromo: null,
  auto: 0.9, profileAuto: 0.8, reviewDelete: 0.3, review: 0.3, protect: 100,
}
const run = (over: Partial<DecideInput>) => decide({ ...base, ...over })

describe('section 3.6: rules applied top to bottom, the first match ends the analysis', () => {
  it('rule 1 is gone: observation mode does not touch spam (section 3.6.3); decide ignores a claim of observation', () => {
    const observing = { ...base, observing: true } as unknown as DecideInput
    expect(decide({ ...observing, isFirst: true, spam: 0.95 })).toEqual({ rule: 3, action: 'steam' })
    expect(decide({ ...observing, spam: 0.35 })).toEqual({ rule: 5, action: 'card_review' })
  })

  it('rule 2 comes before rules 3 and 4 for protected participants, for text and for profile', () => {
    expect(run({ karma: 100, isFirst: true, spam: 0.99 })).toEqual({ rule: 2, action: 'card_protected' })
    expect(run({ karma: 100, isFirst: true, spam: 0, profilePromo: 0.95 })).toEqual({ rule: 2, action: 'card_protected' })
    expect(run({ karma: 100, spam: 0.3 })).toEqual({ rule: 2, action: 'card_protected' })
    expect(run({ karma: 100, spam: 0.29 })).toEqual({ rule: 6, action: 'none' })
    expect(run({ karma: 99.99, isFirst: true, spam: 0.99 }).action).toBe('steam')
  })

  it('rule 3 (section 3.6.2): any judged message with spam >= 0.90, or profile promo >= 0.80 on the first message', () => {
    expect(run({ isFirst: true, spam: 0.9 })).toEqual({ rule: 3, action: 'steam' })
    expect(run({ isFirst: true, spam: 0.89 })).toEqual({ rule: 5, action: 'card_review' })
    expect(run({ isFirst: true, spam: 0, profilePromo: 0.8 })).toEqual({ rule: 3, action: 'steam' })
    expect(run({ isFirst: true, spam: 0, profilePromo: 0.79 })).toEqual({ rule: 6, action: 'none' })
    expect(run({ isFirst: false, spam: 0.99 })).toEqual({ rule: 3, action: 'steam' })
    expect(run({ isFirst: false, spam: 0, profilePromo: 0.99 })).toEqual({ rule: 6, action: 'none' })
  })

  it('rule 4 (delete from 0.50) is cancelled: from 0.30 up to 0.90 only a card; below 0.30 nothing', () => {
    expect(run({ spam: 0.5 }).action).toBe('card_review')
    expect(run({ spam: 0.8999 }).action).toBe('card_review')
    expect(run({ spam: 0.3 }).action).toBe('card_review')
    expect(run({ spam: 0.2999 }).action).toBe('none')
  })

  it('no data (null) is not a value: nothing happens', () => {
    expect(run({ spam: null, profilePromo: null, isFirst: true })).toEqual({ rule: 6, action: 'none' })
    expect(run({ spam: null, karma: 500 })).toEqual({ rule: 6, action: 'none' })
  })

  it('probation keeps its lowered delete threshold (section 3.6); nobody else is deleted below 0.90', () => {
    expect(run({ spam: 0.35, probation: true }).action).toBe('delete_card')
    expect(run({ spam: 0.29, probation: true }).action).toBe('none')
    expect(run({ spam: 0.35 }).action).toBe('card_review')
  })
})

describe('section 3.6.0: the text is judged only for a newcomer', () => {
  it('rules 3, 4 and 5 by text do not apply to a member who is not judged', () => {
    for (const spam of [0.3, 0.5, 0.8, 1]) {
      expect(run({ judged: false, spam })).toEqual({ rule: 6, action: 'none' })
      expect(run({ judged: false, isFirst: true, spam })).toEqual({ rule: 6, action: 'none' })
    }
  })

  it('rule 2 makes no card for a member who is not judged', () => {
    expect(run({ judged: false, newcomer: false, karma: 100, spam: 0.9 })).toEqual({ rule: 6, action: 'none' })
    expect(run({ judged: false, newcomer: false, karma: 100, isFirst: true, profilePromo: 0.9 })).toEqual({ rule: 6, action: 'none' })
    expect(run({ judged: true, karma: 100, spam: 0.3 })).toEqual({ rule: 2, action: 'card_protected' })
  })

  it('spec 3.6.0: the profile rule applies to a newcomer only, probation or not', () => {
    expect(run({ judged: false, newcomer: false, isFirst: true, profilePromo: 0.95 })).toEqual({ rule: 6, action: 'none' })
    expect(run({ judged: true, newcomer: false, probation: true, isFirst: true, profilePromo: 0.95 })).toEqual({ rule: 6, action: 'none' })
    expect(run({ newcomer: true, isFirst: true, profilePromo: 0.8 })).toEqual({ rule: 3, action: 'steam' })
    expect(run({ newcomer: true, isFirst: false, profilePromo: 0.95 })).toEqual({ rule: 6, action: 'none' })
  })
})
