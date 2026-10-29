import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_PERMISSIONS } from '../src/ops.js'
import { ADMIN, CAROL, CHAT, createHarness, message, pastObservation, type Harness } from './support/harness.js'

const PLAIN = 'да, сейчас строго. в Polzastas был разбор, как люди это решают'
const HIDDEN = 'в этом канале был разбор, как люди это решают'
const REPLY = 'тут был Стас пидорас'
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const chatCalls = (): unknown[][] =>
  h.tg.calls
    .filter((c) => ['deleteMessage', 'restrictChatMember', 'banChatMember', 'sendMessage'].includes(c.method) && c.args[0] === CHAT)
    .map((c) => [c.method, ...c.args])

const steamed = (id: number): unknown[][] => [
  ['deleteMessage', CHAT, id],
  ['restrictChatMember', CHAT, CAROL.id, NO_PERMISSIONS, undefined],
  ['sendMessage', CHAT, REPLY, [[{ text: 'Я не спамер', url: `https://t.me/jevchik_bot?startapp=appeal_${CHAT}` }]]],
]

describe('F34: the stop word (section 3.6.6)', () => {
  it('a newcomer naming it in the text goes to the steam room with the fixed reply, whatever Jev says', async () => {
    h.jev.script(PLAIN, { spam_channel_bait: 0.1 })
    await h.send(message({ id: 700, from: CAROL, text: PLAIN }))
    await h.app.settle()
    expect(chatCalls()).toEqual(steamed(700))
    expect(await h.db.query('SELECT user_id::int, category, state FROM bans')).toEqual([{ user_id: CAROL.id, category: 'spam_channel_bait', state: 'steam' }])
    expect(await h.db.query(`SELECT kind, payload->>'messageId' AS id FROM admin_cards`)).toEqual([{ kind: 'steamed', id: '700' }])
  })

  it('a hidden link to it counts as well', async () => {
    const extra = { entities: [{ type: 'text_link', offset: 2, length: 11, url: 'https://t.me/PolzaStas' }] }
    await h.send(message({ id: 700, from: CAROL, text: HIDDEN, extra }))
    await h.app.settle()
    expect(chatCalls()).toEqual(steamed(700))
  })

  it('a silent member the bot never saw joining is caught on an early message', async () => {
    await h.db.query('UPDATE members SET joined_seen_at = NULL')
    await h.send(message({ id: 600, from: CAROL, text: 'привет' }))
    await h.app.settle()
    await h.db.query('UPDATE members SET joined_seen_at = NULL WHERE user_id = $1', [CAROL.id])
    h.tg.calls.length = 0
    await h.send(message({ id: 700, from: CAROL, text: PLAIN }))
    await h.app.settle()
    expect(await h.db.query('SELECT joined_seen_at FROM members WHERE user_id = $1', [CAROL.id])).toEqual([{ joined_seen_at: null }])
    expect(chatCalls()).toEqual(steamed(700))
  })

  it('a member past the newcomer count is not touched', async () => {
    for (let i = 0; i < 5; i++) await h.send(message({ id: 600 + i, from: CAROL, text: `обычное сообщение ${i}` }))
    await h.app.settle()
    h.tg.calls.length = 0
    await h.send(message({ id: 700, from: CAROL, text: PLAIN }))
    await h.app.settle()
    expect(chatCalls()).toEqual([])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })
})
