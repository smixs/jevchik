import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deliverCards } from '../src/cards.js'
import { migrate } from '../src/db.js'
import { NO_PERMISSIONS } from '../src/ops.js'
import { loadJokes } from '../src/sanctions.js'
import { DEFAULT_PERMISSIONS, tgError } from './support/fakes.js'
import { ADMIN, CAROL, CHAT, botJoined, callback, command, createHarness, message, pastObservation, type Harness, type User } from './support/harness.js'

// F30, sections 3.6.2 and 3.6.3: automatic deletion, the buttons of a spam card and the answer of the bot to the admin.

const SPAM = 'Заработай 500 долларов в день без вложений, пиши в личку!'
const MILD = 'Посмотрите мой курс по промптам со скидкой'
const ADMIN2: User = { id: 98, first_name: 'Second' }
const LINK = (id: number): string => `https://t.me/c/1234567890/${id}`
/** The clock after pastObservation, in the chat time zone Asia/Tashkent. */
const WHEN = '09.09.2026 17:00'
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.tg.members.set(ADMIN.id, 'administrator')
  h.jev.script(SPAM, { spam_earnings_crypto: 0.98 })
  h.jev.script(MILD, { spam_other_offer: 0.6 })
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const METHODS = ['getChatMember', 'getChat', 'deleteMessage', 'restrictChatMember', 'banChatMember', 'unbanChatMember', 'sendMessage', 'editMessageText', 'answerCallbackQuery']
/** The bio of a first message (getChat of the member) is not part of these scenarios. */
const calls = (): unknown[][] => h.tg.calls.filter((c) => METHODS.includes(c.method) && !(c.method === 'getChat' && c.args[0] !== CHAT)).map((c) => [c.method, ...c.args])
const open = (id: number) => [{ text: 'Открыть сообщение', url: LINK(id) }]
const button = (card: number, text: string, action: string) => ({ text, callback_data: `c:${card}:${action}` })
const inChat = (card: number) => [button(card, 'Спам', 'spam'), button(card, 'Не спам', 'notspam')]
const deleted = (card: number) => [button(card, 'Не спам, вернуть', 'restore'), button(card, 'Забанить', 'ban')]
const appealButton = [[{ text: 'Я не спамер', url: `https://t.me/jevchik_bot?startapp=appeal_${CHAT}` }]]
const joke = (name: string): string => loadJokes().replies[0].replaceAll('{name}', name)

/** A card whose quote is the whole text: the lines before it, the quote, the link; the blockquote entity in UTF-16 units. */
function card(head: string[], quote: string, id: number): { text: string; entities: unknown[] } {
  const before = head.join('\n') + '\n'
  return { text: `${before}${quote}\nСсылка: ${LINK(id)}`, entities: [{ type: 'blockquote', offset: before.length, length: quote.length }] }
}

const STEAMED = card(['Удалил спам и заглушил автора', 'Участник: Carol', 'Категория: Лёгкие деньги и крипта', 'Уверенность: 98%'], SPAM, 700)
const REVIEW = card(['Похоже на спам, реши', 'Участник: Carol', 'Категория: Навязчивая реклама', 'Уверенность: 60%'], MILD, 701)

async function cardId(): Promise<number> {
  return Number((await h.db.query('SELECT card_id FROM admin_cards ORDER BY card_id DESC LIMIT 1'))[0].card_id)
}

async function cardMessage(id: number, admin = ADMIN.id): Promise<number> {
  const rows = await h.db.query(`SELECT result->>'message_id' AS m FROM operations WHERE idempotency_key = $1`, [`card:${id}:${admin}`])
  return Number(rows[0].m)
}

/** Carol's first message is ordinary; her second one, a newcomer's, is judged. */
async function reviewCard(): Promise<number> {
  await h.send(message({ id: 600, from: CAROL, text: 'обычное первое сообщение' }))
  await h.send(message({ id: 701, from: CAROL, text: MILD }))
  await h.app.settle()
  h.tg.calls.length = 0
  return cardId()
}

async function steamedCard(): Promise<number> {
  await h.send(message({ id: 700, from: CAROL, text: SPAM }))
  await h.app.settle()
  h.tg.calls.length = 0
  return cardId()
}

