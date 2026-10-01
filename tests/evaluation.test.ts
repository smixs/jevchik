import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JevError } from '../src/ports.js'
import { ALICE, BOB, CHAT, createHarness, edited, karmaOf, message, T0, type Harness } from './support/harness.js'
import { jevDown } from './support/fakes.js'

const questions = JSON.parse(readFileSync(new URL('../eval/questions.json', import.meta.url), 'utf8')) as Record<string, { type: string }>

let h: Harness
beforeAll(async () => {
  h = await createHarness()
})
afterAll(async () => {
  await h.close()
})

describe('F2: one message, one evaluation, one wire request', () => {
  it('sends the exact request from section 3.5', async () => {
    await h.send(message({ id: 501, text: 'Привет, кто пробовал jev?' }))
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(1)
    const { appeal_genuine: _appeal, media_fits: _media, ...asked } = questions
    expect(h.jev.requests[0]).toEqual({
      state: {
        message: 'Привет, кто пробовал jev?',
        replied_to: null,
        previous_messages: [],
        sender_history: 'first message of this sender in the chat',
        media_description: null,
        sender_profile: { name: 'Alice', username: 'alice', bio: null },
      },
      model: 'jev-1.13.0',
      questions: asked,
    })
    expect(Object.entries(h.jev.requests[0].questions).map(([k, v]) => [k, (v as { type: string }).type]).sort()).toEqual([
      ['help_type', 'choice'],
      ['is_answer', 'noul'],
      ['is_flood', 'noul'],
      ['is_question', 'noul'],
      ['is_thanks', 'noul'],
      ['profile_promo', 'noul'],
      ['rude', 'noul'],
      ['spam_channel_bait', 'noul'],
      ['spam_earnings_crypto', 'noul'],
      ['spam_other_offer', 'noul'],
      ['spam_topic_pivot', 'noul'],
      ['tone', 'choice'],
      ['topic', 'choice'],
      ['usefulness', 'score'],
    ])
    const rows = await h.db.query('SELECT evaluation_id, status FROM evaluations WHERE message_id = 501')
    expect(rows).toEqual([{ evaluation_id: `msg:${CHAT}:501:0`, status: 'done' }])
  })

  it('second message of the same author has no profile and no profile question; context lines are included', async () => {
    h.jev.requests.length = 0
    await h.send(message({ id: 502, text: 'Вот ссылка на доку', reply_to: { message_id: 501, from: BOB, text: 'Что почитать?' } }))
    await h.app.settle()
    const request = h.jev.requests[0]
    expect(request.state).toEqual({
      message: 'Вот ссылка на доку',
      replied_to: 'Bob: Что почитать?',
      previous_messages: ['Alice: Привет, кто пробовал jev?'],
      sender_history: 'member of the chat, 1 earlier messages over 0 days',
      media_description: null,
      sender_profile: null,
    })
    expect(Object.keys(request.questions)).not.toContain('profile_promo')
    expect(Object.keys(request.questions)).not.toContain('media_fits')
  })

  it('a duplicate delivery does not create a second evaluation or request', async () => {
    h.jev.requests.length = 0
    const update = message({ id: 503, text: 'Дубль' })
    await h.send(update)
    await h.send(update)
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(1)
    expect(await h.db.query('SELECT 1 FROM evaluations WHERE message_id = 503')).toHaveLength(1)
  })

  it('retries keep the evaluation id and award once', async () => {
    h.jev.requests.length = 0
    h.jev.script('Полезный разбор', { usefulness: { score: 3.2, confidence: 0.8 } })
    h.jev.failures.push(jevDown(), new JevError('rate_limit', 'slow', { status: 429, retryAfter: 2 }))
    await h.send(message({ id: 504, text: 'Полезный разбор', from: BOB }))
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      h.clock.advance(3000)
      await h.app.settle()
    }
    expect(h.jev.requests).toHaveLength(3)
    const rows = await h.db.query('SELECT evaluation_id, status, attempt_count FROM evaluations WHERE message_id = 504')
    expect(rows).toEqual([{ evaluation_id: `msg:${CHAT}:504:0`, status: 'done', attempt_count: 3 }])
    const events = await h.db.query(`SELECT delta FROM karma_events WHERE reason = 'jev_usefulness' AND message_id = 504`)
    expect(events).toEqual([{ delta: 0.25 * 1.05 }])
    expect(await karmaOf(h, BOB.id)).toBeGreaterThan(0)
  })

  it('an edit creates a new evaluation and replaces only the Jev event', async () => {
    h.jev.script('Полезный разбор, дополнено', { usefulness: { score: 4, confidence: 0.9 } })
    await h.send(edited({ id: 504, from: BOB, text: 'Полезный разбор, дополнено', date: T0, edit_date: '2026-09-01T12:05:00Z' }))
    await h.app.settle()
    const rows = await h.db.query(`SELECT delta, reason FROM karma_events WHERE message_id = 504 ORDER BY event_id`)
    expect(rows.map((r) => r.reason)).toEqual(['jev_usefulness', 'jev_undo', 'jev_usefulness'])
    expect(rows[1].delta).toBe(-0.2625)
    expect(rows[2].delta).toBe(0.525)
  })
})

describe('Jev failures never lead to sanctions', () => {
  it('T-jev-down: three transient failures end as unprocessed, no request text is kept', async () => {
    h.jev.failures.push(jevDown(), jevDown(), jevDown())
    await h.send(message({ id: 601, text: 'обычное сообщение', from: ALICE }))
    for (let i = 0; i < 4; i++) {
      await h.app.settle()
      h.clock.advance(10_000)
    }
    const row = (await h.db.query('SELECT status, request FROM evaluations WHERE message_id = 601'))[0]
    expect(row).toEqual({ status: 'unprocessed', request: null })
    expect(h.tg.count('deleteMessage')).toBe(0)
    expect(h.tg.count('restrictChatMember')).toBe(0)
  })
})
