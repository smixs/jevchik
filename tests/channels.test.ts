import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appealState, submitAppeal } from '../src/appeal.js'
import { parseExport, startImport } from '../src/import.js'
import { loadJokes } from '../src/sanctions.js'
import { banList } from '../src/web/queries.js'
import { tgError } from './support/fakes.js'
import { ADMIN, ALICE, BOB, CAROL, CHAT, DAY, command, createHarness, callback, edited, eventsOf, karmaOf, message, pastObservation, reaction, setKarma, type Harness, type User } from './support/harness.js'
import { VECTORS } from './support/vectors.js'
import { get, makeWeb, seedWorld } from './support/web.js'

// F31, section 3.6.4: a channel that writes in the group is a member. It gets karma by the common rules, no tag and no karma
// punishment; a new channel with spam is deleted and banned (banChatSenderChat); /spam, /report and import work for it.

const SPAM = 'Заработай 500 долларов в день без вложений, пиши в личку!'
const MILD = 'Посмотрите мой курс по промптам со скидкой'
const TARGET = 'купи крипту, пиши в личку'
const CHANNEL = { id: -1005550001111, type: 'channel', title: 'Канал Васи', username: 'vasya_channel' }
const CHANNEL_BOT: User = { id: 136817688, first_name: 'Channel', username: 'Channel_Bot', is_bot: true }
const TELEGRAM: User = { id: 777000, first_name: 'Telegram' }
const ANONYMOUS: User = { id: 1087968824, first_name: 'Group', username: 'GroupAnonymousBot', is_bot: true }
const LINKED = { id: -1009990001111, type: 'channel', title: 'Привязанный канал' }
const LINK = (id: number): string => `https://t.me/c/1234567890/${id}`
/** The clock after pastObservation, in the chat time zone Asia/Tashkent. */
const WHEN = '09.09.2026 17:00'
const T0_SECONDS = Math.floor(Date.parse('2026-09-01T12:00:00Z') / 1000)
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.tg.members.set(ADMIN.id, 'administrator')
  h.jev.script(SPAM, { spam_earnings_crypto: 0.95 })
  h.jev.script(MILD, { spam_other_offer: 0.6 })
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const post = (id: number, text: string, extra: Record<string, unknown> = {}) => message({ id, from: CHANNEL_BOT, text, extra: { sender_chat: CHANNEL, ...extra } })
const answersPost = (id: number, text: string) => ({
  reply_to_message: { message_id: id, date: T0_SECONDS - 1, chat: { id: CHAT, type: 'supergroup' }, from: CHANNEL_BOT, sender_chat: CHANNEL, text },
})

const METHODS = [
  'getChatMember',
  'getChat',
  'deleteMessage',
  'restrictChatMember',
  'banChatMember',
  'unbanChatMember',
  'banChatSenderChat',
  'unbanChatSenderChat',
  'setChatMemberTag',
  'sendMessage',
  'editMessageText',
  'answerCallbackQuery',
]
const calls = (): unknown[][] => h.tg.calls.filter((c) => METHODS.includes(c.method)).map((c) => [c.method, ...c.args])
const open = (id: number) => [{ text: 'Открыть сообщение', url: LINK(id) }]
const button = (card: number, text: string, action: string) => ({ text, callback_data: `c:${card}:${action}` })
const joke = (name: string): string => loadJokes().replies[0].replaceAll('{name}', name)

function card(head: string[], quote: string, id: number): { text: string; entities: unknown[] } {
  const before = head.join('\n') + '\n'
  return { text: `${before}${quote}\nСсылка: ${LINK(id)}`, entities: [{ type: 'blockquote', offset: before.length, length: quote.length }] }
}

const MEMBER = 'Участник: Канал Васи (@vasya_channel)'
const BANNED = card(['Удалил спам и забанил канал', MEMBER, 'Категория: Лёгкие деньги и крипта', 'Уверенность: 95%'], SPAM, 700)
const REVIEW = card(['Похоже на спам, реши', MEMBER, 'Категория: Навязчивая реклама', 'Уверенность: 60%'], MILD, 701)