async function press(id: number, action: string, from: User = ADMIN, cb = 'cb1'): Promise<void> {
  await h.send(callback({ data: `c:${id}:${action}`, from, id: cb }))
  await h.app.settle()
}

describe('F30: automatic deletion (section 3.6.2)', () => {
  it('a newcomer at or above 0.90: deleted, steam room, and the card "Удалил спам и заглушил автора" with its buttons', async () => {
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    const id = await cardId()
    expect(calls()).toEqual([
      ['getChatMember', CHAT, CAROL.id],
      ['deleteMessage', CHAT, 700],
      ['restrictChatMember', CHAT, CAROL.id, NO_PERMISSIONS, undefined],
      ['sendMessage', CHAT, joke('Carol'), appealButton],
      ['sendMessage', ADMIN.id, STEAMED.text, [open(700), deleted(id)], STEAMED.entities],
    ])
  })

  it('observation mode does not block it', async () => {
    await h.close()
    h = await createHarness()
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
    h.jev.script(SPAM, { spam_earnings_crypto: 0.98 })
    await h.send(botJoined())
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(h.tg.of('deleteMessage').map((c) => c.args)).toEqual([[CHAT, 700]])
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([{ kind: 'steamed' }])
  })

  it('applies to any newcomer message, not only the first; exactly 0.90 counts, 0.89 only asks', async () => {
    await h.send(message({ id: 600, from: CAROL, text: 'обычное первое сообщение' }))
    h.jev.script('почти', { spam_other_offer: 0.89 })
    h.jev.script('ровно', { spam_other_offer: 0.9 })
    await h.send(message({ id: 701, from: CAROL, text: 'почти' }))
    await h.send(message({ id: 702, from: CAROL, text: 'ровно' }))
    await h.app.settle()
    expect(h.tg.of('deleteMessage').map((c) => c.args)).toEqual([[CHAT, 702]])
    expect(await h.db.query(`SELECT kind, payload->>'messageId' AS id FROM admin_cards ORDER BY card_id`)).toEqual([
      { kind: 'review', id: '701' },
      { kind: 'steamed', id: '702' },
    ])
  })

  it('from spam_review_threshold to the threshold: the message stays and admins are asked; rule 4 (0.50) is gone', async () => {
    await h.send(message({ id: 600, from: CAROL, text: 'обычное первое сообщение' }))
    await h.send(message({ id: 701, from: CAROL, text: MILD }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(0)
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([{ kind: 'review' }])
  })

  it('the review card, literally', async () => {
    await h.send(message({ id: 600, from: CAROL, text: 'обычное первое сообщение' }))
    await h.send(message({ id: 701, from: CAROL, text: MILD }))
    await h.app.settle()
    const id = await cardId()
    expect(calls()).toEqual([['sendMessage', ADMIN.id, REVIEW.text, [open(701), inChat(id)], REVIEW.entities]])
  })
})

describe('F30: the buttons of a spam card and the answer of the bot (section 3.6.2)', () => {
  it('"Спам": the message is deleted, the author goes to the steam room; popup and edited card with the remaining buttons', async () => {
    const id = await reviewCard()
    const mid = await cardMessage(id)
    await press(id, 'spam')
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['getChatMember', CHAT, CAROL.id],
      ['deleteMessage', CHAT, 701],
      ['restrictChatMember', CHAT, CAROL.id, NO_PERMISSIONS, undefined],
      ['sendMessage', CHAT, joke('Carol'), appealButton],
      ['answerCallbackQuery', 'cb1', 'Сообщение удалено, участник заглушён'],
      ['editMessageText', ADMIN.id, mid, `${REVIEW.text}\nРешение: сообщение удалено, участник заглушён. Admin, ${WHEN}`, [open(701), deleted(id)], REVIEW.entities],
    ])
    expect(await h.db.query('SELECT state, category FROM bans')).toEqual([{ state: 'steam', category: 'spam_other_offer' }])
  })

  it('"Забанить" on a message still in the chat deletes it and bans the member (the case of 29.09)', async () => {
    const id = await reviewCard()
    const mid = await cardMessage(id)
    await press(id, 'ban')
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['getChatMember', CHAT, CAROL.id],
      ['deleteMessage', CHAT, 701],
      ['banChatMember', CHAT, CAROL.id],
      ['answerCallbackQuery', 'cb1', 'Сообщение удалено, участник забанен'],
      ['editMessageText', ADMIN.id, mid, `${REVIEW.text}\nРешение: сообщение удалено, участник забанен. Admin, ${WHEN}`, [open(701), [button(id, 'Не спам, вернуть', 'restore')]], REVIEW.entities],
    ])
    expect(await h.db.query('SELECT state FROM bans')).toEqual([{ state: 'banned' }])
  })

  it('«Забанить» checks the role of the target first: an admin or the owner loses neither the message nor the right', async () => {
    for (const status of ['administrator', 'creator'] as const) {
      await h.close()
      h = await createHarness()
      h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
      h.tg.members.set(ADMIN.id, 'administrator')
      h.jev.script(MILD, { spam_other_offer: 0.6 })
      await pastObservation(h)
      const id = await reviewCard()
      h.tg.members.set(CAROL.id, status)
      await press(id, 'ban')
      expect(calls().slice(0, 3)).toEqual([
        ['getChatMember', CHAT, ADMIN.id],
        ['getChatMember', CHAT, CAROL.id],
        ['answerCallbackQuery', 'cb1', 'Участник - админ, наказывать не стал'],
      ])
      expect(h.tg.count('deleteMessage') + h.tg.count('banChatMember')).toBe(0)
    }
  })

  it('«Забанить» when the role of the target cannot be checked: neither deletion nor ban, the card says so', async () => {
    const id = await reviewCard()
    const original = h.tg.getChatMember.bind(h.tg)
    h.tg.getChatMember = async (chatId: number, userId: number) => {
      if (userId === CAROL.id) throw tgError.server()
      return original(chatId, userId)
    }
    await press(id, 'ban')
    for (let i = 0; i < 4; i++) {
      h.clock.advance(20_000)
      await h.app.settle()
    }
    expect(h.tg.count('deleteMessage') + h.tg.count('banChatMember')).toBe(0)
    expect((await h.db.query('SELECT decision FROM admin_cards'))[0].decision).toBe(`Решение: проверить роль участника не смог. Admin, ${WHEN}`)
  })

  it('"Забанить" on a deleted message only bans', async () => {
    const id = await steamedCard()
    await press(id, 'ban')
    expect(calls().slice(0, 4)).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['getChatMember', CHAT, CAROL.id],
      ['banChatMember', CHAT, CAROL.id],
      ['answerCallbackQuery', 'cb1', 'Участник забанен'],
    ])
  })

  it('"Забанить" that cannot delete says what was done and what was not', async () => {
    const id = await reviewCard()
    h.tg.fail('deleteMessage', tgError.bad('Bad Request: not enough rights to delete a message', 403))
    await h.db.query(`UPDATE messages SET posted_at = $1 WHERE message_id = 701`, [h.clock.now()])
    await press(id, 'ban')
    expect(h.tg.callbackAnswers).toEqual([{ id: 'cb1', text: 'Участник забанен; сообщение удалить не смог: нет прав' }])
  })

  it('"Не спам" on a message in the chat closes the card without sanctions', async () => {
    const id = await reviewCard()
    const mid = await cardMessage(id)
    await press(id, 'notspam')
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['answerCallbackQuery', 'cb1', 'Не спам, сообщение осталось в чате'],
      ['editMessageText', ADMIN.id, mid, `${REVIEW.text}\nРешение: не спам, сообщение осталось в чате. Admin, ${WHEN}`, [open(701)], REVIEW.entities],
    ])
    expect(await h.db.query('SELECT status FROM admin_cards')).toEqual([{ status: 'resolved' }])
  })

  it('"Не спам, вернуть" after the steam room: restriction lifted, record removed, text published by the bot, no probation', async () => {
    const id = await steamedCard()
    const mid = await cardMessage(id)
    await press(id, 'restore')
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['getChat', CHAT],
      ['restrictChatMember', CHAT, CAROL.id, DEFAULT_PERMISSIONS, undefined],
      ['sendMessage', CHAT, `Carol: ${SPAM}`, undefined],
      ['answerCallbackQuery', 'cb1', 'Ограничение снято, запись в бане удалена, сообщение возвращено в чат'],
      ['editMessageText', ADMIN.id, mid, `${STEAMED.text}\nРешение: ограничение снято, запись в бане удалена, сообщение возвращено в чат. Admin, ${WHEN}`, [open(700)], STEAMED.entities],
    ])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT probation_left FROM members WHERE user_id = $1', [CAROL.id])).toEqual([{ probation_left: 0 }])
  })

  it('"Не спам, вернуть" after a ban lifts the ban', async () => {
    const id = await steamedCard()
    await press(id, 'ban', ADMIN, 'cb1')
    h.tg.calls.length = 0
    await press(id, 'restore', ADMIN, 'cb2')
    expect(calls().slice(0, 4)).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['unbanChatMember', CHAT, CAROL.id],
      ['sendMessage', CHAT, `Carol: ${SPAM}`, undefined],
      ['answerCallbackQuery', 'cb2', 'Бан снят, запись в бане удалена, сообщение возвращено в чат'],
    ])
  })

  it('a message with an attachment comes back as its caption with a mark of the attachment', async () => {
    h.jev.script('подпись к фото', { spam_earnings_crypto: 0.95 })
    await h.send(message({ id: 700, from: CAROL, extra: { caption: 'подпись к фото', photo: [{ file_id: 'p', file_unique_id: 'u-p', width: 1, height: 1, file_size: 10 }] } }))
    await h.app.settle()
    await press(await cardId(), 'restore')
    expect(h.tg.of('sendMessage').at(-1)!.args.slice(0, 2)).toEqual([CHAT, 'Carol: [фото] подпись к фото'])
  })

  it('every admin who got the card sees the decision', async () => {
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }, { user_id: ADMIN2.id, is_bot: false }]
    const id = await reviewCard()
    await press(id, 'notspam')
    expect(h.tg.of('editMessageText').map((c) => [c.args[0], c.args[1]])).toEqual([
      [ADMIN.id, await cardMessage(id, ADMIN.id)],
      [ADMIN2.id, await cardMessage(id, ADMIN2.id)],
    ])
  })

  it('a button no longer allowed is stale: "Забанить" twice bans once', async () => {
    const id = await reviewCard()
    await press(id, 'ban', ADMIN, 'cb1')
    await press(id, 'ban', ADMIN, 'cb2')
    expect(h.tg.count('banChatMember')).toBe(1)
    expect(h.tg.callbackAnswers.at(-1)).toEqual({ id: 'cb2', text: 'Кнопка устарела' })
  })

  it('a member who is not an admin gets a refusal and nothing happens', async () => {
    const id = await reviewCard()
    await press(id, 'ban', CAROL)
    expect(calls()).toEqual([
      ['getChatMember', CHAT, CAROL.id],
      ['answerCallbackQuery', 'cb1', 'Только для админов чата'],
    ])
  })

  it('observation mode does not block the buttons', async () => {
    await h.close()
    h = await createHarness()
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
    h.tg.members.set(ADMIN.id, 'administrator')
    h.jev.script(MILD, { spam_other_offer: 0.6 })
    await h.send(botJoined())
    const id = await reviewCard()
    await press(id, 'ban')
    expect(h.tg.of('deleteMessage').map((c) => c.args)).toEqual([[CHAT, 701]])
    expect(h.tg.count('banChatMember')).toBe(1)
  })
})

