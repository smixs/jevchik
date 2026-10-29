import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appealState, submitAppeal } from '../src/appeal.js'
import { DEFAULT_PERMISSIONS, tgError } from './support/fakes.js'
import { ADMIN, ALICE, BOB, CAROL, CHAT, callback, createHarness, message, pastObservation, type Harness } from './support/harness.js'

const SPAM = 'Заработай 500 долларов в день без вложений, пиши в личку!'
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.tg.members.set(ADMIN.id, 'administrator')
  h.jev.script(SPAM, { spam_earnings_crypto: 0.95 })
  await pastObservation(h)
  await h.send(message({ id: 700, from: CAROL, text: SPAM }))
  await h.app.settle()
  h.tg.calls.length = 0
  h.jev.requests.length = 0
})
afterEach(async () => {
  await h.close()
})

const ban = async () => (await h.db.query('SELECT state, appeal_status FROM bans WHERE user_id = $1', [CAROL.id]))[0]

describe('F9: the button lifts the steam room', () => {
  it('one press: no explanation and no Jev, the restriction is lifted, the record is removed, probation starts', async () => {
    expect(await appealState(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'none', allowed: true })
    const result = await submitAppeal(h.ctx, CHAT, CAROL.id)
    expect(result).toEqual({ status: 'accepted', lifted: true })
    expect(h.jev.requests).toEqual([])
    expect(h.tg.of('restrictChatMember').map((c) => c.args)).toEqual([[CHAT, CAROL.id, DEFAULT_PERMISSIONS, undefined]])
    expect(await ban()).toBeUndefined()
    expect((await h.db.query('SELECT probation_left FROM members WHERE user_id = $1', [CAROL.id]))[0].probation_left).toBe(5)
  })

  it('from the banned state the button uses unban', async () => {
    h.clock.advance(25 * 3600_000)
    await h.app.settle()
    expect((await ban()).state).toBe('banned')
    expect(await submitAppeal(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'accepted', lifted: true })
    expect(h.tg.of('unbanChatMember').map((c) => c.args)).toEqual([[CHAT, CAROL.id]])
  })

  it('the admins kept the ban: the button is refused and nothing is lifted', async () => {
    await h.db.query(`UPDATE bans SET appeal_status = 'rejected'`)
    expect(await appealState(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'rejected', allowed: false })
    expect(await submitAppeal(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'rejected' })
    expect((await ban()).state).toBe('steam')
    expect(h.tg.count('restrictChatMember')).toBe(0)
  })

  it('a second entry to the bath gives no button', async () => {
    await submitAppeal(h.ctx, CHAT, CAROL.id)
    await h.db.query(
      `INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at) VALUES ($1,$2,'admin',0,0,0,'banned',$3,$3)`,
      [CHAT, CAROL.id, h.clock.now()],
    )
    await h.db.query('UPDATE members SET bans_count = bans_count + 1 WHERE user_id = $1', [CAROL.id])
    expect(await submitAppeal(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'not_allowed' })
    expect(await appealState(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'none', allowed: false })
  })

  it('a participant without a ban record has nothing to lift', async () => {
    expect(await submitAppeal(h.ctx, CHAT, ALICE.id)).toEqual({ status: 'no_ban' })
    expect(await submitAppeal(h.ctx, CHAT, BOB.id)).toEqual({ status: 'no_ban' })
  })
})

