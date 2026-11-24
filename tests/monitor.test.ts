import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildReport, renderReport, thresholdProposal } from '../src/monitor.js'
import { tgError } from './support/fakes.js'
import { ADMIN, CAROL, CHAT, callback, createHarness, message, pastObservation, type Harness, type User } from './support/harness.js'

// Section 3.13: the daily watch reads what the bot did, what admins did by hand and what they took back.

const SPAM = 'Заработай 500 долларов в день без вложений, пиши в личку!'
const MILD = 'Посмотрите мой курс по промптам со скидкой'
const DAVE: User = { id: 4, first_name: 'Dave' }
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.tg.members.set(ADMIN.id, 'administrator')
  h.jev.script(SPAM, { spam_earnings_crypto: 0.98 })
  h.jev.script(MILD, { spam_other_offer: 0.5 })
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const report = () => buildReport(h.db, new Date(h.clock.now().getTime() + 60_000))
const lastCard = async () => Number((await h.db.query('SELECT card_id FROM admin_cards ORDER BY card_id DESC LIMIT 1'))[0].card_id)

/** A newcomer's second message with Jev unsure: a card «реши», the message stays in the chat. */
async function reviewCard(from: User = CAROL, first = 600, second = 701): Promise<number> {
  await h.send(message({ id: first, from, text: 'обычное первое сообщение' }))
  await h.send(message({ id: second, from, text: MILD }))
  await h.app.settle()
  return lastCard()
}

async function press(id: number, action: string): Promise<void> {
  await h.send(callback({ data: `c:${id}:${action}`, from: ADMIN, id: `cb${id}${action}` }))
  await h.app.settle()
}

describe('daily watch', () => {
  it('a quiet day is green', async () => {
    const r = await report()
    expect(r.color).toBe('🟢')
    expect(renderReport(r).split('\n')[0]).toBe('🟢 Жевчик за сутки справился сам: ручной работы и ложных нет.')
  })

  it('counts what the bot did itself and lists the hand work with its text', async () => {
    await h.send(message({ id: 700, from: DAVE, text: SPAM }))
    await h.app.settle()
    const id = await reviewCard()
    await press(id, 'spam')
    await press(id, 'ban')
    const r = await report()
    const chat = r.chats.find((c) => c.chatId === CHAT)!
    expect(chat.auto.steam).toBe(1)
    expect(chat.manual).toHaveLength(1)
    expect(chat.manual[0]).toMatchObject({ userId: CAROL.id, spam: 0.5, text: MILD, admin: 'Admin', actions: ['«Спам» на карточке', '«Забанить» на карточке'] })
    expect(r.color).toBe('🟡')
    const text = renderReport(r)
    expect(text.split('\n')[0]).toBe('🟡 Жевчик за сутки: руками 1, ложных 0. Нужно решение по улучшениям ниже.')
    expect(text).toContain(`«${MILD}»`)
    expect(r.proposals.some((p) => p.includes('фразы не узнали удалённые руками тексты (1)'))).toBe(true)
  })

  it('«Не спам» is a false alarm; an untouched card hangs without a decision, a pressed one does not', async () => {
    await press(await reviewCard(), 'notspam')
    await reviewCard(DAVE, 602, 703)
    const eve = await reviewCard({ id: 5, first_name: 'Eve' }, 604, 705)
    // A member's flag about the same message: a second card; the press on the first settles it too.
    await h.db.query(
      `INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, created_at) SELECT chat_id, 'flag-copy', 'flagged', payload, created_at FROM admin_cards WHERE card_id = $1`,
      [eve],
    )
    await press(eve, 'spam')
    const chat = (await report()).chats.find((c) => c.chatId === CHAT)!
    expect(chat.falseAlarms.map((c) => [c.userId, c.actions])).toEqual([[CAROL.id, ['«Не спам» на карточке']]])
    expect(chat.openReview.map((c) => [c.userId, c.text])).toEqual([[DAVE.id, MILD]])
  })

  it('red when the bot could not remove spam', async () => {
    h.tg.fail('deleteMessage', tgError.bad('Bad Request: not enough rights to delete a message', 403), 10)
    await h.send(message({ id: 700, from: DAVE, text: SPAM, date: h.clock.now().toISOString() }))
    await h.app.settle()
    const r = await report()
    expect(r.color).toBe('🔴')
    expect(r.chats.find((c) => c.chatId === CHAT)!.cannotAct.map((o) => o.kind)).toContain('delete_message')
    expect(renderReport(r).split('\n')[0]).toMatch(/^🔴 Жевчик не может убрать спам: .*Нужно решение/)
  })

  it('the window is the last day only', async () => {
    await press(await reviewCard(), 'spam')
    h.clock.advance(25 * 3600 * 1000)
    expect((await report()).chats.find((c) => c.chatId === CHAT)!.manual).toEqual([])
  })
})

describe('threshold proposal', () => {
  it('the lowest hand-deleted score above every «не спам»', () => {
    expect(thresholdProposal([0.57, 0.52, 0.45, 0.7], [0.48], 0.6, 0.4)).toEqual({ at: 0.52, caught: 2, missed: 1 })
  })
  it('nothing when a false alarm sits above the hand work, or only one would be caught', () => {
    expect(thresholdProposal([0.5, 0.55], [0.58], 0.6, 0.4)).toBeNull()
    expect(thresholdProposal([0.55], [], 0.6, 0.4)).toBeNull()
  })
  it('never under the review threshold', () => {
    expect(thresholdProposal([0.3, 0.35], [], 0.6, 0.4)).toBeNull()
  })
})
