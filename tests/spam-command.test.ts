import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_PERMISSIONS } from '../src/ops.js'
import { runRetention } from '../src/scheduled.js'
import { loadJokes } from '../src/sanctions.js'
import { tgError } from './support/fakes.js'
import { ADMIN, ALICE, BOB, CHAT, botJoined, command, createHarness, message, pastObservation, setKarma, type Harness, type User } from './support/harness.js'

const TARGET = 'купи крипту, пиши в личку'
const BOT: User = { id: 555, first_name: 'OtherBot', is_bot: true }
let h: Harness

async function setUp(past: boolean): Promise<void> {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.tg.members.set(ADMIN.id, 'administrator')
  if (past) await pastObservation(h)
  else await h.send(botJoined())
  await h.send(message({ id: 900, from: ALICE, text: TARGET }))
  await h.app.settle()
  h.tg.calls.length = 0
}

beforeEach(async () => {
  await setUp(true)
})
afterEach(async () => {
  await h.close()
})

const spam = (options: { id?: number; from?: User; target?: number; targetFrom?: User; text?: string } = {}) =>
  command({
    id: options.id ?? 950,
    from: options.from ?? ADMIN,
    text: options.text ?? '/spam',
    reply_to: { message_id: options.target ?? 900, from: options.targetFrom ?? ALICE, text: TARGET },
  })

const calls = (): unknown[][] =>
  h.tg.calls
    .filter((c) => ['getChatMember', 'deleteMessage', 'restrictChatMember', 'banChatMember', 'sendMessage', 'unbanChatMember'].includes(c.method))
    .map((c) => [c.method, ...c.args])

const appealButton = [[{ text: 'Я не спамер', url: `https://t.me/jevchik_bot?startapp=appeal_${CHAT}` }]]
const CMD_CARD = [
  'Не смог удалить сообщение',
  'Сделал: удалить команду /spam не смог',
  'Участник: Admin',
  'Категория: не определена',
  'Уверенность: нет данных',
  'Текст недоступен, откройте сообщение по ссылке.',
  'Ссылка: https://t.me/c/1234567890/950',
].join('\n')
const joke = (name: string): string => loadJokes().replies[0].replaceAll('{name}', name)

/** The clock after pastObservation, in the chat time zone Asia/Tashkent. */
const AFTER = '09.09.2026 17:00'
const DM_HEAD = 'Удалил спам и заглушил автора\nУчастник: Alice (@alice)\nКатегория: Решение админа\n'

/** Section 3.6.2: the private answer to the admin after /spam: the result and «Не спам, вернуть». */
function answerToAdmin(card: number, when: string): unknown[] {
  return [
    'sendMessage',
    ADMIN.id,
    `${DM_HEAD}${TARGET}\nСсылка: https://t.me/c/1234567890/900\nРешение: сообщение удалено, участник заглушён. Admin, ${when}`,
    [[{ text: 'Открыть сообщение', url: 'https://t.me/c/1234567890/900' }], [{ text: 'Не спам, вернуть', callback_data: `c:${card}:restore` }]],
    [{ type: 'blockquote', offset: DM_HEAD.length, length: TARGET.length }],
  ]
}

const STEAM_CALLS = [
  ['getChatMember', CHAT, ADMIN.id],
  ['deleteMessage', CHAT, 950],
  ['getChatMember', CHAT, ALICE.id],
  ['deleteMessage', CHAT, 900],
  ['restrictChatMember', CHAT, ALICE.id, NO_PERMISSIONS, undefined],
  ['sendMessage', CHAT, joke('Alice'), appealButton],
]

const commandCard = async (): Promise<number> => Number((await h.db.query(`SELECT card_id FROM admin_cards WHERE kind = 'spam_command'`))[0].card_id)

