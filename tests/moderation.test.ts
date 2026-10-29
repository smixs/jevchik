import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memberPage } from '../src/web/queries.js'
import { tgError } from './support/fakes.js'
import { ADMIN, ALICE, BOB, CAROL, CHAT, callback, command, createHarness, eventsOf, karmaOf, message, pastObservation, reaction, seedMember, type Harness } from './support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.tg.members.set(ADMIN.id, 'administrator')
  await pastObservation(h)
  await h.send(message({ id: 900, from: ALICE, text: 'плохое сообщение' }))
  await h.app.settle()
  h.tg.calls.length = 0
})
afterEach(async () => {
  await h.close()
})

const report = (from = BOB, id = 950, target = 900, targetFrom = ALICE, text = 'плохое сообщение') =>
  command({ id, from, text: '/report', reply_to: { message_id: target, from: targetFrom, text } })
const deletes = (): number[] => h.tg.of('deleteMessage').map((c) => c.args[1] as number)
const adminCards = () => h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id)
const buttons = (i = 0) => (adminCards()[i].args[2] as Array<Array<{ text: string; callback_data: string }>>)[1]

describe('F15: /report', () => {
  it('an ordinary reporter: the command is removed, the message stays, admins get a card with two buttons', async () => {
    await h.send(report())
    await h.app.settle()
    expect(deletes()).toEqual([950])
    expect(adminCards()).toHaveLength(1)
    expect(adminCards()[0].args[1]).toContain('Жалоба на сообщение')
    expect(adminCards()[0].args[1]).toContain('плохое сообщение')
    expect(buttons().map((b) => b.text)).toEqual(['Подтвердить', 'Вернуть'])
  })

  it('a reporter with karma at the protection threshold: the message goes away at once, its text is kept for admins', async () => {
    await seedMember(h, CAROL, 100)
    await h.send(report(CAROL))
    await h.app.settle()
    expect(deletes().sort()).toEqual([900, 950])
    const held = (await h.db.query('SELECT text, reason FROM held_texts WHERE message_id = 900'))[0]
    expect(held).toEqual({ text: 'плохое сообщение', reason: 'report' })
    expect(adminCards()).toHaveLength(1)
  })

  it('a repeated report on the same message creates no second card', async () => {
    await h.send(report(BOB, 950))
    await h.send(report(CAROL, 951))
    await h.app.settle()
    expect(adminCards()).toHaveLength(1)
    expect(deletes().sort()).toEqual([950, 951])
  })

  it('a report on an administrator is refused', async () => {
    h.tg.members.set(ALICE.id, 'administrator')
    await h.send(report())
    await h.app.settle()
    expect(adminCards()).toHaveLength(0)
    expect(deletes()).toEqual([950])
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
  })

  it('a report on a bot is refused', async () => {
    await h.send(report(BOB, 951, 5, { id: 777, first_name: 'Bot', is_bot: true } as never))
    await h.app.settle()
    expect(adminCards()).toHaveLength(0)
    expect(deletes()).toEqual([951])
  })

  it('confirm: -20 to the author, +5 to the first reporter, the message is removed; a second press does nothing', async () => {
    await h.send(report())
    await h.app.settle()
    const confirm = buttons().find((b) => b.text === 'Подтвердить')!
    await h.send(callback({ data: confirm.callback_data, from: ADMIN }))
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(-20)
    expect(await karmaOf(h, BOB.id)).toBe(5)
    expect(deletes().sort()).toEqual([900, 950])
    await h.send(callback({ data: confirm.callback_data, from: ADMIN }))
    expect(await karmaOf(h, ALICE.id)).toBe(-20)
    expect(await karmaOf(h, BOB.id)).toBe(5)
    expect((await eventsOf(h, BOB.id)).map((e) => e.reason)).toContain('report_reward')
  })

  it('only the first reporter is rewarded', async () => {
    await h.send(report(BOB, 950))
    await h.send(report(CAROL, 951))
    await h.app.settle()
    await h.send(callback({ data: buttons().find((b) => b.text === 'Подтвердить')!.callback_data, from: ADMIN }))
    await h.app.settle()
    expect(await karmaOf(h, BOB.id)).toBe(5)
    expect(await karmaOf(h, CAROL.id)).toBe(0)
  })

  it('return by a privileged reporter: the text is published by the bot with the author name', async () => {
    await seedMember(h, CAROL, 100)
    await h.send(report(CAROL))
    await h.app.settle()
    const giveBack = buttons().find((b) => b.text === 'Вернуть')!
    h.tg.calls.length = 0
    await h.send(callback({ data: giveBack.callback_data, from: ADMIN }))
    await h.app.settle()
    expect(h.tg.of('sendMessage').map((c) => [c.args[0], c.args[1]])).toEqual([[CHAT, 'Alice: плохое сообщение']])
    expect(await karmaOf(h, ALICE.id)).toBe(0)
    expect(await h.db.query('SELECT 1 FROM held_texts')).toEqual([])
  })

  it('daily limit: the eleventh report from one participant makes no card', async () => {
    for (let i = 0; i < 11; i++) {
      await h.send(message({ id: 1000 + i, from: ALICE, text: `сообщение ${i}` }))
      await h.send(report(BOB, 2000 + i, 1000 + i, ALICE, `сообщение ${i}`))
    }
    await h.app.settle()
    expect(adminCards()).toHaveLength(10)
    expect(deletes().filter((id) => id >= 2000)).toHaveLength(11)
  })

  it('a report on a message without a reply target only removes the command', async () => {
    await h.send(command({ id: 960, from: BOB, text: '/report' }))
    await h.app.settle()
    expect(deletes()).toEqual([960])
    expect(adminCards()).toHaveLength(0)
  })

  it('the command with the bot name is recognised', async () => {
    await h.send(command({ id: 961, from: BOB, text: '/report@jevchik_bot', reply_to: { message_id: 900, from: ALICE } }))
    await h.app.settle()
    expect(adminCards()).toHaveLength(1)
  })

  it('caught_spammers_count counts each spammer once', async () => {
    await h.send(message({ id: 901, from: ALICE, text: 'ещё плохое' }))
    await h.send(report(BOB, 950, 900))
    await h.send(report(BOB, 951, 901, ALICE, 'ещё плохое'))
    await h.app.settle()
    for (const button of [buttons(0), buttons(1)]) {
      await h.send(callback({ data: button.find((b) => b.text === 'Подтвердить')!.callback_data, from: ADMIN }))
    }
    const bob = (await h.db.query('SELECT * FROM members WHERE user_id = $1', [BOB.id]))[0]
    expect((await memberPage(h.ctx, CHAT, bob, BOB.id)).caught_spammers_count).toBe(1)
  })

  it('section 3.6.3: observation mode keeps only karma punishments, so a report works the same in the first week', async () => {
    await h.close()
    h = await createHarness()
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
    await h.send(message({ id: 900, from: ALICE, text: 'плохое сообщение' }))
    await seedMember(h, CAROL, 100)
    await h.send(report(CAROL))
    await h.app.settle()
    expect(deletes().sort()).toEqual([900, 950])
    expect(adminCards()[0].args[1]).toContain('Сделал: удалил сообщение (право дозора)')
    expect(adminCards()[0].args[1]).not.toContain('Сделал бы')
  })
})