describe('the buttons follow the sanction first', () => {
  it('the message stayed in the chat but the member is banned: «Не спам» lifts the ban and removes the record, nothing is published again', async () => {
    const id = await reviewCard()
    h.tg.fail('deleteMessage', tgError.bad('Forbidden: not enough rights to delete a message', 403))
    await h.db.query(`UPDATE messages SET posted_at = $1 WHERE message_id = 701`, [h.clock.now()])
    await press(id, 'ban', ADMIN, 'cb1')
    const edited = h.tg.of('editMessageText').at(-1)!.args[3]
    expect(edited).toEqual([open(701), [button(id, 'Не спам', 'notspam')]])
    h.tg.calls.length = 0
    await press(id, 'notspam', ADMIN, 'cb2')
    expect(calls().slice(0, 3)).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['unbanChatMember', CHAT, CAROL.id],
      ['answerCallbackQuery', 'cb2', 'Бан снят, запись в бане удалена'],
    ])
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toEqual([])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT status FROM admin_cards')).toEqual([{ status: 'resolved' }])
  })

  it('the message stayed in the chat and the member is in the steam room: «Не спам» and «Забанить»', async () => {
    h.tg.fail('deleteMessage', tgError.bad('Forbidden: not enough rights to delete a message', 403))
    await h.send(message({ id: 700, from: CAROL, text: SPAM, date: h.clock.now().toISOString() }))
    await h.app.settle()
    const id = await cardId()
    const sent = h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id).at(-1)!
    expect(sent.args[2]).toEqual([open(700), [button(id, 'Не спам', 'notspam'), button(id, 'Забанить', 'ban')]])
  })
})