async function expectSteamed(when = AFTER): Promise<void> {
  expect(calls()).toEqual([...STEAM_CALLS, answerToAdmin(await commandCard(), when)])
  expect(await h.db.query('SELECT user_id, category, state FROM bans')).toEqual([{ user_id: ALICE.id, category: 'admin', state: 'steam' }])
  expect(await h.db.query('SELECT text, reason FROM held_texts WHERE message_id = 900')).toEqual([{ text: TARGET, reason: 'spam' }])
  expect(await h.db.query('SELECT excerpt, deleted FROM messages WHERE message_id = 900')).toEqual([{ excerpt: null, deleted: true }])
  expect(await h.db.query('SELECT kind, payload->>\'recipient\' AS recipient FROM admin_cards')).toEqual([{ kind: 'spam_command', recipient: String(ADMIN.id) }])
}

describe('F29: the admin command /spam (section 3.6.0)', () => {
  it('action: the command and the message are removed, the author goes to the steam room with category admin, one joke with the button, the text is kept', async () => {
    await h.send(spam())
    await h.app.settle()
    await expectSteamed()
  })

  it('the steam room of /spam turns into a ban after its term, like any other', async () => {
    await h.send(spam())
    await h.app.settle()
    h.tg.calls.length = 0
    h.clock.advance(24 * 3600_000)
    await h.app.settle()
    expect(calls()).toEqual([['banChatMember', CHAT, ALICE.id]])
    expect((await h.db.query('SELECT state FROM bans'))[0].state).toBe('banned')
  })

  it('right: a sender who is not an admin gets nothing done, the command is removed, no answer in the chat', async () => {
    await h.send(spam({ from: BOB }))
    await h.app.settle()
    expect(calls()).toEqual([
      ['getChatMember', CHAT, BOB.id],
      ['deleteMessage', CHAT, 950],
    ])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
    expect(await h.db.query('SELECT deleted FROM messages WHERE message_id = 900')).toEqual([{ deleted: false }])
  })

  it('a refused command neither creates nor changes a kept text, before and after the check', async () => {
    await h.send(spam({ from: BOB }))
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
    await h.app.settle()
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
    const kept = new Date('2026-09-12T00:00:00Z')
    await h.db.query(`INSERT INTO held_texts (chat_id, message_id, author_id, author_name, text, reason, expires_at, created_at) VALUES ($1,900,$2,'Alice','старая копия','card',$3,$3)`, [CHAT, ALICE.id, kept])
    await h.send(spam({ from: BOB, id: 951 }))
    await h.app.settle()
    expect(await h.db.query('SELECT text, reason, expires_at, created_at FROM held_texts')).toEqual([{ text: 'старая копия', reason: 'card', expires_at: kept, created_at: kept }])
  })

  it('the text is kept only once the right is confirmed', async () => {
    await h.send(spam())
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
    await h.app.settle()
    expect(await h.db.query('SELECT text, reason FROM held_texts')).toEqual([{ text: TARGET, reason: 'spam' }])
    expect(JSON.stringify(await h.db.query(`SELECT data FROM flows WHERE kind = 'spam_command'`))).not.toContain(TARGET)
  })

  it('a refused command from a member, then an admin command on the same message: the kept text stays', async () => {
    await h.send(spam({ from: BOB, id: 950 }))
    await h.send(spam({ from: ADMIN, id: 951 }))
    await h.app.settle()
    expect(await h.db.query('SELECT text, reason FROM held_texts WHERE message_id = 900')).toEqual([{ text: TARGET, reason: 'spam' }])
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(h.tg.of('deleteMessage').map((c) => c.args[1]).sort()).toEqual([900, 950, 951])
  })

  it('a refused deletion of the command gives a card about it, and the sanction goes on', async () => {
    h.tg.fail('deleteMessage', tgError.bad("Bad Request: message can't be deleted"))
    await h.send(command({ id: 950, from: ADMIN, text: '/spam', date: h.clock.now().toISOString(), reply_to: { message_id: 900, from: ALICE, text: TARGET } }))
    await h.app.settle()
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['deleteMessage', CHAT, 950],
      ['sendMessage', ADMIN.id, CMD_CARD, [[{ text: 'Открыть сообщение', url: 'https://t.me/c/1234567890/950' }]]],
      ['getChatMember', CHAT, ALICE.id],
      ['deleteMessage', CHAT, 900],
      ['restrictChatMember', CHAT, ALICE.id, NO_PERMISSIONS, undefined],
      ['sendMessage', CHAT, joke('Alice'), appealButton],
      answerToAdmin(await commandCard(), AFTER),
    ])
    expect(await h.db.query('SELECT kind FROM admin_cards ORDER BY card_id')).toEqual([{ kind: 'delete_denied' }, { kind: 'spam_command' }])
  })

  it('/spam from an anonymous admin or on behalf of a channel: no sanction, only the command is removed', async () => {
    const anonymous = { id: 1087968824, first_name: 'Group', username: 'GroupAnonymousBot', is_bot: true }
    const channelBot = { id: 136817688, first_name: 'Channel', username: 'Channel_Bot', is_bot: true }
    const reply_to = { message_id: 900, from: ALICE, text: TARGET }
    await h.send(command({ id: 950, from: anonymous, text: '/spam', reply_to, extra: { sender_chat: { id: CHAT, type: 'supergroup', title: `Chat ${CHAT}` } } }))
    await h.send(command({ id: 951, from: channelBot, text: '/spam', reply_to, extra: { sender_chat: { id: -1005555, type: 'channel', title: 'Канал' } } }))
    await h.app.settle()
    expect(calls()).toEqual([
      ['deleteMessage', CHAT, 950],
      ['deleteMessage', CHAT, 951],
    ])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
  })

  it('the text carried by the command lives at most 24 hours in the flow; the cleanup erases it', async () => {
    await h.send(spam())
    const pending = async () => (await h.db.query(`SELECT data ? 'pending' AS p FROM flows WHERE kind = 'spam_command'`))[0].p
    expect(await pending()).toBe(true)
    h.clock.advance(24 * 3600_000 - 1000)
    await runRetention(h.ctx)
    expect(await pending()).toBe(true)
    h.clock.advance(2000)
    await runRetention(h.ctx)
    expect(await pending()).toBe(false)
    expect(JSON.stringify(await h.db.query('SELECT data FROM flows'))).not.toContain(TARGET)
  })

  it('a command refused because of the target removes the copy it made, and only that one', async () => {
    h.tg.members.set(ALICE.id, 'administrator')
    await h.send(spam())
    await h.app.settle()
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
    const kept = new Date('2026-09-12T00:00:00Z')
    await h.send(message({ id: 901, from: ALICE, text: 'ещё' }))
    await h.db.query(`INSERT INTO held_texts (chat_id, message_id, author_id, author_name, text, reason, expires_at, created_at) VALUES ($1,901,$2,'Alice','копия карточки','card',$3,$3)`, [CHAT, ALICE.id, kept])
    await h.send(spam({ id: 951, target: 901 }))
    await h.app.settle()
    expect(await h.db.query('SELECT text, reason, expires_at FROM held_texts')).toEqual([{ text: 'копия карточки', reason: 'card', expires_at: kept }])
  })

  it('a command refused because the role of the target cannot be checked removes its copy too', async () => {
    const original = h.tg.getChatMember.bind(h.tg)
    h.tg.getChatMember = async (chatId: number, userId: number) => {
      if (userId === ALICE.id) throw tgError.server()
      return original(chatId, userId)
    }
    await h.send(spam())
    for (let i = 0; i < 4; i++) {
      h.clock.advance(20_000)
      await h.app.settle()
    }
    expect(h.tg.count('restrictChatMember')).toBe(0)
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
  })

  it('right: the sender role is checked fresh; an unreachable Telegram means no right', async () => {
    h.tg.fail('getChatMember', tgError.network(), 3)
    await h.send(spam())
    await h.app.settle()
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['getChatMember', CHAT, ADMIN.id],
      ['getChatMember', CHAT, ADMIN.id],
      ['deleteMessage', CHAT, 950],
    ])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })

  it('the owner of the chat may use it too', async () => {
    h.tg.members.set(ADMIN.id, 'creator')
    await h.send(spam())
    await h.app.settle()
    await expectSteamed()
  })

  it('observation mode does not block the command: it is a human decision', async () => {
    await h.close()
    await setUp(false)
    await h.send(spam())
    await h.app.settle()
    await expectSteamed('01.09.2026 17:00')
  })

  it('target is an admin: nothing is done, the command is removed, the sender gets a private message with the reason', async () => {
    h.tg.members.set(ALICE.id, 'administrator')
    await h.send(spam())
    await h.app.settle()
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['deleteMessage', CHAT, 950],
      ['getChatMember', CHAT, ALICE.id],
      ['sendMessage', ADMIN.id, `Команда /spam в чате «Chat ${CHAT}» не выполнена: Alice - админ или владелец чата.`, undefined],
    ])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT deleted FROM messages WHERE message_id = 900')).toEqual([{ deleted: false }])
  })

  it('target is the owner: the same refusal', async () => {
    h.tg.members.set(ALICE.id, 'creator')
    await h.send(spam())
    await h.app.settle()
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['deleteMessage', CHAT, 950],
      ['getChatMember', CHAT, ALICE.id],
      ['sendMessage', ADMIN.id, `Команда /spam в чате «Chat ${CHAT}» не выполнена: Alice - админ или владелец чата.`, undefined],
    ])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })

  it('target is a bot: nothing is done, the command is removed, the sender gets a private message with the reason', async () => {
    await h.send(spam({ target: 901, targetFrom: BOT }))
    await h.app.settle()
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['deleteMessage', CHAT, 950],
      ['sendMessage', ADMIN.id, `Команда /spam в чате «Chat ${CHAT}» не выполнена: сообщение отправил бот.`, undefined],
    ])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })

  it('a command without a reply is removed and nothing happens', async () => {
    await h.send(command({ id: 950, from: ADMIN, text: '/spam' }))
    await h.app.settle()
    expect(calls()).toEqual([['deleteMessage', CHAT, 950]])
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
  })

  it('a repeated command on the same message does nothing the second time (the command itself is removed)', async () => {
    await h.send(spam({ id: 950 }))
    await h.app.settle()
    h.tg.calls.length = 0
    await h.send(spam({ id: 951 }))
    await h.app.settle()
    expect(calls()).toEqual([
      ['getChatMember', CHAT, ADMIN.id],
      ['deleteMessage', CHAT, 951],
    ])
    expect(await h.db.query('SELECT 1 FROM bans')).toHaveLength(1)
  })

  it('two commands on the same message at once give one sanction and one joke', async () => {
    await h.send(spam({ id: 950 }))
    await h.send(spam({ id: 951 }))
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(1)
    expect(h.tg.of('deleteMessage').map((c) => c.args[1]).sort()).toEqual([900, 950, 951])
  })

  it('the protection of high karma does not apply to the command', async () => {
    await setKarma(h, ALICE.id, 500)
    await h.send(spam())
    await h.app.settle()
    await expectSteamed()
  })

  it('/spam@<bot name> is the same command; a command for another bot is not', async () => {
    await h.send(spam({ text: '/spam@jevchik_bot' }))
    await h.app.settle()
    await expectSteamed()
    h.tg.calls.length = 0
    await h.send(message({ id: 910, from: BOB, text: 'ещё одно' }))
    await h.send(command({ id: 960, from: ADMIN, text: '/spam@other_bot', reply_to: { message_id: 910, from: BOB, text: 'ещё одно' } }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(0)
  })

  it('the command is not sent to Jev', async () => {
    h.jev.requests.length = 0
    await h.send(spam())
    await h.app.settle()
    expect(h.jev.requests).toEqual([])
  })
})