describe('F35: a flag by the reaction 🖕 (section 3.7)', () => {
  const flag = (from = BOB, id = 900, emoji = '🖕') => reaction({ message_id: id, from, new: [emoji] })
  const botReactions = () => h.tg.of('setMessageReaction').map((c) => c.args)
  /** A member with karma waits for the admins; a newcomer without it goes to the steam room at once. */
  const withKarma = (user = ALICE, karma = 10) => h.db.query('UPDATE members SET karma = $3 WHERE chat_id = $1 AND user_id = $2', [CHAT, user.id, karma])
  const flagCards = () => adminCards().filter((c) => String(c.args[1]).includes('Участник пожаловался'))

  it('a member puts 🖕 on an author with karma: admins get the card with the quote and «Спам» / «Не спам»; the message, karma and reactions are not touched', async () => {
    await withKarma()
    await h.send(flag())
    await h.app.settle()
    expect(adminCards()).toHaveLength(1)
    expect(adminCards()[0].args[1]).toContain('Участник пожаловался: похоже на спам, реши')
    expect(adminCards()[0].args[1]).toContain('плохое сообщение')
    expect(buttons().map((b) => b.text)).toEqual(['Спам', 'Не спам'])
    expect(deletes()).toEqual([])
    expect(botReactions()).toEqual([])
    expect(await karmaOf(h, ALICE.id)).toBe(10)
    expect(await h.db.query('SELECT 1 FROM reports')).toEqual([])
  })

  it('a flagger with high karma changes nothing either: the message stays until an admin decides', async () => {
    await seedMember(h, BOB, 100)
    await withKarma()
    await h.send(flag())
    await h.app.settle()
    expect(deletes()).toEqual([])
    expect(adminCards()).toHaveLength(1)
  })

  it('«Спам» on the card: the message is deleted and the author goes to the steam room; «Не спам» leaves everything', async () => {
    await withKarma()
    await h.send(flag())
    await h.app.settle()
    await h.send(callback({ data: buttons()[0].callback_data, from: ADMIN }))
    await h.app.settle()
    expect(deletes()).toEqual([900])
    expect(h.tg.of('restrictChatMember').map((c) => c.args[1])).toEqual([ALICE.id])
    expect(await h.db.query('SELECT state FROM bans WHERE user_id = $1', [ALICE.id])).toEqual([{ state: 'steam' }])
  })

  it('a second 🖕 from somebody else, the author on themselves, a bot and a reaction taken off make no second card', async () => {
    await withKarma()
    await h.send(flag())
    await h.send(flag(CAROL))
    await h.send(flag(ALICE))
    await h.send(reaction({ message_id: 900, from: { id: 777, first_name: 'Jevchik', is_bot: true } as never, new: ['🖕'] }))
    await h.send(reaction({ message_id: 900, from: BOB, old: ['🖕'], new: [] }))
    await h.app.settle()
    expect(adminCards()).toHaveLength(1)
  })

  it('the daily limit of reports holds for flags too', async () => {
    await withKarma()
    for (let i = 0; i < 10; i++) {
      await h.send(message({ id: 1000 + i, from: ALICE, text: `сообщение ${i}` }))
      await h.send(flag(BOB, 1000 + i))
    }
    await h.app.settle()
    h.tg.calls.length = 0
    await h.send(flag(BOB, 900))
    await h.app.settle()
    expect(adminCards()).toHaveLength(0)
  })

  it('a newcomer without karma is flagged: the message goes away and the author goes to the steam room at once, no card to decide', async () => {
    await h.send(flag())
    await h.app.settle()
    expect(deletes()).toEqual([900])
    expect(h.tg.of('restrictChatMember').map((c) => c.args[1])).toEqual([ALICE.id])
    expect(await h.db.query('SELECT state FROM bans WHERE user_id = $1', [ALICE.id])).toEqual([{ state: 'steam' }])
    expect(flagCards()).toEqual([])
    expect(adminCards().map((c) => String(c.args[1]).split('\n')[0])).toEqual(['Удалил спам и заглушил автора'])
    expect((await h.db.query(`SELECT text, reason FROM held_texts WHERE message_id = 900`))[0]).toEqual({ text: 'плохое сообщение', reason: 'spam' })
    await h.send(flag(CAROL))
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
  })

  it('boundary: karma exactly report_steam_karma (5) waits for the admins', async () => {
    await withKarma(ALICE, 5)
    await h.send(flag())
    await h.app.settle()
    expect(deletes()).toEqual([])
    expect(flagCards()).toHaveLength(1)
    await withKarma(ALICE, 4.99)
    await h.send(message({ id: 901, from: ALICE, text: 'ещё одно' }))
    await h.send(flag(BOB, 901))
    await h.app.settle()
    expect(deletes()).toEqual([901])
  })

  it('a member past the first messages waits for the admins whatever the karma', async () => {
    for (let i = 0; i < 5; i++) await h.send(message({ id: 1100 + i, from: ALICE, text: `сообщение ${i}` }))
    await h.app.settle()
    await h.send(flag(BOB, 1104))
    await h.app.settle()
    expect(deletes()).toEqual([])
    expect(flagCards()).toHaveLength(1)
  })

  it('an old early message of a long-time member waits for the admins: the messages are counted now', async () => {
    for (let i = 0; i < 6; i++) await h.send(message({ id: 1200 + i, from: ALICE, text: `сообщение ${i}` }))
    await h.app.settle()
    await h.send(flag(BOB, 900))
    await h.app.settle()
    expect(deletes()).toEqual([])
    expect(flagCards()).toHaveLength(1)
  })

  it('a flag that sent its author to the steam room counts towards the daily limit', async () => {
    const { changeSetting } = await import('../src/settings/settings.js')
    await changeSetting(h.db, { chatId: CHAT, key: 'report_daily_limit', value: 1, baseVersion: 0, actor: ADMIN.id, now: h.clock.now() })
    await h.send(flag())
    await h.app.settle()
    expect(deletes()).toEqual([900])
    await h.send(message({ id: 960, from: CAROL, text: 'другое сообщение' }))
    await h.app.settle()
    await h.send(flag(BOB, 960))
    await h.app.settle()
    expect(deletes()).toEqual([900])
    expect(flagCards()).toEqual([])
  })

  it('with an empty report_reaction_emoji the sign is off and 🖕 counts like any other reaction', async () => {
    const { changeSetting } = await import('../src/settings/settings.js')
    await changeSetting(h.db, { chatId: CHAT, key: 'report_reaction_emoji', value: '', baseVersion: 0, actor: ADMIN.id, now: h.clock.now() })
    await h.send(flag())
    await h.app.settle()
    expect(adminCards()).toHaveLength(0)
    expect(await karmaOf(h, ALICE.id)).toBeGreaterThan(0)
  })
})

