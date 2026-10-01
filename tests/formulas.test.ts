import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { decayStep, messageFactor, pairFactor, reactionDelta, seriesFactor, streakBoost, voterWeight } from '../src/formulas.js'
import { graphemeLength, makeExcerpt, maskName } from '../src/text.js'
import { defaultValues } from '../src/settings/settings.js'

const k = fc.integer({ min: 1, max: 10_000 })

describe('F4: reaction formula', () => {
  it('message_factor and pair_factor decrease with the ordinal', () => {
    fc.assert(
      fc.property(k, fc.integer({ min: 1, max: 1000 }), (a, step) => {
        expect(messageFactor(a + step)).toBeLessThan(messageFactor(a))
        expect(pairFactor(a + step)).toBeLessThan(pairFactor(a))
      }),
    )
  })

  it('voter_weight grows with karma and the growth shrinks', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100_000, noNaN: true }), fc.double({ min: 0.1, max: 1000, noNaN: true }), (x, d) => {
        const first = voterWeight(x + d, 100) - voterWeight(x, 100)
        const second = voterWeight(x + 2 * d, 100) - voterWeight(x + d, 100)
        expect(voterWeight(x + d, 100)).toBeGreaterThan(voterWeight(x, 100))
        expect(second).toBeLessThan(first + 1e-9)
      }),
    )
  })

  it('a hundred successive reactions under one message add up to less than a hundred first reactions', () => {
    fc.assert(
      fc.property(fc.double({ min: -100, max: 100, noNaN: true }), fc.double({ min: 0, max: 5000, noNaN: true }), (base, karma) => {
        let successive = 0
        for (let i = 1; i <= 100; i++) successive += reactionDelta({ base, kMessage: i, kPair: 1, voterKarma: karma, scale: 100 })
        const firsts = 100 * reactionDelta({ base, kMessage: 1, kPair: 1, voterKarma: karma, scale: 100 })
        expect(Math.abs(successive)).toBeLessThanOrEqual(Math.abs(firsts) + 1e-9)
        if (Math.abs(base) > 1e-6) expect(Math.abs(successive)).toBeLessThan(Math.abs(firsts))
      }),
    )
  })

  it('literal values', () => {
    expect(messageFactor(1)).toBe(1)
    expect(messageFactor(Math.E)).toBeCloseTo(0.5, 10)
    expect(voterWeight(0, 100)).toBe(1)
    expect(voterWeight(100, 100)).toBeCloseTo(1 + Math.log(2), 10)
    expect(reactionDelta({ base: 1, kMessage: 1, kPair: 1, voterKarma: 100, scale: 100 })).toBeCloseTo(1.693147, 6)
    expect(reactionDelta({ base: -1, kMessage: 1, kPair: 1, voterKarma: 0, scale: 100 })).toBe(-1)
    expect(seriesFactor(1)).toBe(1)
  })
})

describe('defaults', () => {
  it('the largest Jev accrual per message is strictly below the first positive human reaction', () => {
    const settings = defaultValues()
    const jevMax = Math.max(...(settings.usefulness_points as number[]))
    const firstReaction = reactionDelta({ base: settings.base_reaction as number, kMessage: 1, kPair: 1, voterKarma: 0, scale: settings.voter_scale as number })
    expect(jevMax).toBeLessThan(firstReaction)
  })

  it('literal defaults of section 3.4 and 3.6', () => {
    const s = defaultValues()
    expect([s.base_reaction, s.base_reply, s.base_quote, s.base_dialog, s.base_thanks, s.base_minus]).toEqual([1, 2, 3, 4, 6, -1])
    expect([s.report_author_delta, s.report_reporter_delta, s.voter_scale, s.minus_daily_limit, s.minus_min_karma, s.karma_lower_bound, s.silence_days]).toEqual([-20, 5, 100, 5, 1, -50, 14])
    expect(s.usefulness_points).toEqual([0, 0, 0.1, 0.25, 0.5])
    expect([s.spam_auto_threshold, s.profile_auto_threshold, s.spam_review_delete_threshold, s.spam_review_threshold, s.protect_threshold]).toEqual([0.9, 0.8, 0.5, 0.3, 100])
    expect([s.threshold_is_thanks, s.threshold_is_answer, s.threshold_is_question, s.threshold_is_flood, s.threshold_media_fits, s.threshold_rude, s.previous_messages_count]).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.8, 8])
    expect([s.react_min_level, s.react_min_confidence, s.timezone, s.dialog_window_hours]).toEqual([4, 0.7, 'Asia/Tashkent', 24])
  })
})

describe('F13 formulas', () => {
  it('decay step', () => {
    expect(decayStep(100, -50, 0.1)).toBeCloseTo(90, 10)
    expect(decayStep(10, -50, 0.1)).toBeCloseTo(9, 10)
    expect(decayStep(-48, -50, 0.1)).toBe(-50)
    expect(decayStep(-50, -50, 0.1)).toBe(-50)
  })
  it('series boost: 5% per week, at most 25%', () => {
    expect([0, 1, 3, 5, 9].map((w) => streakBoost(w, 0.05, 0.25))).toEqual([1, 1.05, 1.15, 1.25, 1.25])
  })
})

describe('text helpers', () => {
  it('mask: first grapheme cluster and three stars', () => {
    expect(maskName('Alice')).toBe('A***')
    expect(maskName('Иван Петров')).toBe('И***')
    expect(maskName('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧***')
    expect(maskName('🇺🇿 Uz')).toBe('🇺🇿***')
    expect(maskName('éclair')).toBe('é***')
    expect(maskName('')).toBe('***')
    expect(maskName('שלום')).toBe('ש***')
  })

  it('mask keeps exactly one visible cluster for any name', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', minLength: 1 }), (name) => {
        const masked = maskName(name)
        expect(masked.endsWith('***')).toBe(true)
        expect(graphemeLength(masked)).toBeLessThanOrEqual(4)
      }),
    )
  })

  it('excerpt never exceeds 200 clusters and is a prefix', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 600 }), (text) => {
        const cut = makeExcerpt(text)
        expect(graphemeLength(cut)).toBeLessThanOrEqual(200)
        expect(text.startsWith(cut)).toBe(true)
        if (graphemeLength(text) <= 200) expect(cut).toBe(text)
      }),
    )
  })

  it('T-text-edge: empty, emoji, 4096 characters, right-to-left', () => {
    expect(makeExcerpt('')).toBe('')
    expect(graphemeLength(makeExcerpt('👍🏽'.repeat(300)))).toBe(200)
    expect(graphemeLength(makeExcerpt('a'.repeat(4096)))).toBe(200)
    expect(makeExcerpt('مرحبا بالعالم')).toBe('مرحبا بالعالم')
  })
})