describe('appeal failures', () => {
  it('T-appeal-api-fail: the press is not burned when Telegram fails; a repeat finishes the job', async () => {
    h.tg.fail('restrictChatMember', tgError.server(), 3)
    const first = await submitAppeal(h.ctx, CHAT, CAROL.id)
    expect(first).toEqual({ status: 'accepted', lifted: false })
    expect((await ban()).appeal_status).toBe('accepted')
    expect(await appealState(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'accepted', allowed: true })
    let last = first
    for (let i = 0; i < 8 && last.status === 'accepted' && !(last as { lifted: boolean }).lifted; i++) {
      h.clock.advance(20_000)
      last = await submitAppeal(h.ctx, CHAT, CAROL.id)
    }
    expect(last).toEqual({ status: 'accepted', lifted: true })
    expect(await ban()).toBeUndefined()
  })

  it('T-appeal-db-after-api: Telegram lifted the restriction, the database did not: the repeat does not call Telegram again', async () => {
    await h.db.query(`CREATE FUNCTION fail_del() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'db down'; END $$ LANGUAGE plpgsql`)
    await h.db.query(`CREATE TRIGGER fail_del BEFORE DELETE ON bans FOR EACH ROW EXECUTE FUNCTION fail_del()`)
    expect(await submitAppeal(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'accepted', lifted: false })
    expect(h.tg.count('restrictChatMember')).toBe(1)
    await h.db.query('DROP TRIGGER fail_del ON bans')
    h.clock.advance(60_000)
    expect(await submitAppeal(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'accepted', lifted: true })
    expect(h.tg.count('restrictChatMember')).toBe(1)
  })

  it('T-appeal-race: a double click lifts once', async () => {
    const results = await Promise.all([submitAppeal(h.ctx, CHAT, CAROL.id), submitAppeal(h.ctx, CHAT, CAROL.id)])
    expect(results.filter((r) => r.status === 'accepted').length).toBeGreaterThanOrEqual(1)
    expect(results.every((r) => ['accepted', 'no_ban'].includes(r.status))).toBe(true)
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(await h.db.query(`SELECT count(*)::int AS n FROM flows WHERE kind = 'unban'`)).toEqual([{ n: 1 }])
  })

  it('model Appeal, AdminWins: while the button lifts, «Забанить» on the card waits; a ban from a card made meanwhile is kept', async () => {
    await h.db.query(
      `INSERT INTO flows (chat_id, kind, idempotency_key, data, step, status, next_attempt_at, created_at) VALUES ($1,'ban','parked',$2,0,'running',$3,$3)`,
      [CHAT, JSON.stringify({ userId: CAROL.id }), new Date(h.clock.now().getTime() + 3600_000)],
    )
    expect(await submitAppeal(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'accepted', lifted: false })
    const card = (await h.db.query(`SELECT card_id FROM admin_cards WHERE kind = 'steamed'`))[0].card_id
    await h.send(callback({ data: `c:${card}:ban`, from: ADMIN, id: 'cb-busy' }))
    expect(h.tg.callbackAnswers.at(-1)).toEqual({ id: 'cb-busy', text: 'Уже выполняю предыдущее решение' })
    await h.db.query(`UPDATE bans SET appeal_status = 'rejected'`)
    await h.db.query(`UPDATE flows SET status = 'completed' WHERE idempotency_key = 'parked'`)
    for (let i = 0; i < 6; i++) {
      h.clock.advance(60_000)
      await h.app.settle()
    }
    expect(await h.db.query(`SELECT status FROM flows WHERE kind = 'unban'`)).not.toEqual([{ status: 'running' }])
    expect(h.tg.count('restrictChatMember')).toBe(0)
    expect(h.tg.count('unbanChatMember')).toBe(0)
    expect((await ban()).state).toBe('steam')
  })

  it('T-appeal-gone: the participant left or is already unrestricted: the record is removed, no error', async () => {
    h.tg.fail('restrictChatMember', tgError.bad('Bad Request: PARTICIPANT_ID_INVALID'))
    expect(await submitAppeal(h.ctx, CHAT, CAROL.id)).toEqual({ status: 'accepted', lifted: true })
    expect(await ban()).toBeUndefined()
  })
})