async function lastCard(): Promise<number> {
  return Number((await h.db.query('SELECT card_id FROM admin_cards ORDER BY card_id DESC LIMIT 1'))[0].card_id)
}

async function cardMessage(id: number): Promise<number> {
  const rows = await h.db.query(`SELECT result->>'message_id' AS m FROM operations WHERE idempotency_key = $1`, [`card:${id}:${ADMIN.id}`])
  return Number(rows[0].m)
}

async function press(id: number, action: string, cb = 'cb1'): Promise<void> {
  await h.send(callback({ data: `c:${id}:${action}`, from: ADMIN, id: cb }))
  await h.app.settle()
}

async function settled(): Promise<void> {
  await h.app.settle()
  h.tg.calls.length = 0
}

describe('F31: who is a channel author (section 3.6.4)', () => {
  it('a message with sender_chat of another chat, not auto-forwarded: the channel is a member with its title, username and the mark', async () => {
    await h.send(post(700, 'Привет из канала'))
    await h.app.settle()
    expect(await h.db.query('SELECT user_id, display_name, username, is_channel, is_bot, joined_seen_at IS NOT NULL AS joined FROM members WHERE user_id IN ($1, $2)', [CHANNEL.id, CHANNEL_BOT.id])).toEqual([
      { user_id: CHANNEL.id, display_name: 'Канал Васи', username: 'vasya_channel', is_channel: true, is_bot: false, joined: true },
    ])
    expect(await h.db.query('SELECT message_id, author_id FROM messages')).toEqual([{ message_id: 700, author_id: CHANNEL.id }])
    expect(h.jev.requests.map((r) => [r.state.message, r.state.sender_history, r.state.sender_profile])).toEqual([['Привет из канала', 'first message of this sender in the chat', null]])
    expect(Object.keys(h.jev.requests[0].questions)).not.toContain('profile_promo')
  })

  it('an auto-forwarded post of the linked channel and an anonymous admin are still not judged and get no karma, even for replies', async () => {
    const forward = { from: TELEGRAM, sender_chat: LINKED, is_automatic_forward: true }
    const anonymous = { from: ANONYMOUS, sender_chat: { id: CHAT, type: 'supergroup', title: `Chat ${CHAT}` } }
    await h.send(message({ id: 700, from: TELEGRAM, text: SPAM, extra: { sender_chat: LINKED, is_automatic_forward: true } }))
    await h.send(message({ id: 701, from: ANONYMOUS, text: SPAM, extra: { sender_chat: anonymous.sender_chat } }))
    const replyTo = (id: number, who: Record<string, unknown>) => ({ reply_to_message: { message_id: id, date: T0_SECONDS - 1, chat: { id: CHAT, type: 'supergroup' }, text: SPAM, ...who } })
    await h.send(message({ id: 702, from: BOB, text: 'Ответ на пост', extra: replyTo(700, forward) }))
    await h.send(message({ id: 703, from: BOB, text: 'Ответ админу', extra: replyTo(701, anonymous) }))
    await h.send(reaction({ message_id: 700, from: CAROL, new: ['👍'] }))
    await h.app.settle()
    expect(h.jev.requests.map((r) => r.state.message)).toEqual(['Ответ на пост', 'Ответ админу'])
    expect(await h.db.query('SELECT DISTINCT author_id FROM messages')).toEqual([{ author_id: BOB.id }])
    expect(await h.db.query('SELECT user_id FROM members WHERE user_id = ANY($1)', [[TELEGRAM.id, ANONYMOUS.id, LINKED.id, CHAT]])).toEqual([])
    expect(await h.db.query('SELECT 1 FROM karma_events')).toEqual([])
    expect(calls().filter((c) => c[0] !== 'getChat')).toEqual([])
  })
})