describe('every card about a message has the buttons of its actual state', () => {
  it('«Не смог удалить сообщение» after an automatic deletion: the member is muted, the message is in the chat', async () => {
    h.tg.fail('deleteMessage', tgError.bad('Forbidden: not enough rights to delete a message', 403))
    await h.send(message({ id: 700, from: CAROL, text: SPAM, date: h.clock.now().toISOString() }))
    await h.app.settle()
    const card = (await h.db.query('SELECT card_id, kind FROM admin_cards'))[0]
    expect(card.kind).toBe('delete_denied')
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id).at(-1)!.args[2]).toEqual([
      open(700),
      [button(Number(card.card_id), 'Не спам', 'notspam'), button(Number(card.card_id), 'Забанить', 'ban')],
    ])
  })

  it('no right to mute after the deletion: the message is gone, nobody is muted: «Не спам, вернуть» and «Забанить»', async () => {
    h.tg.fail('restrictChatMember', tgError.bad('Forbidden: not enough rights to restrict/unrestrict chat member', 403))
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    const card = (await h.db.query('SELECT card_id, kind FROM admin_cards'))[0]
    expect(card.kind).toBe('no_rights')
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id).at(-1)!.args[2]).toEqual([open(700), deleted(Number(card.card_id))])
  })
})