describe('F15: privileges of high karma', () => {
  it('voter weight: a reaction from karma 100 is worth more than from karma 0', async () => {
    await seedMember(h, CAROL, 100)
    await h.send(message({ id: 910, from: BOB, text: 'моё сообщение' }))
    await h.send(message({ id: 911, from: BOB, text: 'второе сообщение' }))
    await h.app.settle()
    await h.send(reaction({ message_id: 910, from: CAROL, new: ['👍'] }))
    await h.send(reaction({ message_id: 911, from: ALICE, new: ['👍'] }))
    const events = await eventsOf(h, BOB.id)
    const [high, low] = events.map((e) => e.delta)
    expect(high).toBeCloseTo((1 + Math.log(2)) * 1.05, 3)
    expect(low).toBeCloseTo(1.05, 3)
    expect(high).toBeGreaterThan(low)
  })
})

describe('F22: the bot reaction', () => {
  const useful = { usefulness: { score: 4, confidence: 0.9 } }

  it('reacts to a message rated 4 with confidence 0.7 or more', async () => {
    h.jev.script('подробный разбор', useful)
    await h.send(message({ id: 920, from: BOB, text: 'подробный разбор' }))
    await h.app.settle()
    expect(h.tg.of('setMessageReaction').map((c) => c.args)).toEqual([[CHAT, 920, '🔥']])
  })

  it('not for level 3, not for low confidence, exactly 0.7 counts', async () => {
    h.jev.script('уровень три', { usefulness: { score: 3, confidence: 0.99 } })
    h.jev.script('неуверенно', { usefulness: { score: 4, confidence: 0.69 } })
    h.jev.script('граница', { usefulness: { score: 4, confidence: 0.7 } })
    for (const [i, text] of ['уровень три', 'неуверенно', 'граница'].entries()) await h.send(message({ id: 930 + i, from: BOB, text }))
    await h.app.settle()
    expect(h.tg.of('setMessageReaction').map((c) => c.args[1])).toEqual([932])
  })

  it('an edit does not add a second reaction', async () => {
    h.jev.script('подробный разбор', useful)
    await h.send(message({ id: 920, from: BOB, text: 'подробный разбор' }))
    await h.app.settle()
    const { edited } = await import('./support/harness.js')
    // Section 3.6: an edit is a change of content, so the edited text differs and is evaluated again.
    h.jev.script('подробный разбор, дополнено', useful)
    await h.send(edited({ id: 920, from: BOB, text: 'подробный разбор, дополнено', edit_date: '2026-09-09T13:00:00Z' }))
    await h.app.settle()
    expect(h.jev.requests.at(-1)!.state.message).toBe('подробный разбор, дополнено')
    expect(h.tg.count('setMessageReaction')).toBe(1)
  })

  it('T-react-down: an exhausted reaction does not affect the karma event', async () => {
    h.tg.fail('setMessageReaction', tgError.server(), 5)
    h.jev.script('подробный разбор', useful)
    await h.send(message({ id: 920, from: BOB, text: 'подробный разбор' }))
    for (let i = 0; i < 5; i++) {
      await h.app.settle()
      h.clock.advance(20_000)
    }
    expect(h.tg.count('setMessageReaction')).toBe(3)
    expect((await h.db.query(`SELECT status FROM operations WHERE operation_kind = 'set_reaction'`))[0].status).toBe('failed')
    expect(await karmaOf(h, BOB.id)).toBeCloseTo(0.5 * 1.05, 4)
  })

  it('T-react-denied: a forbidden emoji is not retried and karma is not changed by it', async () => {
    h.tg.fail('setMessageReaction', tgError.bad('Bad Request: REACTION_INVALID'), 5)
    h.jev.script('подробный разбор', useful)
    await h.send(message({ id: 920, from: BOB, text: 'подробный разбор' }))
    for (let i = 0; i < 3; i++) {
      await h.app.settle()
      h.clock.advance(20_000)
    }
    expect(h.tg.count('setMessageReaction')).toBe(1)
    expect((await h.db.query(`SELECT status, last_error_code FROM operations WHERE operation_kind = 'set_reaction'`))[0]).toEqual({ status: 'failed', last_error_code: 'reaction_denied' })
    expect(await karmaOf(h, BOB.id)).toBeCloseTo(0.5 * 1.05, 4)
  })

  it('no reaction during observation', async () => {
    await h.close()
    h = await createHarness()
    h.jev.script('подробный разбор', useful)
    await h.send(message({ id: 920, from: BOB, text: 'подробный разбор' }))
    await h.app.settle()
    expect(h.tg.count('setMessageReaction')).toBe(0)
  })
})