describe('F31: karma of a channel (section 3.6.4)', () => {
  it('a reply and a reaction to its post give it karma; no tag is set for it, while a person gets one', async () => {
    await h.send(post(700, 'Пост канала'))
    await h.send(message({ id: 701, from: BOB, text: 'Отличный пост', extra: answersPost(700, 'Пост канала') }))
    await h.app.settle()
    await h.send(reaction({ message_id: 700, from: CAROL, new: ['👍'] }))
    await h.app.settle()
    expect(await eventsOf(h, CHANNEL.id)).toEqual([
      { delta: 2.1, reason: 'ladder_reply' },
      // The reaction is the second signal under the post: message_factor(2) = 1 / (1 + ln 2), times the series boost 1.05.
      { delta: 0.6201, reason: 'reaction_plus' },
    ])
    expect(await karmaOf(h, CHANNEL.id)).toBe(2.7201)
    await h.send(reaction({ message_id: 701, from: CAROL, new: ['👍'] }))
    await h.app.settle()
    expect(await h.db.query(`SELECT (payload->>'userId')::bigint AS user_id FROM operations WHERE operation_kind = 'set_tag'`)).toEqual([{ user_id: BOB.id }])
    expect(h.tg.of('setChatMemberTag').map((c) => c.args)).toEqual([[CHAT, BOB.id, '+1']])
  })

  it('a reaction put on behalf of a channel counts as before: no voter weight, no member row for the reacting channel', async () => {
    await h.send(message({ id: 700, from: ALICE, text: 'полезное сообщение' }))
    await h.app.settle()
    await h.send(reaction({ message_id: 700, actor_chat: LINKED.id, new: ['👍'] }))
    expect(await eventsOf(h, ALICE.id)).toEqual([{ delta: 1.05, reason: 'reaction_plus' }])
    expect(await h.db.query('SELECT 1 FROM members WHERE user_id = $1', [LINKED.id])).toEqual([])
  })

  it('a channel reacting to its own post changes nothing, like a person reacting to themselves (F3)', async () => {
    await h.send(post(700, 'Пост канала'))
    await h.app.settle()
    await h.send(reaction({ message_id: 700, actor_chat: CHANNEL.id, new: ['👍'] }))
    expect(await eventsOf(h, CHANNEL.id)).toEqual([])
    expect(await h.db.query('SELECT 1 FROM reactions')).toEqual([])
  })

  it('karma below the punishment threshold restricts nobody: no punishment flow, no Telegram call', async () => {
    await h.send(post(700, 'Пост канала'))
    await h.send(message({ id: 701, from: ALICE, text: 'привет' }))
    await h.app.settle()
    await setKarma(h, CHANNEL.id, -9.5)
    await setKarma(h, ALICE.id, 5)
    h.tg.calls.length = 0
    await h.send(reaction({ message_id: 700, from: ALICE, new: ['👎'] }))
    await h.app.settle()
    expect(await karmaOf(h, CHANNEL.id)).toBe(-10.5488)
    expect(await h.db.query(`SELECT kind FROM flows WHERE kind IN ('punish', 'unpunish')`)).toEqual([])
    expect(await h.db.query('SELECT punish_level FROM members WHERE user_id = $1', [CHANNEL.id])).toEqual([{ punish_level: 0 }])
    expect(calls()).toEqual([])
  })
})

