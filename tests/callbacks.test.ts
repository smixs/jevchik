import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN, ALICE, BOB, CAROL, CHAT, callback, command, createHarness, karmaOf, message, pastObservation, seedMember, type Harness } from './support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.tg.members.set(ADMIN.id, 'administrator')
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const failOn = async (table: string): Promise<void> => {
  await h.db.query(`CREATE OR REPLACE FUNCTION boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'db down'; END $$ LANGUAGE plpgsql`)
  await h.db.query(`CREATE TRIGGER boom BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION boom()`)
}
const healOn = (table: string) => h.db.query(`DROP TRIGGER boom ON ${table}`)
const answers = () => h.tg.callbackAnswers.map((a) => a.text)

describe('a card button is resolved only together with its action', () => {
  it('a failed ban action leaves the card open, a second press works, a third does nothing', async () => {
    await h.db.query(`INSERT INTO chats (chat_id, title, observation_started_at, created_at) VALUES ($1,'t',$2,$2) ON CONFLICT DO NOTHING`, [CHAT, h.clock.now()])
    await seedMember(h, CAROL)
    await h.db.query(`INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, created_at) VALUES ($1,'k','review',$2,$3)`, [CHAT, JSON.stringify({ targetUserId: CAROL.id, targetName: 'Carol' }), h.clock.now()])
    const id = (await h.db.query('SELECT card_id FROM admin_cards'))[0].card_id
    await failOn('flows')
    await h.send(callback({ data: `c:${id}:ban`, from: ADMIN }))
    expect(answers().at(-1)).toBe('Попробуйте позже')
    expect((await h.db.query('SELECT status FROM admin_cards'))[0].status).toBe('open')
    await healOn('flows')
    await h.send(callback({ data: `c:${id}:ban`, from: ADMIN }))
    await h.app.settle()
    expect(answers().at(-1)).toBe('Участник забанен')
    expect(h.tg.count('banChatMember')).toBe(1)
    await h.send(callback({ data: `c:${id}:ban`, from: ADMIN }))
    await h.app.settle()
    expect(answers().at(-1)).toBe('Кнопка устарела')
    expect(h.tg.count('banChatMember')).toBe(1)
  })

  it('a failed report confirmation changes nothing; the retry awards once', async () => {
    await h.send(message({ id: 900, from: ALICE, text: 'плохое сообщение' }))
    await h.send(command({ id: 950, from: BOB, text: '/report', reply_to: { message_id: 900, from: ALICE, text: 'плохое сообщение' } }))
    await h.app.settle()
    const card = h.tg.of('sendMessage').find((c) => c.args[0] === ADMIN.id)!
    const confirm = (card.args[2] as Array<Array<{ text: string; callback_data: string }>>)[1].find((b) => b.text === 'Подтвердить')!
    await failOn('operations')
    await h.send(callback({ data: confirm.callback_data, from: ADMIN }))
    expect(answers().at(-1)).toBe('Попробуйте позже')
    expect(await karmaOf(h, ALICE.id)).toBe(0)
    expect((await h.db.query('SELECT status FROM reports'))[0].status).toBe('open')
    expect((await h.db.query('SELECT status FROM admin_cards'))[0].status).toBe('open')
    await healOn('operations')
    await h.send(callback({ data: confirm.callback_data, from: ADMIN }))
    await h.send(callback({ data: confirm.callback_data, from: ADMIN }))
    expect(await karmaOf(h, ALICE.id)).toBe(-20)
    expect(await karmaOf(h, BOB.id)).toBe(5)
  })

  it('a failed return keeps the held text and the open card', async () => {
    await seedMember(h, CAROL, 100)
    await h.send(message({ id: 900, from: ALICE, text: 'плохое сообщение' }))
    await h.send(command({ id: 950, from: CAROL, text: '/report', reply_to: { message_id: 900, from: ALICE, text: 'плохое сообщение' } }))
    await h.app.settle()
    const card = h.tg.of('sendMessage').find((c) => c.args[0] === ADMIN.id)!
    const back = (card.args[2] as Array<Array<{ text: string; callback_data: string }>>)[1].find((b) => b.text === 'Вернуть')!
    await failOn('operations')
    await h.send(callback({ data: back.callback_data, from: ADMIN }))
    expect(await h.db.query('SELECT 1 FROM held_texts')).toHaveLength(1)
    expect((await h.db.query('SELECT status FROM admin_cards'))[0].status).toBe('open')
    await healOn('operations')
    h.tg.calls.length = 0
    await h.send(callback({ data: back.callback_data, from: ADMIN }))
    await h.app.settle()
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === CHAT).map((c) => c.args[1])).toEqual(['Alice: плохое сообщение'])
  })
})
