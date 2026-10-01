import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN, BOB, CAROL, CHAT, command, createHarness, message, pastObservation, type Harness, type User } from './support/harness.js'

// Spec 3.6.0: messages not from people are not judged, do not count in karma or in the message count, and are never the
// target of /spam, /report or card buttons. People's replies to them are judged as usual.

const SPAM = 'Заработай 500 долларов в день без вложений, пиши в личку!'
const TELEGRAM: User = { id: 777000, first_name: 'Telegram' }
const CHANNEL_BOT: User = { id: 136817688, first_name: 'Channel', is_bot: true }
const CHANNEL = { id: -1005550001111, type: 'channel', title: 'Канал чата' }
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.tg.members.set(ADMIN.id, 'administrator')
  h.jev.script(SPAM, { spam_earnings_crypto: 0.99 })
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const autoForward = (id: number, text = SPAM) => message({ id, from: TELEGRAM, text, extra: { is_automatic_forward: true, sender_chat: CHANNEL, forward_origin: { type: 'channel', chat: CHANNEL, message_id: 5, date: 0 } } })
const sanctions = () => h.tg.calls.filter((c) => ['deleteMessage', 'restrictChatMember', 'banChatMember'].includes(c.method)).map((c) => [c.method, ...c.args])

describe('a post auto-forwarded from the linked channel', () => {
  it('is not judged, not deleted, and nobody is muted; it counts nowhere', async () => {
    await h.send(autoForward(700))
    await h.app.settle()
    expect(sanctions()).toEqual([])
    expect(h.jev.requests).toEqual([])
    expect(await h.db.query('SELECT 1 FROM messages')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM members WHERE user_id = 777000')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM admin_cards')).toEqual([])
  })

  it('a message on behalf of a chat or a channel (sender_chat) is not judged either', async () => {
    await h.send(message({ id: 701, from: CHANNEL_BOT, text: SPAM, extra: { sender_chat: CHANNEL } }))
    await h.send(message({ id: 702, from: { id: 1087968824, first_name: 'Group', is_bot: true }, text: SPAM, extra: { sender_chat: { id: CHAT, type: 'supergroup', title: 'c' } } }))
    await h.app.settle()
    expect(sanctions()).toEqual([])
    expect(h.jev.requests).toEqual([])
  })

  it('a service message of a member does not count: the fifth real message is still a newcomer one', async () => {
    await h.send(message({ id: 600, from: CAROL, extra: { new_chat_members: [CAROL] } }))
    for (let i = 1; i <= 4; i++) await h.send(message({ id: 600 + i, from: CAROL, text: `обычное ${i}` }))
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(h.tg.of('deleteMessage').map((c) => c.args)).toEqual([[CHAT, 700]])
    expect(await h.db.query('SELECT count(*)::int AS n FROM messages WHERE author_id = $1', [CAROL.id])).toEqual([{ n: 5 }])
  })

  it('a reply of a person to the post is judged as usual, the post gives context but gets no karma', async () => {
    await h.send(autoForward(700, 'Новости канала'))
    await h.send(message({ id: 701, from: BOB, text: 'Спасибо, полезно', extra: { reply_to_message: { message_id: 700, date: 0, chat: { id: CHAT, type: 'supergroup' }, from: TELEGRAM, sender_chat: CHANNEL, is_automatic_forward: true, text: 'Новости канала' } } }))
    h.jev.script('Спасибо, полезно', { is_thanks: 0.9 })
    await h.send(message({ id: 702, from: CAROL, text: SPAM, extra: { reply_to_message: { message_id: 700, date: 0, chat: { id: CHAT, type: 'supergroup' }, from: TELEGRAM, sender_chat: CHANNEL, is_automatic_forward: true, text: 'Новости канала' } } }))
    await h.app.settle()
    expect(h.jev.requests.map((r) => r.state.replied_to)).toEqual(['Канал чата: Новости канала', 'Канал чата: Новости канала'])
    expect(h.tg.of('deleteMessage').map((c) => c.args)).toEqual([[CHAT, 702]])
    expect(await h.db.query('SELECT 1 FROM karma_events WHERE user_id = 777000')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM members WHERE user_id = 777000')).toEqual([])
  })

  it('is never the target of /spam: the command is removed and the admin learns why', async () => {
    await h.send(autoForward(700))
    await h.send(command({ id: 950, from: ADMIN, text: '/spam', extra: { reply_to_message: { message_id: 700, date: 0, chat: { id: CHAT, type: 'supergroup' }, from: TELEGRAM, sender_chat: CHANNEL, is_automatic_forward: true, text: SPAM } } }))
    await h.app.settle()
    expect(sanctions()).toEqual([['deleteMessage', CHAT, 950]])
    expect(h.tg.of('sendMessage').map((c) => c.args.slice(0, 2))).toEqual([[ADMIN.id, `Команда /spam в чате «Chat ${CHAT}» не выполнена: сообщение отправлено не участником, а от имени канала или Telegram.`]])
  })

  it('is never the target of /report', async () => {
    await h.send(autoForward(700))
    await h.send(command({ id: 950, from: BOB, text: '/report', extra: { reply_to_message: { message_id: 700, date: 0, chat: { id: CHAT, type: 'supergroup' }, from: TELEGRAM, sender_chat: CHANNEL, is_automatic_forward: true, text: SPAM } } }))
    await h.app.settle()
    expect(sanctions()).toEqual([['deleteMessage', CHAT, 950]])
    expect(await h.db.query('SELECT 1 FROM admin_cards')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM reports')).toEqual([])
  })
})

describe('in a forum, a reply to the service message that created the topic is no reply', () => {
  const topicRoot = { message_id: 500, date: 0, chat: { id: CHAT, type: 'supergroup' }, from: BOB, forum_topic_created: { name: 'Тема', icon_color: 1 } }
  const inTopic = { is_topic_message: true, message_thread_id: 500, reply_to_message: topicRoot }

  it('/spam without a reply of its own is removed and nothing happens; the topic creator is not touched', async () => {
    await h.send(command({ id: 950, from: ADMIN, text: '/spam', extra: inTopic }))
    await h.app.settle()
    expect(sanctions()).toEqual([['deleteMessage', CHAT, 950]])
    expect(h.tg.of('getChatMember').map((c) => c.args[1])).toEqual([])
  })

  it('/report without a reply of its own is removed and gives no card', async () => {
    await h.send(command({ id: 950, from: CAROL, text: '/report', extra: inTopic }))
    await h.app.settle()
    expect(sanctions()).toEqual([['deleteMessage', CHAT, 950]])
    expect(await h.db.query('SELECT 1 FROM reports')).toEqual([])
  })

  it('an ordinary message in the topic is not a reply to the topic creator: no reply signal, no context line', async () => {
    await h.send(message({ id: 701, from: CAROL, text: 'Вопрос по теме', extra: inTopic }))
    await h.app.settle()
    expect(h.jev.requests[0].state.replied_to).toBeNull()
    expect(await h.db.query('SELECT reply_to_message_id FROM messages WHERE message_id = 701')).toEqual([{ reply_to_message_id: null }])
    expect(await h.db.query('SELECT 1 FROM messages WHERE message_id = 500')).toEqual([])
  })
})