describe('F31: spam of a new channel (section 3.6.4)', () => {
  it('a new channel with spam 0.95: deleted, the channel banned, a bath record, a joke without the appeal button, the card', async () => {
    await h.send(post(700, SPAM))
    await h.app.settle()
    const id = await lastCard()
    expect(calls()).toEqual([
      ['deleteMessage', CHAT, 700],
      ['banChatSenderChat', CHAT, CHANNEL.id],
      ['sendMessage', CHAT, joke('Канал Васи'), undefined],
      ['sendMessage', ADMIN.id, BANNED.text, [open(700), [button(id, 'Не спам, вернуть', 'restore')]], BANNED.entities],
    ])
    expect(await h.db.query('SELECT user_id, category, state FROM bans')).toEqual([{ user_id: CHANNEL.id, category: 'spam_earnings_crypto', state: 'banned' }])
    expect(await h.db.query('SELECT deleted FROM messages WHERE message_id = 700')).toEqual([{ deleted: true }])
    expect((await banList(h.ctx, CHAT)).map((b) => (b as { name: string }).name)).toEqual(['К***'])
    expect(await h.db.query(`SELECT operation_kind, status FROM operations WHERE operation_kind LIKE '%sender_chat' ORDER BY operation_id`)).toEqual([
      { operation_kind: 'ban_sender_chat', status: 'completed' },
    ])
  })

  it('the ban stays a ban: no steam-room term runs out for a channel', async () => {
    await h.send(post(700, SPAM))
    await settled()
    h.clock.advance(2 * DAY)
    await h.app.settle()
    expect(calls()).toEqual([])
    expect(await h.db.query('SELECT state FROM bans')).toEqual([{ state: 'banned' }])
  })

  it('«Не спам, вернуть»: the ban of the channel is lifted, the record removed, the text published by the bot', async () => {
    await h.send(post(700, SPAM))
    await settled()
    const id = await lastCard()
    const mid = await cardMessage(id)
    await press(id, 'restore')
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['unbanChatSenderChat', CHAT, CHANNEL.id],
      ['sendMessage', CHAT, `Канал Васи: ${SPAM}`, undefined],
      ['answerCallbackQuery', 'cb1', 'Бан снят, запись в бане удалена, сообщение возвращено в чат'],
      ['editMessageText', ADMIN.id, mid, `${BANNED.text}\nРешение: бан снят, запись в бане удалена, сообщение возвращено в чат. Admin, ${WHEN}`, [open(700)], BANNED.entities],
    ])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })

  it('a refused banChatSenderChat follows the general rule of kept operations: no record, no joke, a card about the rights', async () => {
    h.tg.fail('banChatSenderChat', tgError.bad('Bad Request: not enough rights to restrict/ban chat member'))
    await h.send(post(700, SPAM))
    await h.app.settle()
    expect(calls().map((c) => c.slice(0, 2))).toEqual([
      ['deleteMessage', CHAT],
      ['banChatSenderChat', CHAT],
      ['sendMessage', ADMIN.id],
    ])
    expect(await h.db.query(`SELECT status, last_error_code FROM operations WHERE operation_kind = 'ban_sender_chat'`)).toEqual([{ status: 'failed', last_error_code: 'no_rights' }])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([{ kind: 'no_rights' }])
  })

  it('from spam_review_threshold to the threshold: a card with «Спам» and «Не спам»; «Спам» deletes and bans the channel', async () => {
    await h.send(post(600, 'обычный пост'))
    await h.send(post(701, MILD))
    await h.app.settle()
    const id = await lastCard()
    expect(calls()).toEqual([['sendMessage', ADMIN.id, REVIEW.text, [open(701), [button(id, 'Спам', 'spam'), button(id, 'Не спам', 'notspam')]], REVIEW.entities]])
    h.tg.calls.length = 0
    const mid = await cardMessage(id)
    await press(id, 'spam')
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['deleteMessage', CHAT, 701],
      ['banChatSenderChat', CHAT, CHANNEL.id],
      ['sendMessage', CHAT, joke('Канал Васи'), undefined],
      ['answerCallbackQuery', 'cb1', 'Сообщение удалено, участник забанен'],
      ['editMessageText', ADMIN.id, mid, `${REVIEW.text}\nРешение: сообщение удалено, участник забанен. Admin, ${WHEN}`, [open(701), [button(id, 'Не спам, вернуть', 'restore')]], REVIEW.entities],
    ])
    expect(await h.db.query('SELECT user_id, state FROM bans')).toEqual([{ user_id: CHANNEL.id, state: 'banned' }])
  })

  it('an edit of a post by the channel is judged like any edit: crossing the threshold deletes and bans', async () => {
    await h.send(post(700, 'обычный пост'))
    await settled()
    const update = edited({ id: 700, from: CHANNEL_BOT, text: SPAM, edit_date: '2026-09-01T12:05:00Z', extra: { sender_chat: CHANNEL } })
    await h.send(update)
    await h.app.settle()
    expect(calls().slice(0, 3)).toEqual([
      ['deleteMessage', CHAT, 700],
      ['banChatSenderChat', CHAT, CHANNEL.id],
      ['sendMessage', CHAT, joke('Канал Васи'), undefined],
    ])
  })

  it('a channel past spam_newcomer_messages is not judged by the text', async () => {
    for (let i = 1; i <= 5; i++) await h.send(post(600 + i, `пост ${i}`))
    await h.send(post(700, SPAM))
    await h.app.settle()
    expect(calls()).toEqual([])
    expect(await h.db.query('SELECT 1 FROM admin_cards')).toEqual([])
  })

  it('the Mini App has no appeal for a channel', async () => {
    await h.send(post(700, SPAM))
    await settled()
    const asked = h.jev.requests.length
    expect(await submitAppeal(h.ctx, CHAT, CHANNEL.id, 'Я живой человек, ошибся')).toEqual({ status: 'not_allowed' })
    expect(await appealState(h.ctx, CHAT, CHANNEL.id)).toEqual({ status: 'none', allowed: false })
    expect(h.jev.requests).toHaveLength(asked)
    expect(await h.db.query('SELECT appeal_status FROM bans')).toEqual([{ appeal_status: 'none' }])
    expect(calls()).toEqual([])
  })
})

