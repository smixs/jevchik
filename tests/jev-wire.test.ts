import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpJevClient } from '../src/adapters/jev.js'
import { JevError } from '../src/ports.js'
import { fitRequest, estimateTokens, TOKENS_PER_REQUEST, TOKENS_STATE_AND_QUESTION, TRUNCATION_MARK, buildRequest, selectQuestions, fits } from '../src/jev/state.js'
import { changeSetting, loadDefaultQuestions } from '../src/settings/settings.js'
import { fakeServer, reply, type Fake } from './support/http.js'
import { ALICE, BOB, CAROL, CHAT, botJoined, createHarness, karmaOf, message, restartHarness, type Harness } from './support/harness.js'

const questions = JSON.parse(readFileSync(new URL('../eval/questions.json', import.meta.url), 'utf8'))
/** The four spam questions of section 3.6.0. */
const SPAM_QUESTIONS = {
  spam_earnings_crypto: {
    type: 'noul',
    instructions: 'Judge `message` in its context: `replied_to`, `previous_messages` and `sender_history`. Does `message` invite readers to earn, invest, trade, gamble or receive easy money, without the conversation leading to it?',
    criteria: {
      true: 'An offer of income, investment, trading, betting or a giveaway with a way to join, that does not answer anything in `replied_to` or `previous_messages`, typically from a sender with no history in the chat.',
      false: 'The message answers a question or continues the topic of `replied_to` or `previous_messages`; or it talks about prices, payments, tokens, deposits or crypto as part of the conversation; or it is a joke. A long-standing member sharing how they pay or earn is NOT spam.',
    },
  },
  spam_topic_pivot: {
    type: 'noul',
    instructions: 'Judge `message` in its context: `replied_to`, `previous_messages` and `sender_history`. Does `message` use the conversation only as a pretext to promote something of the sender\'s own?',
    criteria: {
      true: 'A short on-topic remark followed by a pitch unrelated to what was asked, typically from a sender with no history in the chat: a referral or promo link, an invitation to a paid service.',
      false: 'The message answers the question asked in `replied_to` or `previous_messages`, even with a link, a price, a referral or a product name; or a member shares a tool, a deal or a finding with the chat. Helping someone who asked is NOT promotion.',
    },
  },
  spam_channel_bait: {
    type: 'noul',
    instructions: 'Judge `message` in its context: `replied_to`, `previous_messages` and `sender_history`. Does `message` lure readers out of the chat to a channel, group, bot, profile or private messages for the sender\'s promotion?',
    criteria: {
      true: 'Out of nowhere it tells readers to subscribe, join, start a bot, open a profile or write in private to get an offer, and nothing in the conversation asked for it.',
      false: 'Continuing a conversation in private with someone who asked, offering or asking for help, a joke such as \'like and subscribe\', praise, news, reposts of useful material and links to sources are NOT luring.',
    },
  },
  spam_other_offer: {
    type: 'noul',
    instructions: 'Judge `message` in its context: `replied_to`, `previous_messages` and `sender_history`. Is `message` an advertisement dropped into the chat by an outsider?',
    criteria: {
      true: 'A sales or adult text unrelated to the conversation around it, from a sender with little or no history in the chat.',
      false: 'A member with history in the chat who shares a deal, a purchase, a price, a list of tools or a project, asks for paid help, or answers a question is NOT advertising, even when the text looks commercial.',
    },
  },
}
let h: Harness
let server: Fake | null = null

beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await server?.close()
  server = null
  await h.close()
})

async function useServer(responder: Parameters<typeof fakeServer>[0]): Promise<void> {
  server = await fakeServer(responder)
  h.ctx.jev = new HttpJevClient('KEY-1', `${server.url}/v1/systemone`, 2000)
}

const okBody = { answers: { usefulness: { type: 'score', score: 1, confidence: 0.5 } }, usage: { input_tokens: 10 } }

