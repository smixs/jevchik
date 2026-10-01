import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deliverCards } from '../src/cards.js'
import { migrate } from '../src/db.js'
import { NO_PERMISSIONS } from '../src/ops.js'
import { loadJokes } from '../src/sanctions.js'
import { changeSetting } from '../src/settings/settings.js'
import { ADMIN, CAROL, CHAT, OTHER_CHAT, botJoined, createHarness, edited, message, pastObservation, seedMember, setKarma, type Harness, type User } from './support/harness.js'

const MILD = 'Посмотрите мой курс по промптам со скидкой'
const SPAM = 'Заработай 500 долларов в день без вложений, пиши в личку!'
const DAN: User = { id: 4, first_name: 'Dan' }
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
    .filter((c) => ['getChatMember', 'deleteMessage', 'restrictChatMember', 'banChatMember', 'sendMessage'].includes(c.method))
    .map((c) => [c.method, ...c.args])

const cardTexts = (): string[] => h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id).map((c) => c.args[1] as string)

/** `count` ordinary messages of the member, ids from `first`, evaluated and settled; the recorded calls are then cleared. */
async function history(user: User, count: number, first = 600): Promise<void> {
  for (let i = 0; i < count; i++) await h.send(message({ id: first + i, from: user, text: `обычное сообщение ${i}` }))
  await h.app.settle()
  h.tg.calls.length = 0
}

async function setNewcomers(value: number, chat = CHAT): Promise<void> {
  await changeSetting(h.db, { chatId: chat, key: 'spam_newcomer_messages', value, baseVersion: 0, actor: ADMIN.id, now: h.clock.now() })
}

const spamOf = async (id: number): Promise<number | null> => (await h.db.query('SELECT facts FROM messages WHERE message_id = $1', [id]))[0].facts.spam