describe('F11: admin cards', () => {
  async function reviewCard(): Promise<Array<{ text: string; callback_data: string }>> {
    await h.send(message({ id: 709, from: ALICE, text: 'привет' }))
    h.jev.script('Посмотрите мой курс со скидкой', { spam_other_offer: 0.5 })
    await h.send(message({ id: 711, from: ALICE, text: 'Посмотрите мой курс со скидкой' }))
    await h.app.settle()
    const card = h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id).at(-1)!
    return (card.args[2] as Array<Array<{ text: string; callback_data: string }>>)[1]
  }

  it('section 3.6.2: the buttons «Спам», «Не спам», then «Не спам, вернуть», «Забанить» exist and work for an administrator', async () => {
    const buttons = await reviewCard()
    expect(buttons.map((b) => b.text)).toEqual(['Спам', 'Не спам'])
    h.tg.calls.length = 0
    const spam = buttons.find((b) => b.text === 'Спам')!
    await h.send(callback({ data: spam.callback_data, from: ADMIN, id: 'cb-spam' }))
    await h.app.settle()
    expect(h.tg.of('restrictChatMember').map((c) => c.args[1])).toEqual([ALICE.id])
    const edited = h.tg.of('editMessageText').at(-1)!.args[3] as Array<Array<{ text: string; callback_data: string }>>
    expect(edited[1].map((b) => b.text)).toEqual(['Не спам, вернуть', 'Забанить'])
    const ban = edited[1].find((b) => b.text === 'Забанить')!
    await h.send(callback({ data: ban.callback_data, from: ADMIN, id: 'cb-ban' }))
    await h.app.settle()
    expect(h.tg.of('banChatMember').map((c) => c.args)).toEqual([[CHAT, ALICE.id]])
    expect(h.tg.callbackAnswers).toEqual([
      { id: 'cb-spam', text: 'Сообщение удалено, участник заглушён' },
      { id: 'cb-ban', text: 'Участник забанен' },
    ])
    expect((await h.db.query('SELECT state FROM bans WHERE user_id = $1', [ALICE.id]))[0].state).toBe('banned')
    h.tg.calls.length = 0
    await h.send(callback({ data: ban.callback_data, from: ADMIN, id: 'cb-again' }))
    expect(h.tg.callbackAnswers.at(-1)).toEqual({ id: 'cb-again', text: 'Кнопка устарела' })
    expect(h.tg.count('banChatMember')).toBe(0)
  })

  it('"разбанить" lifts a steam-room restriction; "это не спам" does the same', async () => {
    await h.db.query(`INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, created_at) VALUES ($1,'k1','review',$2,$3)`, [CHAT, JSON.stringify({ targetUserId: CAROL.id, targetName: 'Carol' }), h.clock.now()])
    const id = (await h.db.query('SELECT card_id FROM admin_cards'))[0].card_id
    await h.send(callback({ data: `c:${id}:notspam`, from: ADMIN }))
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(await ban()).toBeUndefined()
  })

  it('T-callback: a non-administrator is refused with an answer and nothing happens', async () => {
    await h.db.query(`INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, created_at) VALUES ($1,'k1','review',$2,$3)`, [CHAT, JSON.stringify({ targetUserId: CAROL.id }), h.clock.now()])
    const id = (await h.db.query('SELECT card_id FROM admin_cards'))[0].card_id
    await h.send(callback({ data: `c:${id}:ban`, from: BOB, id: 'cb1' }))
    await h.app.settle()
    expect(h.tg.callbackAnswers).toEqual([{ id: 'cb1', text: 'Только для админов чата' }])
    expect(h.tg.count('banChatMember')).toBe(0)
    expect((await h.db.query('SELECT status FROM admin_cards'))[0].status).toBe('open')
  })

  it('T-callback: an old or unknown button gets an answer', async () => {
    await h.send(callback({ data: 'c:9999:ban', from: ADMIN, id: 'cb2' }))
    await h.send(callback({ data: 'garbage', from: ADMIN, id: 'cb3' }))
    expect(h.tg.callbackAnswers).toEqual([
      { id: 'cb2', text: 'Кнопка устарела' },
      { id: 'cb3', text: 'Кнопка устарела' },
    ])
  })

  it('T-member-down: when the admin check fails the action is not done', async () => {
    await h.db.query(`INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, created_at) VALUES ($1,'k1','review',$2,$3)`, [CHAT, JSON.stringify({ targetUserId: CAROL.id }), h.clock.now()])
    const id = (await h.db.query('SELECT card_id FROM admin_cards'))[0].card_id
    h.tg.fail('getChatMember', tgError.server(), 3)
    await h.send(callback({ data: `c:${id}:ban`, from: ADMIN, id: 'cb4' }))
    expect(h.tg.callbackAnswers).toEqual([{ id: 'cb4', text: 'Попробуйте позже' }])
    expect(h.tg.count('banChatMember')).toBe(0)
    expect((await h.db.query('SELECT status FROM admin_cards'))[0].status).toBe('open')
  })

  it('T-card-undelivered: with no reachable admin the card stays in the database, visible on the admin screen', async () => {
    h.tg.fail('sendMessage', tgError.bad('Forbidden: bot can\'t initiate conversation with a user', 403))
    await h.db.query(`INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, created_at) VALUES ($1,'k1','review',$2,$3)`, [CHAT, JSON.stringify({ targetUserId: CAROL.id }), h.clock.now()])
    await h.app.settle()
    expect((await h.db.query(`SELECT delivery, delivered_count, status FROM admin_cards WHERE idempotency_key = 'k1'`))[0]).toEqual({ delivery: 'undelivered', delivered_count: 0, status: 'open' })
    h.tg.admins = []
    await h.db.query(`INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, created_at) VALUES ($1,'k2','review',$2,$3)`, [CHAT, JSON.stringify({ targetUserId: CAROL.id }), h.clock.now()])
    await h.app.settle()
    expect((await h.db.query(`SELECT delivery FROM admin_cards WHERE idempotency_key = 'k2'`))[0].delivery).toBe('undelivered')
  })
})