describe('the Jev request on the wire', () => {
  it('is a POST with a bearer key and a JSON body equal to the literal request, model pinned', async () => {
    await useServer((_s, _i, res) => reply(res, 200, okBody))
    await h.send(message({ id: 1, from: ALICE, text: 'привет' }))
    await h.app.settle()
    expect(server!.seen).toHaveLength(1)
    const seen = server!.seen[0]
    expect([seen.method, seen.url, seen.headers.authorization, seen.headers['content-type']]).toEqual(['POST', '/v1/systemone', 'Bearer KEY-1', 'application/json'])
    const { appeal_genuine: _a, media_fits: _m, ...asked } = questions
    expect(JSON.parse(seen.body)).toEqual({
      state: {
        message: 'привет',
        replied_to: null,
        previous_messages: [],
        sender_history: 'first message of this sender in the chat',
        media_description: null,
        sender_profile: { name: 'Alice', username: 'alice', bio: null },
      },
      model: 'jev-1.13.0',
      questions: asked,
    })
    expect(Object.keys(JSON.parse(seen.body)).sort()).toEqual(['model', 'questions', 'state'])
    expect(Object.keys(JSON.parse(seen.body).state)).toEqual(['message', 'replied_to', 'previous_messages', 'sender_history', 'media_description', 'sender_profile'])
  })

  it('F28: a member with history: sender_history counts earlier messages (imported too) and days, eight previous lines', async () => {
    await useServer((_s, _i, res) => reply(res, 200, okBody))
    // An imported message of Alice: counted by sender_history, it has no excerpt and gives no previous line.
    await h.send(botJoined())
    await h.db.query(`INSERT INTO members (chat_id, user_id, display_name, username, created_at) VALUES ($1,1,'Alice','alice',$2) ON CONFLICT DO NOTHING`, [CHAT, h.clock.now()])
    await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at) VALUES ($1, 5, 1, '2026-08-20T12:00:00Z')`, [CHAT])
    const lines: Array<[number, typeof ALICE, string]> = [
      [10, ALICE, 'раз'], [11, BOB, 'два'], [12, CAROL, 'три'], [13, ALICE, 'четыре'], [14, BOB, 'пять'],
      [15, CAROL, 'шесть'], [16, BOB, 'семь'], [17, ALICE, 'восемь'], [18, CAROL, 'девять'],
    ]
    for (const [id, from, text] of lines) await h.send(message({ id, from, text, date: '2026-08-30T10:00:00Z' }))
    await h.send(message({ id: 20, from: ALICE, text: 'итог', reply_to: { message_id: 18, from: CAROL, text: 'девять' } }))
    await h.app.settle()
    const { appeal_genuine: _a, media_fits: _m, profile_promo: _p, ...asked } = questions
    expect(JSON.parse(server!.seen.at(-1)!.body)).toEqual({
      state: {
        message: 'итог',
        replied_to: 'Carol: девять',
        previous_messages: ['Bob: два', 'Carol: три', 'Alice: четыре', 'Bob: пять', 'Carol: шесть', 'Bob: семь', 'Alice: восемь', 'Carol: девять'],
        sender_history: 'member of the chat, 4 earlier messages over 12 days',
        media_description: null,
        sender_profile: null,
      },
      model: 'jev-1.13.0',
      questions: asked,
    })
  })

  it('F28: the four spam questions judge by context, in the words of the lead, and reach a connected chat from the file', async () => {
    await useServer((_s, _i, res) => reply(res, 200, okBody))
    await h.send(botJoined())
    await changeSetting(h.db, { chatId: CHAT, key: 'digest_enabled', value: false, baseVersion: 0, actor: 1, now: h.clock.now() })
    await h.send(message({ id: 1, from: ALICE, text: 'привет' }))
    await h.app.settle()
    expect(await h.db.query(`SELECT 1 FROM chat_settings WHERE key = 'questions'`)).toEqual([])
    const sent = JSON.parse(server!.seen[0].body).questions
    const spam = ['spam_earnings_crypto', 'spam_topic_pivot', 'spam_channel_bait', 'spam_other_offer'].map((name) => [name, sent[name]])
    expect(Object.fromEntries(spam)).toEqual(SPAM_QUESTIONS)
  })

  it('an alias is never sent', async () => {
    await useServer((_s, _i, res) => reply(res, 200, okBody))
    await h.send(message({ id: 1, from: ALICE, text: 'привет' }))
    await h.app.settle()
    expect(server!.seen[0].body).not.toMatch(/jev-latest|jev-preview/)
  })
})

describe('Jev failures', () => {
  it('T-jev-reject: 400, 401, 422 are not repeated, are logged with the body, and lead to no sanction', async () => {
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = []
    h.ctx.log = { info: () => {}, warn: () => {}, error: (event, fields) => logs.push({ event, fields }) }
    for (const status of [400, 401, 422]) {
      await useServer((_s, _i, res) => reply(res, status, { error: `bad ${status}` }))
      await h.send(message({ id: status, from: { id: status, first_name: 'U' }, text: `текст ${status}` }))
      await h.app.settle()
      expect(server!.seen).toHaveLength(1)
      await server!.close()
    }
    server = null
    expect((await h.db.query('SELECT status FROM evaluations ORDER BY message_id')).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(logs.filter((l) => l.event === 'jev_rejected').map((l) => [l.fields?.status, l.fields?.body])).toEqual([[400, '{"error":"bad 400"}'], [401, '{"error":"bad 401"}'], [422, '{"error":"bad 422"}']])
    for (const method of ['deleteMessage', 'restrictChatMember', 'banChatMember']) expect(h.tg.count(method)).toBe(0)
  })

  it('T-jev-down: 5xx and network errors are retried up to three attempts in total, then "not processed", no sanction', async () => {
    await useServer((_s, _i, res) => reply(res, 503, 'down'))
    await h.send(message({ id: 1, from: ALICE, text: 'привет' }))
    for (let i = 0; i < 6; i++) {
      await h.app.settle()
      h.clock.advance(10_000)
    }
    expect(server!.seen).toHaveLength(3)
    expect((await h.db.query('SELECT status, attempt_count FROM evaluations'))[0]).toEqual({ status: 'unprocessed', attempt_count: 3 })
    const dead = new HttpJevClient('K', 'http://127.0.0.1:1/v1/systemone', 500)
    await expect(dead.evaluate({ state: {}, model: 'm', questions: {} })).rejects.toMatchObject({ kind: 'transient' })
  })

  it('T-jev-down: a hanging server hits the timeout and counts as an attempt', async () => {
    const hang = await fakeServer(() => {})
    const client = new HttpJevClient('K', `${hang.url}/x`, 100)
    await expect(client.evaluate({ state: {}, model: 'm', questions: {} })).rejects.toMatchObject({ kind: 'transient' })
    await hang.close().catch(() => {})
  })

  it('T-jev-429: waits retry-after, keeps the order inside the chat, survives a restart, ends as "not processed" after three attempts', async () => {
    const hits: string[] = []
    await useServer((seen, _i, res) => {
      const text = JSON.parse(seen.body).state.message as string
      hits.push(text)
      if (text === 'первое') return reply(res, 429, 'slow down', { 'retry-after': '20' })
      reply(res, 200, okBody)
    })
    await h.send(message({ id: 1, from: ALICE, text: 'первое' }))
    await h.send(message({ id: 2, from: ALICE, text: 'второе' }))
    await h.app.settle()
    expect(hits).toEqual(['первое'])
    h.clock.advance(19_000)
    await h.app.settle()
    expect(hits).toEqual(['первое'])
    h = await restartHarness(h)
    h.ctx.jev = new HttpJevClient('KEY-1', `${server!.url}/v1/systemone`, 2000)
    h.clock.advance(2000)
    await h.app.settle()
    expect(hits).toEqual(['первое', 'первое'])
    h.clock.advance(21_000)
    await h.app.settle()
    expect(hits).toEqual(['первое', 'первое', 'первое', 'второе'])
    expect((await h.db.query('SELECT message_id, status FROM evaluations ORDER BY message_id')).map((r) => [r.message_id, r.status])).toEqual([[1, 'unprocessed'], [2, 'done']])
  })

  it('T-jev-garbage: malformed answers are "no data", not zero, and lead to no sanction and no karma', async () => {
    await h.send(botJoined())
    h.clock.advance(8 * 86_400_000)
    const bodies = ['not json at all', '[]', '{}', '{"answers":{"spam_other_offer":{"type":"noul","noul":"high"},"usefulness":{"type":"score","score":"lots"},"tone":{"type":"choice"},"rude":{"type":"noul","noul":7},"is_flood":null}}', '{"answers":{"spam_other_offer":{"type":"score","score":3}}}']
    for (const [i, body] of bodies.entries()) {
      await useServer((_s, _n, res) => reply(res, 200, body))
      await h.send(message({ id: 10 + i, from: { id: 40 + i, first_name: `U${i}` }, text: `сообщение ${i}` }))
      await h.app.settle()
      await server!.close()
    }
    server = null
    expect((await h.db.query('SELECT status FROM evaluations ORDER BY message_id')).every((r) => r.status === 'done')).toBe(true)
    for (const method of ['deleteMessage', 'restrictChatMember', 'banChatMember']) expect(h.tg.count(method)).toBe(0)
    expect(await h.db.query('SELECT 1 FROM karma_events')).toEqual([])
    const facts = (await h.db.query('SELECT facts FROM messages ORDER BY message_id')).map((r) => r.facts)
    for (const f of facts) expect([f.spam, f.level, f.rude, f.tone]).toEqual([null, null, null, null])
  })

  it('a missing answer to one question is "no data" for that question only', async () => {
    await useServer((_s, _i, res) => reply(res, 200, { answers: { usefulness: { type: 'score', score: 3.4, confidence: 0.8 } } }))
    await h.send(message({ id: 1, from: ALICE, text: 'привет' }))
    await h.app.settle()
    const facts = (await h.db.query('SELECT facts FROM messages'))[0].facts
    expect([facts.level, facts.spam, facts.isAnswer]).toEqual([3, null, null])
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(0.25 * 1.05, 4)
  })
})

describe('T-jev-long: the size limits of section 3.5', () => {
  const qs = selectQuestions(loadDefaultQuestions(), { hasProfile: true, hasMedia: true, hasReply: true })
  const base = { message: 'сообщение', replied_to: 'Bob: ответ на что-то', previous_messages: ['a: раз', 'b: два', 'c: три'], sender_history: null, media_description: 'photo: cat', sender_profile: { name: 'A', username: null, bio: 'bio' } }

  it('the token estimate is the number of characters divided by two', () => {
    expect(estimateTokens('a'.repeat(100))).toBe(Math.ceil(102 / 2))
  })

  it('a normal request is untouched', () => {
    const fitted = fitRequest(base, qs)!
    expect(fitted.truncated).toBe(false)
    expect(fitted.request.state).toEqual(base)
  })

  it('cuts older previous messages first, oldest before newest', () => {
    const state = { ...base, previous_messages: ['1' + 'x'.repeat(30_000), '2' + 'x'.repeat(30_000), '3' + 'x'.repeat(30_000)] }
    const fitted = fitRequest(state, qs)!
    expect(fitted.truncated).toBe(true)
    const kept = (fitted.request.state.previous_messages as string[]).map((m) => m[0])
    expect(kept.length).toBeLessThan(3)
    if (kept.length) expect(kept.at(-1)).toBe('3')
    expect(fitted.request.state.replied_to).toBe(base.replied_to)
  })

  it('then replied_to, media_description, sender_profile, and only then the message', () => {
    const order: string[] = []
    const shapes = [
      { ...base, previous_messages: [], replied_to: 'r'.repeat(70_000) },
      { ...base, previous_messages: [], replied_to: null, media_description: 'm'.repeat(70_000) },
      { ...base, previous_messages: [], replied_to: null, media_description: null, sender_profile: { name: 'A', username: null, bio: 'p'.repeat(70_000) } },
    ]
    for (const state of shapes) {
      const s = fitRequest(state, qs)!.request.state
      order.push([s.replied_to, s.media_description, s.sender_profile].map((v) => (v === null ? 'null' : 'kept')).join('/'))
      expect(s.message).toBe('сообщение')
    }
    expect(order).toEqual(['null/kept/kept', 'null/null/kept', 'null/null/null'])
  })

  it('F28: sender_history goes together with sender_profile, after media_description and before the message', () => {
    const history = 'member of the chat, 4 earlier messages over 12 days'
    const kept = fitRequest({ ...base, previous_messages: [], replied_to: null, media_description: null, sender_history: 'h'.repeat(70_000) }, qs)!.request.state
    expect([kept.sender_history, kept.sender_profile, kept.message]).toEqual([null, null, 'сообщение'])
    const small = fitRequest({ ...base, sender_history: history, media_description: 'm'.repeat(70_000) }, qs)!.request.state
    expect([small.media_description, small.sender_history, small.sender_profile]).toEqual([null, history, base.sender_profile])
    const alone = fitRequest({ ...base, previous_messages: [], replied_to: null, media_description: null, sender_profile: null, sender_history: history, message: 'я'.repeat(70_000) }, qs)!.request.state
    expect(alone.sender_history).toBeNull()
    expect((alone.message as string).endsWith(TRUNCATION_MARK)).toBe(true)
  })

  it('the message itself is truncated last, with a marker, and both limits hold', () => {
    const fitted = fitRequest({ ...base, message: 'я'.repeat(200_000) }, qs)!
    const message = fitted.request.state.message as string
    expect(message.endsWith(TRUNCATION_MARK)).toBe(true)
    expect(fitted.request.state).toMatchObject({ previous_messages: [], replied_to: null, media_description: null, sender_profile: null })
    expect(estimateTokens(fitted.request)).toBeLessThanOrEqual(TOKENS_PER_REQUEST)
    const longest = Math.max(...Object.values(qs).map((q) => estimateTokens(q)))
    expect(estimateTokens(fitted.request.state) + longest).toBeLessThanOrEqual(TOKENS_STATE_AND_QUESTION)
    expect(fits(fitted.request)).toBe(true)
  })

  it('a long question reduces the room for the state (the second limit)', () => {
    const big = { ...qs, huge: { type: 'noul', instructions: 'q'.repeat(40_000) } }
    const fitted = fitRequest({ ...base, message: 'я'.repeat(60_000) }, big)!
    const longest = Math.max(...Object.values(big).map((q) => estimateTokens(q)))
    expect(estimateTokens(fitted.request.state) + longest).toBeLessThanOrEqual(TOKENS_STATE_AND_QUESTION)
    expect((fitted.request.state.message as string).endsWith(TRUNCATION_MARK)).toBe(true)
  })

  it('when even the smallest request does not fit there is no call, and context_too_large is logged', async () => {
    const monster = { ...loadDefaultQuestions(), monster: { type: 'noul', instructions: 'z'.repeat(70_000) } }
    expect(fitRequest(base, monster)).toBeNull()
    await h.send(botJoined())
    await changeSetting(h.db, { chatId: CHAT, key: 'questions', value: monster, baseVersion: 0, actor: 1, now: h.clock.now() })
    const logs: string[] = []
    h.ctx.log = { info: () => {}, warn: () => {}, error: (event) => logs.push(event) }
    await h.send(message({ id: 1, from: BOB, text: 'привет' }))
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(0)
    expect(logs).toContain('context_too_large')
    expect((await h.db.query('SELECT status FROM evaluations'))[0].status).toBe('context_too_large')
    expect(h.tg.count('deleteMessage')).toBe(0)
  })

  it('a 4096-character message fits without truncation', async () => {
    await h.send(message({ id: 1, from: CAROL, text: 'а'.repeat(4096) }))
    await h.app.settle()
    expect(h.jev.requests[0].state.message).toBe('а'.repeat(4096))
  })

  it('buildRequest keeps the fixed key order', () => {
    expect(Object.keys(buildRequest(base, qs))).toEqual(['state', 'model', 'questions'])
  })

  it('a garbage error kind is still a JevError with the body kept for the log', () => {
    const error = new JevError('reject', 'x', { status: 400, body: 'body' })
    expect([error.kind, error.status, error.body]).toEqual(['reject', 400, 'body'])
  })
})