describe('F28: spam by text is judged only for a newcomer (section 3.6.0)', () => {
  it('boundary: the fifth message of a member is judged, the sixth is not; both evaluations are stored', async () => {
    await history(CAROL, 4)
    h.jev.script(MILD, { spam_other_offer: 0.6 })
    h.jev.script(`${MILD}!`, { spam_other_offer: 0.6 })
    await h.send(message({ id: 700, from: CAROL, text: MILD }))
    await h.app.settle()
    // Section 3.6.2: from 0.30 up to the threshold of automatic deletion only a card; the message stays.
    expect(chatCalls().filter((c) => c[1] === CHAT)).toEqual([])
    expect(cardTexts()).toHaveLength(1)
    h.tg.calls.length = 0
    await h.send(message({ id: 701, from: CAROL, text: `${MILD}!` }))
    await h.app.settle()
    expect(chatCalls()).toEqual([])
    expect([await spamOf(700), await spamOf(701)]).toEqual([0.6, 0.6])
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([{ kind: 'review' }])
  })

  it('an edit of an early message by a member past the count gives neither a sanction nor a card', async () => {
    await history(CAROL, 6)
    await h.send(edited({ id: 600, from: CAROL, text: SPAM, edit_date: '2026-09-09T12:30:00Z' }))
    h.jev.script(SPAM, { spam_earnings_crypto: 0.95 })
    await h.app.settle()
    expect(chatCalls()).toEqual([])
    expect(await h.db.query('SELECT 1 FROM admin_cards')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })

  it('spec 3.6.0: a new message counts the messages sent not later than it; a delayed evaluation is not changed by later ones', async () => {
    await history(CAROL, 4)
    h.jev.script(MILD, { spam_other_offer: 0.6 })
    await h.send(message({ id: 700, from: CAROL, text: MILD }))
    await h.send(message({ id: 701, from: CAROL, text: 'и ещё' }))
    await h.app.settle()
    expect(await h.db.query(`SELECT kind, payload->>'messageId' AS id FROM admin_cards`)).toEqual([{ kind: 'review', id: '700' }])
  })

  it('spam as the first message followed at once by five more is still deleted and the author muted', async () => {
    h.jev.script(SPAM, { spam_earnings_crypto: 0.99 })
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    for (let i = 1; i <= 5; i++) await h.send(message({ id: 700 + i, from: CAROL, text: `ещё ${i}` }))
    await h.app.settle()
    expect(h.tg.of('deleteMessage').map((c) => c.args)).toEqual([[CHAT, 700]])
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(await h.db.query(`SELECT kind, payload->>'messageId' AS id FROM admin_cards`)).toEqual([{ kind: 'steamed', id: '700' }])
  })

  it('a softer edit of a carded message by a member now past the count gives no edit card', async () => {
    await history(CAROL, 1)
    h.jev.script(MILD, { spam_other_offer: 0.35 })
    await h.send(message({ id: 700, from: CAROL, text: MILD }))
    await h.app.settle()
    await history(CAROL, 5, 610)
    await h.send(edited({ id: 700, from: CAROL, text: 'просто вопрос', edit_date: '2026-09-09T12:30:00Z' }))
    await h.app.settle()
    expect(await h.db.query('SELECT kind FROM admin_cards ORDER BY card_id')).toEqual([{ kind: 'review' }])
  })

  it('a captionless media that cannot be described gives a card for a newcomer only, by the message count', async () => {
    const photo = (id: string) => ({ photo: [{ file_id: id, file_unique_id: `u-${id}`, width: 1, height: 1, file_size: 100 }] })
    h.vision.failure = new Error('502')
    await seedMember(h, DAN)
    for (let id = 1; id <= 6; id++) {
      await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at) VALUES ($1,$2,$3,'2026-08-01T00:00:00Z')`, [CHAT, id, DAN.id])
    }
    await h.send(message({ id: 700, from: DAN, extra: photo('a') }))
    await h.app.settle()
    expect(await h.db.query('SELECT 1 FROM admin_cards')).toEqual([])
    await history(CAROL, 2)
    await h.send(message({ id: 701, from: CAROL, extra: photo('b') }))
    await h.app.settle()
    expect(await h.db.query(`SELECT kind, payload->>'messageId' AS id FROM admin_cards`)).toEqual([{ kind: 'media_unverified', id: '701' }])
  })

  it('a member past the count gets neither a sanction nor a card at any spam score', async () => {
    await history(CAROL, 5)
    const scores = [0.3, 0.5, 0.79, 0.8, 1]
    for (const [i, score] of scores.entries()) {
      h.jev.script(`${SPAM} ${i}`, { spam_earnings_crypto: score })
      await h.send(message({ id: 700 + i, from: CAROL, text: `${SPAM} ${i}` }))
    }
    await h.app.settle()
    expect(chatCalls()).toEqual([])
    expect(await h.db.query('SELECT 1 FROM admin_cards')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })

  it('imported messages count: a member with an imported history is not a newcomer', async () => {
    await seedMember(h, DAN)
    for (let id = 1; id <= 5; id++) {
      await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at) VALUES ($1,$2,$3,'2026-08-01T00:00:00Z')`, [CHAT, id, DAN.id])
    }
    await h.db.query('UPDATE members SET first_message_id = 1 WHERE user_id = $1', [DAN.id])
    h.jev.script(MILD, { spam_other_offer: 0.6 })
    await h.send(message({ id: 700, from: DAN, text: MILD }))
    await h.app.settle()
    expect(chatCalls()).toEqual([])
  })

  it('spam_newcomer_messages = 0 judges everybody', async () => {
    await setNewcomers(0)
    await history(CAROL, 7)
    h.jev.script(MILD, { spam_other_offer: 0.6 })
    await h.send(message({ id: 700, from: CAROL, text: MILD }))
    await h.app.settle()
    expect(chatCalls().filter((c) => c[1] === CHAT)).toEqual([])
    expect(await h.db.query(`SELECT kind, payload->>'messageId' AS id FROM admin_cards`)).toEqual([{ kind: 'review', id: '700' }])
    expect(cardTexts()).toHaveLength(1)
  })

  it('the value comes from the chat settings: with 2, the third message is not judged', async () => {
    await setNewcomers(2)
    await history(CAROL, 2)
    h.jev.script(MILD, { spam_other_offer: 0.35 })
    await h.send(message({ id: 700, from: CAROL, text: MILD }))
    await h.app.settle()
    expect(cardTexts()).toEqual([])
  })

  it('rule 2: a protected member past the count gets no card; a protected newcomer still does', async () => {
    await history(CAROL, 6)
    await setKarma(h, CAROL.id, 150)
    h.jev.script(MILD, { spam_other_offer: 0.6 })
    await h.send(message({ id: 700, from: CAROL, text: MILD }))
    await h.app.settle()
    expect(chatCalls()).toEqual([])
    await seedMember(h, DAN, 150)
    await h.send(message({ id: 701, from: DAN, text: MILD }))
    await h.app.settle()
    expect(chatCalls().filter((c) => c[1] === CHAT)).toEqual([])
    expect(await h.db.query('SELECT kind, payload->>\'messageId\' AS id FROM admin_cards')).toEqual([{ kind: 'protected', id: '701' }])
  })

  it('spec 3.6.0, an advertising profile does not touch a member with an imported history on the first live message', async () => {
    await seedMember(h, DAN)
    for (let id = 1; id <= 6; id++) {
      await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at) VALUES ($1,$2,$3,'2026-08-01T00:00:00Z')`, [CHAT, id, DAN.id])
    }
    h.jev.script('Привет всем', { profile_promo: 0.92 })
    await h.send(message({ id: 700, from: DAN, text: 'Привет всем' }))
    await h.app.settle()
    expect(chatCalls().filter((c) => c[1] === CHAT)).toEqual([])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM admin_cards')).toEqual([])
  })

  it('the profile rule still sends a newcomer with an advertising profile to the steam room', async () => {
    h.jev.script('Привет всем', { profile_promo: 0.92 })
    await h.send(message({ id: 700, from: DAN, text: 'Привет всем' }))
    await h.app.settle()
    expect(chatCalls().filter((c) => c[1] === CHAT)).toEqual([
      ['getChatMember', CHAT, DAN.id],
      ['deleteMessage', CHAT, 700],
      ['restrictChatMember', CHAT, DAN.id, NO_PERMISSIONS, undefined],
      ['sendMessage', CHAT, loadJokes().replies[0].replaceAll('{name}', 'Dan'), [[{ text: 'Я не спамер', url: `https://t.me/jevchik_bot?startapp=appeal_${CHAT}` }]]],
    ])
    expect((await h.db.query('SELECT category FROM bans'))[0].category).toBe('profile_promo')
  })

  it('probation works as before: the lowered threshold applies to a member past the count', async () => {
    await history(CAROL, 8)
    await h.db.query('UPDATE members SET probation_left = 5 WHERE user_id = $1', [CAROL.id])
    h.jev.script('немного рекламы', { spam_other_offer: 0.35 })
    await h.send(message({ id: 700, from: CAROL, text: 'немного рекламы' }))
    await h.send(message({ id: 701, from: CAROL, text: 'глянь https://example.com/page' }))
    await h.app.settle()
    expect(h.tg.of('deleteMessage').map((c) => c.args)).toEqual([[CHAT, 700], [CHAT, 701]])
  })
})