describe('F31: /spam and /report on a message of a channel (section 3.6.4)', () => {
  it('/spam: the command and the message are removed, the channel is banned without a role check, the admin gets the result', async () => {
    await h.send(post(900, TARGET))
    await settled()
    await h.send(command({ id: 950, from: ADMIN, text: '/spam', extra: answersPost(900, TARGET) }))
    await h.app.settle()
    const id = await lastCard()
    const head = `Удалил спам и забанил канал\n${MEMBER}\nКатегория: Решение админа\n`
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['deleteMessage', CHAT, 950],
      ['deleteMessage', CHAT, 900],
      ['banChatSenderChat', CHAT, CHANNEL.id],
      ['sendMessage', CHAT, joke('Канал Васи'), undefined],
      [
        'sendMessage',
        ADMIN.id,
        `${head}${TARGET}\nСсылка: ${LINK(900)}\nРешение: сообщение удалено, участник забанен. Admin, ${WHEN}`,
        [open(900), [button(id, 'Не спам, вернуть', 'restore')]],
        [{ type: 'blockquote', offset: head.length, length: TARGET.length }],
      ],
    ])
    expect(await h.db.query('SELECT user_id, category, state FROM bans')).toEqual([{ user_id: CHANNEL.id, category: 'admin', state: 'banned' }])
    expect(await h.db.query('SELECT text, reason FROM held_texts WHERE message_id = 900')).toEqual([{ text: TARGET, reason: 'spam' }])
  })

  it('/report: the command is removed, admins get the report card about the channel, no role check of the channel', async () => {
    h.jev.script(TARGET, { spam_other_offer: 0.2 })
    await h.send(post(900, TARGET))
    await settled()
    await h.send(command({ id: 950, from: BOB, text: '/report', extra: answersPost(900, TARGET) }))
    await h.app.settle()
    const id = await lastCard()
    const report = card(['Жалоба на сообщение', 'Сделал: ничего, сообщение осталось в чате до решения админа', MEMBER, 'Категория: Навязчивая реклама', 'Уверенность: 20%'], TARGET, 900)
    expect(calls()).toEqual([
      ['deleteMessage', CHAT, 950],
      ['sendMessage', ADMIN.id, report.text, [open(900), [button(id, 'Подтвердить', 'confirm'), button(id, 'Вернуть', 'return')]], report.entities],
    ])
    expect(await h.db.query('SELECT target_user_id, reporter_id, status FROM reports')).toEqual([{ target_user_id: CHANNEL.id, reporter_id: BOB.id, status: 'open' }])
  })
})

