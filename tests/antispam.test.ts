import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_PERMISSIONS } from '../src/ops.js'
import { loadJokes } from '../src/sanctions.js'
import { tgError } from './support/fakes.js'
import {
  ADMIN,
  ALICE,
  CAROL,
  CHAT,
  DAY,
  botJoined,
  createHarness,
  edited,
  message,
  pastObservation,
  restartHarness,
  seedMember,
  setKarma,
  type Harness,
} from './support/harness.js'

const SPAM = 'Заработай 500 долларов в день без вложений, пиши в личку!'
const MILD = 'Посмотрите мой курс по промптам со скидкой'
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.jev.script(SPAM, { spam_earnings_crypto: 0.95 })
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const sanctionCalls = (): unknown[][] =>
  h.tg.calls.filter((c) => ['getChatMember', 'deleteMessage', 'restrictChatMember', 'banChatMember', 'sendMessage'].includes(c.method) && c.args[0] === CHAT).map((c) => [c.method, ...c.args])

const appealButton = [[{ text: 'Я не спамер', url: `https://t.me/jevchik_bot?startapp=appeal_${CHAT}` }]]
const joke = (name: string, idx = 0): string => loadJokes().replies[idx].replaceAll('{name}', name)

async function cardsTo(admin = ADMIN.id): Promise<Array<{ text: string; buttons: Array<Array<{ text: string; callback_data?: string }>> }>> {
  return h.tg.of('sendMessage').filter((c) => c.args[0] === admin).map((c) => ({ text: c.args[1] as string, buttons: c.args[2] as never }))
}

describe('F6: first counted message with spam', () => {
  it('deletes the message, restricts the author, sends one joke with the Mini App button and records the ban', async () => {
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(sanctionCalls()).toEqual([
      ['getChatMember', CHAT, CAROL.id],
      ['deleteMessage', CHAT, 700],
      ['restrictChatMember', CHAT, CAROL.id, NO_PERMISSIONS, undefined],
      ['sendMessage', CHAT, joke('Carol'), appealButton],
    ])
    const ban = (await h.db.query('SELECT category, state, joke_idx FROM bans WHERE chat_id = $1 AND user_id = $2', [CHAT, CAROL.id]))[0]
    expect(ban).toEqual({ category: 'spam_earnings_crypto', state: 'steam', joke_idx: 0 })
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([{ kind: 'steamed' }])
    const message700 = (await h.db.query('SELECT excerpt, deleted FROM messages WHERE message_id = 700'))[0]
    expect(message700).toEqual({ excerpt: null, deleted: true })
    const held = (await h.db.query('SELECT text FROM held_texts WHERE message_id = 700'))[0]
    expect(held.text).toBe(SPAM)
  })

  it('the joke comes from the set through the injected random source', async () => {
    await h.close()
    h = await createHarness({ rng: [0.99] })
    h.jev.script(SPAM, { spam_topic_pivot: 0.9 })
    await pastObservation(h)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    const last = loadJokes().replies.length - 1
    expect(h.tg.of('sendMessage')[0].args[1]).toBe(joke('Carol', last))
    expect((await h.db.query('SELECT category FROM bans'))[0].category).toBe('spam_topic_pivot')
  })
})

describe('F7: a harmless first message with an advertising profile', () => {
  it('gives the same outcome as F6, with the profile category', async () => {
    h.jev.script('Привет всем, я новенький', { profile_promo: 0.92 })
    await h.send(message({ id: 700, from: CAROL, text: 'Привет всем, я новенький' }))
    await h.app.settle()
    expect(sanctionCalls()).toEqual([
      ['getChatMember', CHAT, CAROL.id],
      ['deleteMessage', CHAT, 700],
      ['restrictChatMember', CHAT, CAROL.id, NO_PERMISSIONS, undefined],
      ['sendMessage', CHAT, joke('Carol'), appealButton],
    ])
    expect((await h.db.query('SELECT category FROM bans'))[0].category).toBe('profile_promo')
  })

  it('the profile (name, username, bio) reaches Jev only for the first message', async () => {
    h.tg.bios.set(CAROL.id, 'Крипта, сигналы, писать в лс')
    await h.send(message({ id: 700, from: { ...CAROL, username: 'carol_c' }, text: 'Привет' }))
    await h.app.settle()
    expect(h.jev.requests[0].state.sender_profile).toEqual({ name: 'Carol', username: 'carol_c', bio: 'Крипта, сигналы, писать в лс' })
  })

  it('T-profile-none: an unavailable bio is passed as null, the rest of the profile stays', async () => {
    h.tg.fail('getChat', tgError.bad('Bad Request: chat not found'))
    await h.send(message({ id: 700, from: CAROL, text: 'Привет' }))
    await h.app.settle()
    expect(h.jev.requests[0].state.sender_profile).toEqual({ name: 'Carol', username: null, bio: null })
  })
})