describe('F28 with section 3.6.3: in the first week a newcomer is handled as usual, a member past the count is not judged', () => {
  beforeEach(async () => {
    await h.close()
    h = await createHarness()
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
    await h.send(botJoined())
  })

  it('a member past the count: nothing; a newcomer at 0.95: deleted, and «Удалил спам и заглушил автора»', async () => {
    await history(CAROL, 6)
    h.jev.script(SPAM, { spam_earnings_crypto: 0.95 })
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(chatCalls()).toEqual([])
    await h.send(message({ id: 701, from: DAN, text: SPAM }))
    await h.app.settle()
    expect(h.tg.of('deleteMessage').map((c) => c.args)).toEqual([[CHAT, 701]])
    expect(await h.db.query('SELECT kind, payload->>\'messageId\' AS id FROM admin_cards')).toEqual([{ kind: 'steamed', id: '701' }])
  })
})

describe('spam_newcomer_messages in the settings schema', () => {
  it('is an integer from 0 to 1000, 5 by default', async () => {
    const { defaultValues } = await import('../src/settings/settings.js')
    expect(defaultValues().spam_newcomer_messages).toBe(5)
    for (const value of [-1, 1001, 2.5, '5', null]) {
      await expect(changeSetting(h.db, { chatId: CHAT, key: 'spam_newcomer_messages', value, baseVersion: 0, actor: 1, now: h.clock.now() })).rejects.toMatchObject({ code: 'invalid' })
    }
    await expect(setNewcomers(0)).resolves.toBeUndefined()
    await expect(changeSetting(h.db, { chatId: CHAT, key: 'spam_newcomer_messages', value: 1000, baseVersion: 1, actor: 1, now: h.clock.now() })).resolves.toEqual({ version: 2 })
  })
})