describe('F31: import of a channel (sections 3.6.4 and 3.11)', () => {
  const EXPORT_ID = 1234567890
  const iso = (daysAgo: number): string => new Date(h.clock.now().getTime() - daysAgo * DAY).toISOString()
  const fromChannel = { from: 'Канал Васи', from_id: 'channel5550001111' }

  function build(messages: Array<Record<string, unknown> & { date: string }>): Buffer {
    const out = messages.map((m) => ({ type: 'message', ...m, date_unixtime: String(Math.floor(Date.parse(m.date) / 1000)), date: m.date.replace('Z', '') }))
    return Buffer.from(JSON.stringify({ name: 'Chat', type: 'private_supergroup', id: EXPORT_ID, messages: out }))
  }

  async function load(body: Buffer): Promise<void> {
    expect(await startImport(h.ctx, CHAT, ADMIN.id, body)).toMatchObject({ ok: true })
    for (let i = 0; i < 10; i++) {
      await h.app.settle()
      h.clock.advance(40_000)
    }
  }

  it('from_id channel<id> becomes the channel -100<id>', () => {
    const parsed = parseExport(build([{ id: 4, ...fromChannel, text: 'x', date: '2026-09-01T00:00:00Z' }]).toString('utf8'))
    expect(parsed?.messages.map((m) => [m.id, m.authorId, m.author])).toEqual([[4, CHANNEL.id, 'Канал Васи']])
  })

  it('imported posts are messages of the channel with karma; loading the file again adds only what is missing', async () => {
    const first = [{ id: 10, ...fromChannel, text: 'Пост канала', date: iso(3), reactions: [{ type: 'emoji', emoji: '👍', count: 2 }] }]
    await load(build(first))
    expect(await h.db.query('SELECT display_name, is_channel, joined_seen_at FROM members WHERE user_id = $1', [CHANNEL.id])).toEqual([{ display_name: 'Канал Васи', is_channel: true, joined_seen_at: null }])
    expect(await eventsOf(h, CHANNEL.id)).toEqual([{ delta: 1.6701, reason: 'reaction_plus' }])
    expect(h.jev.requests.map((r) => r.state.message)).toEqual(['Пост канала'])
    await load(build([...first, { id: 11, ...fromChannel, text: 'Второй пост', date: iso(2) }]))
    expect(await h.db.query('SELECT message_id FROM messages WHERE author_id = $1 ORDER BY message_id', [CHANNEL.id])).toEqual([{ message_id: 10 }, { message_id: 11 }])
    expect(await eventsOf(h, CHANNEL.id)).toEqual([{ delta: 1.6701, reason: 'reaction_plus' }])
    expect(h.jev.requests.map((r) => r.state.message)).toEqual(['Пост канала', 'Второй пост'])
  })

  it('a channel with imported posts is no newcomer: its spam is not judged', async () => {
    await load(build([{ id: 10, ...fromChannel, text: 'Пост канала', date: iso(3) }]))
    await settled()
    await h.send(post(700, SPAM))
    await h.app.settle()
    expect(calls()).toEqual([])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM admin_cards')).toEqual([])
  })

  it('a channel first seen live and then found in an imported history is no newcomer any more', async () => {
    await h.send(post(600, 'обычный пост'))
    await h.app.settle()
    await load(build([{ id: 10, ...fromChannel, text: 'Пост канала', date: iso(3) }]))
    await settled()
    await h.send(post(700, SPAM))
    await h.app.settle()
    expect(calls()).toEqual([])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })
})

describe('F31: the Mini App API marks a channel (section 3.6.4)', () => {
  it('is_channel in every leaderboard row and on the member page', async () => {
    await h.close()
    h = await createHarness()
    await seedWorld(h)
    const web = await makeWeb(h)
    await h.db.query(`INSERT INTO members (chat_id, user_id, display_name, username, karma, is_channel, created_at) VALUES ($1,$2,'Канал Васи','vasya_channel',50,true,$3)`, [CHAT, CHANNEL.id, h.clock.now()])
    const board = await (await get(web, '/api/leaderboard?period=all', VECTORS.bob_lb)).json()
    expect(board.rows.map((r: { name: string; karma: number; is_channel: boolean }) => [r.name, r.karma, r.is_channel])).toEqual([
      ['Канал Васи', 50, true],
      ['Alice', 12.5, false],
      ['Bob', 7.25, false],
      ['Carol', 3, false],
    ])
    const page = await (await get(web, `/api/members/${board.rows[0].public_id}`, VECTORS.bob_lb)).json()
    expect([page.name, page.karma, page.place, page.is_channel]).toEqual(['Канал Васи', 50, 1, true])
    const alice = await (await get(web, `/api/members/${board.rows[1].public_id}`, VECTORS.bob_lb)).json()
    expect(alice.is_channel).toBe(false)
  })
})