describe('F30: T-card-edit and T-restore (section 4)', () => {
  it('T-card-edit: a refused edit is not repeated, the decision stays and is on the admin screen', async () => {
    const id = await reviewCard()
    h.tg.fail('editMessageText', tgError.bad('Bad Request: message to edit not found'))
    await press(id, 'notspam')
    expect(h.tg.count('editMessageText')).toBe(1)
    expect(h.tg.callbackAnswers).toEqual([{ id: 'cb1', text: 'Не спам, сообщение осталось в чате' }])
    expect(await h.db.query(`SELECT status, decision FROM admin_cards`)).toEqual([{ status: 'resolved', decision: `Решение: не спам, сообщение осталось в чате. Admin, ${WHEN}` }])
    expect(await h.db.query(`SELECT status FROM operations WHERE operation_kind = 'edit_message'`)).toEqual([{ status: 'failed' }])
  })

  it('T-card-edit: "message is not modified" is not repeated either; a network error is retried by the general rule', async () => {
    const id = await reviewCard()
    h.tg.fail('editMessageText', tgError.bad('Bad Request: message is not modified'))
    await press(id, 'notspam')
    expect(h.tg.count('editMessageText')).toBe(1)
    const other = await steamedCard()
    h.tg.fail('editMessageText', tgError.network(), 2)
    await press(other, 'ban')
    for (let i = 0; i < 3; i++) {
      h.clock.advance(10_000)
      await h.app.settle()
    }
    expect(h.tg.count('editMessageText')).toBe(3)
  })

  it('T-restore: the text is gone: the sanction is lifted anyway and the card says the message could not be returned', async () => {
    const id = await steamedCard()
    await h.db.query('DELETE FROM held_texts')
    await press(id, 'restore')
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toEqual([])
    expect(h.tg.callbackAnswers).toEqual([{ id: 'cb1', text: 'Ограничение снято, запись в бане удалена; вернуть не смог: текста уже нет' }])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })

  it('a 4096-character message comes back within the Telegram limit, cut by grapheme clusters with a mark', async () => {
    const long = 'я'.repeat(4096)
    h.jev.script(long, { spam_earnings_crypto: 0.95 })
    await h.send(message({ id: 700, from: CAROL, text: long }))
    await h.app.settle()
    await press(await cardId(), 'restore')
    const sent = h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT).at(-1)!.args[1] as string
    expect(sent).toBe(`Carol: ${'я'.repeat(4078)} (обрезано)`)
    expect(sent.length).toBe(4096)
  })

  it('wide clusters are never broken when the text is cut', async () => {
    const family = '👨‍👩‍👧'
    const long = family.repeat(600)
    h.jev.script(long, { spam_earnings_crypto: 0.95 })
    await h.send(message({ id: 700, from: CAROL, text: long }))
    await h.app.settle()
    await press(await cardId(), 'restore')
    const sent = h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT).at(-1)!.args[1] as string
    expect(sent.length).toBeLessThanOrEqual(4096)
    const body = sent.slice('Carol: '.length, -' (обрезано)'.length)
    expect(body).toBe(family.repeat(body.length / family.length))
  })

  it('a refusal of Telegram other than a ban on writing is not called one', async () => {
    const id = await steamedCard()
    h.tg.fail('sendMessage', tgError.bad('Bad Request: message is too long'))
    await press(id, 'restore')
    expect(h.tg.callbackAnswers).toEqual([{ id: 'cb1', text: 'Ограничение снято, запись в бане удалена; вернуть не смог: Telegram отказал' }])
  })

  it('T-restore: the chat does not let the bot write: the sanction is lifted anyway', async () => {
    const id = await steamedCard()
    h.tg.fail('sendMessage', tgError.bad('Forbidden: not enough rights to send text messages', 403))
    await press(id, 'restore')
    expect(h.tg.callbackAnswers).toEqual([{ id: 'cb1', text: 'Ограничение снято, запись в бане удалена; вернуть не смог: чат не даёт боту писать' }])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })
})