describe('migration 008: open cards about messages of members past the count are closed with not_newcomer', () => {
  async function card(chatId: number, kind: string, userId: number, messageId: number, status = 'open'): Promise<void> {
    await h.db.query(`INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, status, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
      chatId,
      `${kind}:${chatId}:${messageId}`,
      kind,
      JSON.stringify({ targetUserId: userId, targetName: 'x', messageId }),
      status,
      h.clock.now(),
    ])
  }

  async function messages(chatId: number, userId: number, count: number, first: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at) VALUES ($1,$2,$3,$4)`, [chatId, first + i, userId, h.clock.now()])
    }
  }

  it('closes would_do, review, protected and edit_lowered of members with more than 5 messages; everything else stays', async () => {
    await h.send(botJoined(OTHER_CHAT))
    await messages(CHAT, CAROL.id, 6, 10)
    await messages(CHAT, DAN.id, 5, 30)
    await messages(OTHER_CHAT, CAROL.id, 6, 10)
    await setNewcomers(0, OTHER_CHAT)
    await card(CHAT, 'would_do', CAROL.id, 10)
    await card(CHAT, 'review', CAROL.id, 11)
    await card(CHAT, 'protected', CAROL.id, 12)
    await card(CHAT, 'report', CAROL.id, 13)
    await card(CHAT, 'edit_lowered', CAROL.id, 14)
    await card(CHAT, 'review', CAROL.id, 15, 'resolved')
    await card(CHAT, 'review', DAN.id, 30)
    await card(OTHER_CHAT, 'review', CAROL.id, 10)
    await h.db.query(`DELETE FROM schema_migrations WHERE name IN ('008_spam_newcomer.sql', '009_close_edit_lowered.sql')`)
    await migrate(h.db)
    expect(await h.db.query(`SELECT chat_id, kind, payload->>'messageId' AS id, status, resolution FROM admin_cards ORDER BY card_id`)).toEqual([
      { chat_id: CHAT, kind: 'would_do', id: '10', status: 'resolved', resolution: 'not_newcomer' },
      { chat_id: CHAT, kind: 'review', id: '11', status: 'resolved', resolution: 'not_newcomer' },
      { chat_id: CHAT, kind: 'protected', id: '12', status: 'resolved', resolution: 'not_newcomer' },
      { chat_id: CHAT, kind: 'report', id: '13', status: 'open', resolution: null },
      { chat_id: CHAT, kind: 'edit_lowered', id: '14', status: 'resolved', resolution: 'not_newcomer' },
      { chat_id: CHAT, kind: 'review', id: '15', status: 'resolved', resolution: null },
      { chat_id: CHAT, kind: 'review', id: '30', status: 'open', resolution: null },
      { chat_id: OTHER_CHAT, kind: 'review', id: '10', status: 'open', resolution: null },
    ])
  })
  it('a card the migration closed is never delivered', async () => {
    await messages(CHAT, CAROL.id, 6, 10)
    await card(CHAT, 'would_do', CAROL.id, 10)
    await h.db.query(`DELETE FROM schema_migrations WHERE name IN ('008_spam_newcomer.sql', '009_close_edit_lowered.sql')`)
    await migrate(h.db)
    h.tg.calls.length = 0
    await deliverCards(h.ctx)
    expect(h.tg.count('sendMessage')).toBe(0)
    expect(await h.db.query('SELECT status, delivery FROM admin_cards')).toEqual([{ status: 'resolved', delivery: 'pending' }])
  })
})