describe('rules 4 and 5 of section 3.6', () => {
  beforeEach(async () => {
    await h.send(message({ id: 600, from: CAROL, text: 'обычное первое сообщение' }))
    await h.app.settle()
    h.tg.calls.length = 0
  })

  it('rule 4 is cancelled (section 3.6.2): spam 0.60 from a newcomer stays in the chat and admins are asked', async () => {
    h.jev.script(MILD, { spam_other_offer: 0.6 })
    await h.send(message({ id: 701, from: CAROL, text: MILD }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(0)
    expect(h.tg.count('restrictChatMember')).toBe(0)
    expect(h.tg.count('banChatMember')).toBe(0)
    const cards = await cardsTo()
    expect(cards).toHaveLength(1)
    expect(cards[0].text).toContain('Похоже на спам, реши')
    expect(cards[0].text).toContain(MILD)
    expect(cards[0].buttons[0]).toEqual([{ text: 'Открыть сообщение', url: 'https://t.me/c/1234567890/701' }])
    expect(cards[0].buttons[1].map((b) => b.text)).toEqual(['Спам', 'Не спам'])
  })

  it('rule 5: from 0.30 the message stays and admins get a card', async () => {
    h.jev.script(MILD, { spam_other_offer: 0.35 })
    await h.send(message({ id: 701, from: CAROL, text: MILD }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(0)
    expect(await cardsTo()).toHaveLength(1)
  })

  it('rule 6: below 0.30 nothing happens', async () => {
    h.jev.script(MILD, { spam_other_offer: 0.29 })
    await h.send(message({ id: 701, from: CAROL, text: MILD }))
    await h.app.settle()
    expect(h.tg.calls.filter((c) => c.method !== 'getChat')).toEqual([])
  })

  it('a threshold at exactly the boundary counts (>=): 0.90 deletes', async () => {
    h.jev.script(MILD, { spam_other_offer: 0.9 })
    await h.send(message({ id: 701, from: CAROL, text: MILD }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(1)
  })

  it('a first message between 0.30 and 0.90 is neither deleted nor sent to the steam room, admins are asked', async () => {
    h.jev.script(MILD, { spam_other_offer: 0.89 })
    await h.send(message({ id: 800, from: { id: 50, first_name: 'Dave' }, text: MILD }))
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(0)
    expect(h.tg.count('deleteMessage')).toBe(0)
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([{ kind: 'review' }])
  })
})

describe('F10: participants with high karma are never punished by the bot', () => {
  it('protect: no restrict, no ban, no delete; admins get a card, also for the first message and the profile', async () => {
    await seedMember(h, CAROL, 100)
    h.jev.script('привет, я по профилю', { profile_promo: 0.95 })
    await h.send(message({ id: 700, from: CAROL, text: 'привет, я по профилю' }))
    await h.send(message({ id: 701, from: CAROL, text: SPAM }))
    await h.app.settle()
    for (const method of ['restrictChatMember', 'banChatMember', 'deleteMessage']) expect(h.tg.count(method)).toBe(0)
    const cards = await cardsTo()
    expect(cards).toHaveLength(2)
    expect(cards[0].text).toContain('высокой кармой')
  })

  it('soft check: a message with a link and spam 0.60 stays, admins get a card', async () => {
    await seedMember(h, CAROL, 150)
    h.jev.script('смотри https://example.com', { spam_other_offer: 0.6 })
    await h.send(message({ id: 700, from: CAROL, text: 'смотри https://example.com' }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(0)
    expect(await cardsTo()).toHaveLength(1)
  })

  it('just below the threshold the participant is treated like everybody else', async () => {
    await seedMember(h, CAROL, 99.9999)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(1)
    expect(h.tg.count('restrictChatMember')).toBe(1)
  })
})

describe('F8: from the steam room to the ban', () => {
  beforeEach(async () => {
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    h.tg.calls.length = 0
  })

  it('does not ban before the term and bans after 24 hours', async () => {
    h.clock.advance(23 * 3600_000)
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(0)
    h.clock.advance(2 * 3600_000)
    await h.app.settle()
    expect(h.tg.of('banChatMember').map((c) => c.args)).toEqual([[CHAT, CAROL.id]])
    expect((await h.db.query('SELECT state FROM bans'))[0].state).toBe('banned')
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(1)
  })

  it('an unban before the term cancels the transition', async () => {
    await h.db.query(`DELETE FROM bans WHERE user_id = $1`, [CAROL.id])
    h.clock.advance(30 * 3600_000)
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(0)
  })

  it('T-steam-restart: the term survives a restart of the process', async () => {
    h = await restartHarness(h)
    h.clock.advance(25 * 3600_000)
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(1)
  })

  it('T-ban-db-after-api: the ban call is not repeated when the state was not written', async () => {
    await h.db.query(`CREATE FUNCTION fail_ban() RETURNS trigger AS $$ BEGIN IF NEW.state = 'banned' THEN RAISE EXCEPTION 'db down'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`)
    await h.db.query(`CREATE TRIGGER fail_ban BEFORE UPDATE ON bans FOR EACH ROW EXECUTE FUNCTION fail_ban()`)
    h.clock.advance(25 * 3600_000)
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(1)
    expect((await h.db.query('SELECT state FROM bans'))[0].state).toBe('steam')
    await h.db.query('DROP TRIGGER fail_ban ON bans')
    h.clock.advance(60_000)
    await h.app.settle()
    expect(h.tg.count('banChatMember')).toBe(1)
    expect((await h.db.query('SELECT state FROM bans'))[0].state).toBe('banned')
  })
})

describe('steam room failures', () => {
  it('T-steam-half: deleted but not restricted: the retry resumes from the restrict step, one joke', async () => {
    h.tg.fail('restrictChatMember', tgError.server(), 2)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    for (let i = 0; i < 4; i++) {
      h.clock.advance(10_000)
      await h.app.settle()
    }
    expect(h.tg.count('deleteMessage')).toBe(1)
    expect(h.tg.count('restrictChatMember')).toBe(3)
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(1)
    expect(await h.db.query('SELECT 1 FROM bans')).toHaveLength(1)
  })

  it('T-steam-db-after-restrict: restricted, the ban record is created on retry and the restriction is not repeated', async () => {
    await h.db.query(`CREATE FUNCTION fail_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'db down'; END $$ LANGUAGE plpgsql`)
    await h.db.query(`CREATE TRIGGER fail_insert BEFORE INSERT ON bans FOR EACH ROW EXECUTE FUNCTION fail_insert()`)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(0)
    await h.db.query('DROP TRIGGER fail_insert ON bans')
    h.clock.advance(60_000)
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(await h.db.query('SELECT 1 FROM bans')).toHaveLength(1)
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(1)
  })

  it('T-steam-send-fail: a rejected joke ends the automaton without a reply; the record stays', async () => {
    h.tg.fail('sendMessage', tgError.bad('Forbidden: bot was kicked', 403))
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    h.clock.advance(60_000)
    await h.app.settle()
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(1)
    expect(await h.db.query('SELECT 1 FROM bans')).toHaveLength(1)
    expect((await h.db.query(`SELECT status FROM flows WHERE kind = 'steam'`))[0].status).toBe('completed')
    expect((await h.db.query(`SELECT status, last_error_code FROM operations WHERE operation_kind = 'send_message'`))[0]).toEqual({ status: 'failed', last_error_code: 'no_rights' })
  })

  it('T-send-down: network errors on the joke are retried up to three attempts, then failed', async () => {
    h.tg.fail('sendMessage', tgError.network(), 5)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    for (let i = 0; i < 6; i++) {
      await h.app.settle()
      h.clock.advance(20_000)
    }
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(3)
    expect((await h.db.query(`SELECT status, attempt_count, last_error_code FROM operations WHERE operation_kind = 'send_message'`))[0]).toEqual({ status: 'failed', attempt_count: 3, last_error_code: 'network' })
  })

  it('T-send-unknown: a lost answer after the request is outcome_unknown and is never repeated', async () => {
    h.tg.fail('sendMessage', tgError.lost())
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    for (let i = 0; i < 4; i++) {
      await h.app.settle()
      h.clock.advance(60_000)
    }
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(1)
    expect((await h.db.query(`SELECT status FROM operations WHERE operation_kind = 'send_message'`))[0].status).toBe('outcome_unknown')
  })

  it('T-steam-race: two spam messages at once give one record, one restriction and one joke', async () => {
    await Promise.all([h.send(message({ id: 700, from: CAROL, text: SPAM })), h.send(message({ id: 701, from: CAROL, text: SPAM }))])
    await h.app.settle()
    expect(await h.db.query('SELECT 1 FROM bans')).toHaveLength(1)
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(1)
    expect(h.tg.of('deleteMessage').map((c) => c.args[1]).sort()).toEqual([700, 701])
    expect((await h.db.query('SELECT bans_count FROM members WHERE user_id = $1', [CAROL.id]))[0].bans_count).toBe(1)
  })

  it('T-member-action-down: an exhausted restriction is failed, visible to admins, no ban record and no joke', async () => {
    h.tg.fail('restrictChatMember', tgError.server(), 3)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    for (let i = 0; i < 6; i++) {
      await h.app.settle()
      h.clock.advance(20_000)
    }
    expect((await h.db.query(`SELECT status, last_error_code FROM operations WHERE operation_kind = 'restrict'`))[0]).toEqual({ status: 'failed', last_error_code: 'server' })
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(0)
    expect((await cardsTo())[0].text).toContain('Не смог выполнить действие в Telegram')
  })

  it('T-no-rights: no permission to restrict gives a card and no ban record', async () => {
    h.tg.fail('restrictChatMember', tgError.bad('Forbidden: not enough rights to restrict/unrestrict chat member', 403))
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT)).toHaveLength(0)
    expect((await cardsTo())[0].text).toContain('Не хватило прав')
  })

  it('T-target-admin: an administrator is not sanctioned, admins get a card', async () => {
    h.tg.members.set(CAROL.id, 'administrator')
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    for (const method of ['deleteMessage', 'restrictChatMember', 'banChatMember']) expect(h.tg.count(method)).toBe(0)
    expect((await cardsTo())[0].text).toContain('админ')
  })

  it('T-target-admin: the restriction is refused for an administrator the pre-check missed', async () => {
    h.tg.fail('restrictChatMember', tgError.bad('Bad Request: user is an administrator of the chat'))
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect((await cardsTo())[0].text).toContain('админ')
  })

  it('T-del-gone: a message that is already gone counts as deleted and the steps continue', async () => {
    h.tg.fail('deleteMessage', tgError.bad('Bad Request: message to delete not found'))
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(await h.db.query('SELECT 1 FROM bans')).toHaveLength(1)
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([{ kind: 'steamed' }])
  })

  it('T-del-gone: a message older than 48 hours is treated the same way', async () => {
    h.tg.fail('deleteMessage', tgError.bad("Bad Request: message can't be deleted"))
    await h.send(message({ id: 700, from: CAROL, text: SPAM, date: '2026-09-01T12:00:00Z' }))
    await h.app.settle()
    expect(await h.db.query('SELECT 1 FROM bans')).toHaveLength(1)
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([{ kind: 'steamed' }])
  })

  it('T-del-denied: a refused deletion sends a card and the other steps continue', async () => {
    h.tg.fail('deleteMessage', tgError.bad("Bad Request: message can't be deleted for everyone"))
    await h.send(message({ id: 700, from: CAROL, text: SPAM, date: new Date(h.clock.now().getTime()).toISOString() }))
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(await h.db.query('SELECT 1 FROM bans')).toHaveLength(1)
    expect((await cardsTo())[0].text).toContain('Не смог удалить сообщение')
  })
})

describe('F23 with section 3.6.3: observation mode no longer touches spam, it keeps only karma punishments', () => {
  beforeEach(async () => {
    await h.close()
    h = await createHarness()
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
    h.jev.script(SPAM, { spam_earnings_crypto: 0.95 })
    await h.send(botJoined())
  })

  const punishCarol = async (key: string): Promise<void> => {
    const { award } = await import('../src/karma.js')
    const { getSettings } = await import('../src/settings/settings.js')
    await award(h.db, { chatId: CHAT, userId: CAROL.id, delta: -12, reason: 'test', source: 'test', key, now: h.clock.now(), settings: await getSettings(h.db, CHAT) })
    await h.app.settle()
  }

  it('spam in the first seven days is deleted and admins get «Удалил спам и заглушил автора», no "would do" card', async () => {
    h.clock.advance(3 * DAY)
    await h.send(message({ id: 700, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(h.tg.of('deleteMessage').map((c) => c.args)).toEqual([[CHAT, 700]])
    expect(h.tg.count('restrictChatMember')).toBe(1)
    const cards = await cardsTo()
    expect(cards).toHaveLength(1)
    expect(cards[0].text).toContain('Удалил спам и заглушил автора')
    expect(cards[0].text).not.toContain('наблюдени')
  })

  it('karma punishments are not applied before the boundary of seven days and are after it', async () => {
    await seedMember(h, CAROL)
    h.clock.advance(7 * DAY - 1000)
    await punishCarol('k1')
    expect(h.tg.count('restrictChatMember')).toBe(0)
    await h.db.query('UPDATE members SET karma = 0, punish_level = 0 WHERE user_id = $1', [CAROL.id])
    h.clock.advance(1000)
    await punishCarol('k2')
    expect(h.tg.count('restrictChatMember')).toBe(1)
  })

  it('an admin can extend the mode with observation_until: punishments stay off', async () => {
    const { changeSetting } = await import('../src/settings/settings.js')
    await changeSetting(h.db, { chatId: CHAT, key: 'observation_until', value: '2026-09-20T00:00:00Z', baseVersion: 0, actor: ADMIN.id, now: h.clock.now() })
    await seedMember(h, CAROL)
    h.clock.advance(10 * DAY)
    await punishCarol('k1')
    expect(h.tg.count('restrictChatMember')).toBe(0)
  })

  it('history import does not shift the start', async () => {
    const before = (await h.db.query('SELECT observation_started_at FROM chats'))[0].observation_started_at
    h.clock.advance(2 * DAY)
    await h.send(botJoined())
    expect((await h.db.query('SELECT observation_started_at FROM chats'))[0].observation_started_at).toEqual(before)
  })

  it('the state survives a restart', async () => {
    h.clock.advance(6 * DAY)
    h = await restartHarness(h)
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
    await seedMember(h, CAROL)
    await punishCarol('k1')
    expect(h.tg.count('restrictChatMember')).toBe(0)
  })
})

describe('T-edit and probation', () => {
  it('editing a benign first message into spam applies the ordinary first-message rule', async () => {
    await h.send(message({ id: 700, from: CAROL, text: 'Привет' }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(0)
    await h.send(edited({ id: 700, from: CAROL, text: SPAM, edit_date: '2026-09-09T12:30:00Z' }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(1)
    expect(await h.db.query('SELECT 1 FROM bans')).toHaveLength(1)
  })

  it('an edit never makes a message "first" and an unknown edited message is ignored', async () => {
    await h.send(message({ id: 700, from: CAROL, text: 'Привет' }))
    await h.send(edited({ id: 555, from: { id: 8, first_name: 'Eve' }, text: SPAM, edit_date: '2026-09-09T12:30:00Z' }))
    await h.app.settle()
    expect(await h.db.query('SELECT 1 FROM members WHERE user_id = 8 AND first_message_id IS NOT NULL')).toEqual([])
    expect(h.tg.count('deleteMessage')).toBe(0)
  })

  it('a sanction stays after a soft edit and admins get a card', async () => {
    await h.send(message({ id: 700, from: CAROL, text: 'Привет' }))
    await h.send(message({ id: 701, from: CAROL, text: SPAM }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(1)
    await h.send(edited({ id: 701, from: CAROL, text: 'Извините, ошибся', edit_date: '2026-09-09T12:30:00Z' }))
    await h.app.settle()
    expect(h.tg.count('deleteMessage')).toBe(1)
    expect((await cardsTo()).some((c) => c.text.includes('Автор исправил сообщение'))).toBe(true)
  })

  it('probation: the lowered threshold 0.30 applies and links are deleted', async () => {
    await seedMember(h, CAROL, 0)
    await h.db.query('UPDATE members SET probation_left = 5, first_message_id = 1 WHERE user_id = $1', [CAROL.id])
    h.jev.script('немного рекламы', { spam_other_offer: 0.35 })
    await h.send(message({ id: 700, from: CAROL, text: 'немного рекламы' }))
    await h.send(message({ id: 701, from: CAROL, text: 'глянь https://example.com/page' }))
    await h.app.settle()
    expect(h.tg.of('deleteMessage').map((c) => c.args[1])).toEqual([700, 701])
    expect((await h.db.query('SELECT probation_left FROM members WHERE user_id = $1', [CAROL.id]))[0].probation_left).toBe(3)
  })

  it('setKarma helper sanity', async () => {
    await seedMember(h, ALICE, 3)
    await setKarma(h, ALICE.id, 4)
    expect((await h.db.query('SELECT karma FROM members WHERE user_id = 1'))[0].karma).toBe(4)
  })
})