describe('F30: /spam answers the admin in private (section 3.6.2)', () => {
  it('the admin gets the result and the button "Не спам, вернуть"', async () => {
    await h.send(message({ id: 900, from: CAROL, text: 'купи крипту' }))
    await h.app.settle()
    h.tg.calls.length = 0
    await h.send(command({ id: 950, from: ADMIN, text: '/spam', reply_to: { message_id: 900, from: CAROL, text: 'купи крипту' } }))
    await h.app.settle()
    const id = await cardId()
    const dm = card(['Удалил спам и заглушил автора', 'Участник: Carol', 'Категория: Решение админа'], 'купи крипту', 900)
    expect(h.tg.of('sendMessage').at(-1)!.args).toEqual([
      ADMIN.id,
      `${dm.text}\nРешение: сообщение удалено, участник заглушён. Admin, ${WHEN}`,
      [open(900), [button(id, 'Не спам, вернуть', 'restore')]],
      dm.entities,
    ])
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN2.id)).toEqual([])
  })
})

describe('section 3.6.3: observation mode keeps only karma punishments', () => {
  it('a punishment is not applied and gives no card; the admin screen shows what would apply', async () => {
    await h.close()
    h = await createHarness()
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
    await h.send(botJoined())
    await h.send(message({ id: 700, from: CAROL, text: 'привет' }))
    await h.app.settle()
    const { award } = await import('../src/karma.js')
    const { getSettings } = await import('../src/settings/settings.js')
    await award(h.db, { chatId: CHAT, userId: CAROL.id, delta: -12, reason: 'test', source: 'test', key: 'k1', now: h.clock.now(), settings: await getSettings(h.db, CHAT) })
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(0)
    expect(h.tg.of('sendMessage')).toEqual([])
    expect(await h.db.query(`SELECT kind, delivery FROM admin_cards`)).toEqual([{ kind: 'punish_skipped', delivery: 'screen' }])
  })
})

describe('migration 010: the "would do" cards are closed and never sent', () => {
  it('closes open would_do cards with obsolete', async () => {
    await h.db.query(`INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, created_at) VALUES ($1,'w1','would_do','{"messageId": 1}',$2), ($1,'r1','review','{"messageId": 2}',$2)`, [CHAT, h.clock.now()])
    await h.db.query(`DELETE FROM schema_migrations WHERE name = '010_card_decisions.sql'`)
    await h.db.query(`ALTER TABLE admin_cards DROP COLUMN decision`)
    await migrate(h.db)
    expect(await h.db.query(`SELECT kind, status, resolution FROM admin_cards ORDER BY card_id`)).toEqual([
      { kind: 'would_do', status: 'resolved', resolution: 'obsolete' },
      { kind: 'review', status: 'open', resolution: null },
    ])
    h.tg.admins = []
    await deliverCards(h.ctx)
    expect(h.tg.of('getChatAdministrators')).toHaveLength(1)
  })
})
