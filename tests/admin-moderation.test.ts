import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NO_PERMISSIONS } from '../src/ops.js'
import { loadJokes } from '../src/sanctions.js'
import { DEFAULT_PERMISSIONS, tgError } from './support/fakes.js'
import { ADMIN, BOB, CAROL, CHAT, callback, createHarness, karmaOf, type Harness } from './support/harness.js'
import { VECTORS } from './support/vectors.js'
import { get, makeWeb, seedWorld, send } from './support/web.js'

// Section 3.6.5: an administrator of the chat sanctions a member from the Mini App. The clock stands at 2026-09-01 12:00 UTC,
// which is 17:00 in the default time zone of a chat (Asia/Tashkent).

const HOUR = 3_600_000
const T0 = Date.parse('2026-09-01T12:00:00Z')
const APPEAL_BUTTON = [[{ text: 'Попросить разбан', url: `https://t.me/jevchik_bot?startapp=appeal_${CHAT}` }]]
const DMITRY = 4

let h: Harness
let web: Awaited<ReturnType<typeof makeWeb>>

beforeEach(async () => {
  h = await createHarness()
  await seedWorld(h)
  web = await makeWeb(h)
  h.tg.members.set(ADMIN.id, 'administrator')
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
})
afterEach(async () => {
  await h.close()
})

const json = async (response: Response): Promise<any> => response.json() // eslint-disable-line @typescript-eslint/no-explicit-any

async function publicId(userId: number): Promise<string> {
  return (await h.db.query('SELECT public_id FROM members WHERE chat_id = $1 AND user_id = $2', [CHAT, userId]))[0].public_id
}

async function act(userId: number, action: string, body: unknown = {}, initData: string = VECTORS.admin_admin): Promise<Response> {
  return send(web, 'POST', `/api/admin/members/${await publicId(userId)}/${action}`, initData, body)
}

const memberCalls = () =>
  h.tg.calls.filter((c) => ['banChatMember', 'unbanChatMember', 'restrictChatMember', 'deleteMessage', 'sendMessage'].includes(c.method)).map((c) => [c.method, ...c.args])
const bans = () => h.db.query('SELECT user_id, state, source, by_admin_name, appeal_status FROM bans WHERE chat_id = $1 AND user_id <> $2 ORDER BY user_id', [CHAT, DMITRY])
const journal = async () => (await json(await get(web, '/api/admin/modlog', VECTORS.admin_admin))).log.map((a: { admin: string; summary: string; ok: boolean }) => [a.admin, a.summary, a.ok])
const names = async (period = 'all') => (await json(await get(web, `/api/leaderboard?period=${period}`, VECTORS.admin_admin))).rows.map((r: { name: string }) => r.name)

describe('F32: the steam room from the Mini App', () => {
  it('a day: the member is restricted until the term, the chat gets the joke with the request button, karma stays', async () => {
    const body = await json(await act(BOB.id, 'steam', { hours: 24 }))
    expect([body.ok, body.text]).toEqual([true, 'Bob в парилке до 02.09.2026 17:00'])
    expect(body.member.sanction).toEqual({ state: 'steam', source: 'admin', until: '2026-09-02T12:00:00.000Z', by: 'Admin', text: 'в парилке до 02.09.2026 17:00, отправил Admin', own: 'в парилке до 02.09.2026 17:00', appeal_status: 'none' })
    expect(memberCalls()).toEqual([
      ['restrictChatMember', CHAT, BOB.id, NO_PERMISSIONS, (T0 + 24 * HOUR) / 1000],
      ['sendMessage', CHAT, loadJokes().admin_steam[0].replaceAll('{name}', 'Bob').replaceAll('{term}', 'на сутки'), APPEAL_BUTTON],
    ])
    expect(await bans()).toEqual([{ user_id: BOB.id, state: 'steam', source: 'admin', by_admin_name: 'Admin', appeal_status: 'none' }])
    expect(await karmaOf(h, BOB.id)).toBe(7.25)
    expect(await journal()).toEqual([['Admin', 'Bob в парилке до 02.09.2026 17:00', true]])
  })

  it('an hour and a week are the other two terms; anything else is refused before Telegram is asked', async () => {
    expect((await json(await act(BOB.id, 'steam', { hours: 1 }))).text).toBe('Bob в парилке до 01.09.2026 18:00')
    expect((await json(await act(CAROL.id, 'steam', { hours: 168 }))).text).toBe('Carol в парилке до 08.09.2026 17:00')
    h.tg.calls.length = 0
    expect(await json(await act(1, 'steam', { hours: 5 }))).toMatchObject({ ok: false, text: 'Срок парилки: час, сутки или неделя.' })
    expect(memberCalls()).toEqual([])
  })

  it('the term ends by itself: the record goes away, nobody is banned', async () => {
    await act(BOB.id, 'steam', { hours: 1 })
    h.tg.calls.length = 0
    h.clock.advance(HOUR + 1000)
    await h.app.settle()
    expect(await bans()).toEqual([])
    expect(memberCalls()).toEqual([])
  })

  it('an administrator of the chat is not sanctioned, and the journal keeps the refusal', async () => {
    h.tg.statusIn.set(`${CHAT}:${BOB.id}`, 'administrator')
    expect(await json(await act(BOB.id, 'steam', { hours: 24 }))).toMatchObject({ ok: false, text: 'Не вышло: это админ чата', member: { sanction: null } })
    expect(memberCalls()).toEqual([])
    expect(await bans()).toEqual([])
    expect(await journal()).toEqual([['Admin', 'Не вышло: это админ чата', false]])
  })

  it('a bot without the right to restrict: the answer says so, no record, no joke', async () => {
    h.tg.fail('restrictChatMember', tgError.bad('Bad Request: not enough rights to restrict/unrestrict chat member'))
    expect(await json(await act(BOB.id, 'steam', { hours: 24 }))).toMatchObject({ ok: false, text: 'Не вышло: у бота нет права банить участников' })
    expect(await bans()).toEqual([])
    expect(h.tg.count('sendMessage')).toBe(0)
  })

  it('only a fresh administrator of this chat may act; an administrator cannot sanction themselves', async () => {
    expect((await act(CAROL.id, 'steam', { hours: 24 }, VECTORS.bob_admin)).status).toBe(403)
    expect((await get(web, '/api/admin/bans', VECTORS.bob_admin)).status).toBe(403)
    await h.db.query(`INSERT INTO members (chat_id, user_id, display_name, created_at) VALUES ($1,$2,'Admin',$3)`, [CHAT, ADMIN.id, h.clock.now()])
    expect(await json(await act(ADMIN.id, 'ban'))).toMatchObject({ ok: false, text: 'Себя наказать нельзя.' })
    expect(memberCalls()).toEqual([])
  })
})

describe('F32: the ban and its lifting from the Mini App', () => {
  it('a ban: the member is banned, the chat gets the joke, the leaderboard loses the row, karma stays', async () => {
    expect(await names()).toEqual(['Alice', 'Bob', 'Carol'])
    expect(await json(await act(BOB.id, 'ban'))).toMatchObject({ ok: true, text: 'Bob забанен', member: { sanction: { state: 'banned', source: 'admin', until: null, text: 'забанен, забанил Admin' } } })
    expect(memberCalls()).toEqual([
      ['banChatMember', CHAT, BOB.id],
      ['sendMessage', CHAT, loadJokes().admin_ban[0].replaceAll('{name}', 'Bob'), APPEAL_BUTTON],
    ])
    expect(await names()).toEqual(['Alice', 'Carol'])
    expect(await names('month')).toEqual(['Alice', 'Carol'])
    expect(await karmaOf(h, BOB.id)).toBe(7.25)
    expect(await json(await act(BOB.id, 'ban'))).toMatchObject({ ok: false, text: 'Уже забанен. Сначала разбаньте.' })
  })

  it('a ban of a member in the steam room replaces the record; the steam room of a banned member is refused', async () => {
    await act(BOB.id, 'steam', { hours: 24 })
    expect((await json(await act(BOB.id, 'ban'))).text).toBe('Bob забанен')
    expect(await bans()).toEqual([{ user_id: BOB.id, state: 'banned', source: 'admin', by_admin_name: 'Admin', appeal_status: 'none' }])
    expect((await json(await act(BOB.id, 'steam', { hours: 1 }))).text).toBe('Уже забанен. Сначала разбаньте.')
    h.clock.advance(48 * HOUR)
    await h.app.settle()
    expect(await bans()).toHaveLength(1)
  })

  it('lifting the steam room is silent: the default permissions are back, the joke is deleted, the record is gone', async () => {
    await act(BOB.id, 'steam', { hours: 24 })
    h.tg.calls.length = 0
    expect(await json(await act(BOB.id, 'unban'))).toMatchObject({ ok: true, text: 'Bob выпущен из парилки', member: { sanction: null } })
    expect(memberCalls()).toEqual([
      ['restrictChatMember', CHAT, BOB.id, DEFAULT_PERMISSIONS, undefined],
      ['deleteMessage', CHAT, 9000],
    ])
    expect(await bans()).toEqual([])
    expect((await h.db.query('SELECT probation_left FROM members WHERE chat_id = $1 AND user_id = $2', [CHAT, BOB.id]))[0].probation_left).toBe(0)
    expect((await journal())[0]).toEqual(['Admin', 'Bob выпущен из парилки', true])
  })

  it('lifting a ban unbans the member; the row is back in the leaderboard', async () => {
    await act(BOB.id, 'ban')
    h.tg.calls.length = 0
    expect((await json(await act(BOB.id, 'unban'))).text).toBe('Bob разбанен')
    expect(memberCalls()).toEqual([
      ['unbanChatMember', CHAT, BOB.id],
      ['deleteMessage', CHAT, 9000],
    ])
    expect(await names()).toEqual(['Alice', 'Bob', 'Carol'])
    expect(await json(await act(BOB.id, 'unban'))).toMatchObject({ ok: false, text: 'Наказания уже нет.' })
  })

  it('a member the bot itself put in the steam room is let out by an administrator too', async () => {
    expect((await json(await act(DMITRY, 'unban'))).text).toBe('Дмитрий выпущен из парилки')
    expect(await h.db.query('SELECT 1 FROM bans WHERE chat_id = $1', [CHAT])).toEqual([])
  })

  it('the bans and the search show an administrator the real names and the sanction', async () => {
    await act(BOB.id, 'steam', { hours: 24 })
    const list = (await json(await get(web, '/api/admin/bans', VECTORS.admin_admin))).bans
    expect(list.map((m: { name: string; sanction: { text: string } }) => [m.name, m.sanction.text])).toEqual([
      ['Bob', 'в парилке до 02.09.2026 17:00, отправил Admin'],
      ['Дмитрий', 'в парилке за спам до 02.09.2026 17:00, потом бан'],
    ])
    const found = (await json(await get(web, `/api/admin/members?q=${encodeURIComponent('@dmitry_')}`, VECTORS.admin_admin))).members
    expect(found.map((m: { name: string; username: string }) => [m.name, m.username])).toEqual([['Дмитрий', 'dmitry_spam']])
    expect((await json(await get(web, '/api/admin/members?q=o', VECTORS.admin_admin))).members).toEqual([])
    expect((await json(await get(web, '/api/admin/members?q=%25%25', VECTORS.admin_admin))).members).toEqual([])
    const publicList = (await json(await get(web, '/api/bans', VECTORS.bob_lb))).bans
    expect(publicList.map((b: { explanation: string }) => b.explanation)[0]).toBe('В парилке по решению админа.')
  })
})

describe('F32: the member asks the administrators to lift the sanction', () => {
  const cards = () => h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id).map((c) => [c.args[1], c.args[2]])
  const cardId = async (): Promise<number> => (await h.db.query(`SELECT card_id FROM admin_cards WHERE kind = 'unban_request' ORDER BY card_id DESC LIMIT 1`))[0].card_id

  beforeEach(async () => {
    await act(BOB.id, 'steam', { hours: 24 })
    h.tg.calls.length = 0
  })

  it('the Mini App tells whose decision it is; the model is not asked; one request makes one card with two buttons', async () => {
    expect(await json(await get(web, '/api/appeal', VECTORS.bob_lb))).toEqual({ status: 'none', allowed: true, source: 'admin', sanction: 'в парилке до 02.09.2026 17:00' })
    expect(await json(await send(web, 'POST', '/api/appeal', VECTORS.bob_lb, { text: 'я человек' }))).toEqual({ status: 'not_allowed' })
    expect(h.jev.requests).toHaveLength(0)
    expect(await json(await send(web, 'POST', '/api/appeal/request', VECTORS.bob_lb))).toEqual({ status: 'review' })
    expect(await json(await send(web, 'POST', '/api/appeal/request', VECTORS.bob_lb))).toEqual({ status: 'review' })
    await h.app.settle()
    const id = await cardId()
    expect(cards()).toEqual([
      [
        'Участник просит разбан\nУчастник: Bob (@bob)\nСейчас: в парилке до 02.09.2026 17:00, отправил Admin',
        [[{ text: 'Разбанить', callback_data: `c:${id}:unban` }, { text: 'Оставить', callback_data: `c:${id}:keep` }]],
      ],
    ])
    expect(await json(await get(web, '/api/appeal', VECTORS.bob_lb))).toMatchObject({ status: 'review', allowed: false })
  })

  it('«Оставить»: the sanction stays, the member sees the refusal', async () => {
    await send(web, 'POST', '/api/appeal/request', VECTORS.bob_lb)
    await h.app.settle()
    await h.send(callback({ data: `c:${await cardId()}:keep`, from: ADMIN }))
    await h.app.settle()
    expect(h.tg.callbackAnswers.at(-1)?.text).toBe('Наказание оставлено в силе')
    expect(await bans()).toEqual([{ user_id: BOB.id, state: 'steam', source: 'admin', by_admin_name: 'Admin', appeal_status: 'rejected' }])
    expect(await json(await send(web, 'POST', '/api/appeal/request', VECTORS.bob_lb))).toEqual({ status: 'rejected' })
  })

  it('«Разбанить»: the restriction is lifted, the record is gone, no probation', async () => {
    await send(web, 'POST', '/api/appeal/request', VECTORS.bob_lb)
    await h.app.settle()
    h.tg.calls.length = 0
    await h.send(callback({ data: `c:${await cardId()}:unban`, from: ADMIN }))
    await h.app.settle()
    expect(h.tg.of('restrictChatMember').map((c) => c.args)).toEqual([[CHAT, BOB.id, DEFAULT_PERMISSIONS, undefined]])
    expect(await bans()).toEqual([])
    expect((await h.db.query('SELECT probation_left FROM members WHERE chat_id = $1 AND user_id = $2', [CHAT, BOB.id]))[0].probation_left).toBe(0)
  })

  it('a member the bot caught cannot ask this way', async () => {
    expect(await json(await send(web, 'POST', '/api/appeal/request', VECTORS.alice_appeal))).toEqual({ status: 'no_ban' })
    await h.db.query(`INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at) VALUES ($1,1,'spam_other_offer',0,0,0,'steam',$2,$2)`, [CHAT, h.clock.now()])
    expect(await json(await send(web, 'POST', '/api/appeal/request', VECTORS.alice_appeal))).toEqual({ status: 'not_allowed' })
  })
})

describe('one sanction, one request; the model never decides about a record of an administrator', () => {
  const requestCard = async (): Promise<{ card_id: number; status: string; resolution: string | null }> =>
    (await h.db.query<{ card_id: number; status: string; resolution: string | null }>(`SELECT card_id, status, resolution FROM admin_cards WHERE kind = 'unban_request' ORDER BY card_id DESC LIMIT 1`))[0]

  it('a request card of a replaced sanction is closed: its old buttons decide nothing about the new one', async () => {
    await act(BOB.id, 'steam', { hours: 1 })
    await send(web, 'POST', '/api/appeal/request', VECTORS.bob_lb)
    await h.app.settle()
    const old = await requestCard()
    h.clock.advance(1000)
    await act(BOB.id, 'ban')
    expect(await requestCard()).toEqual({ card_id: old.card_id, status: 'resolved', resolution: 'obsolete' })
    h.tg.calls.length = 0
    await h.send(callback({ data: `c:${old.card_id}:unban`, from: ADMIN }))
    await h.app.settle()
    expect(h.tg.callbackAnswers.at(-1)?.text).toBe('Кнопка устарела')
    expect(memberCalls()).toEqual([])
    expect(await bans()).toEqual([{ user_id: BOB.id, state: 'banned', source: 'admin', by_admin_name: 'Admin', appeal_status: 'none' }])
  })

  it('the term that ran out closes the request card too', async () => {
    await act(BOB.id, 'steam', { hours: 1 })
    await send(web, 'POST', '/api/appeal/request', VECTORS.bob_lb)
    await h.app.settle()
    h.clock.advance(HOUR + 1000)
    await h.app.settle()
    expect(await requestCard()).toMatchObject({ status: 'resolved', resolution: 'obsolete' })
  })

  it('«Разбанить» on the request card deletes the joke of the bot, like the button in the Mini App', async () => {
    await act(BOB.id, 'steam', { hours: 24 })
    await send(web, 'POST', '/api/appeal/request', VECTORS.bob_lb)
    await h.app.settle()
    h.tg.calls.length = 0
    await h.send(callback({ data: `c:${(await requestCard()).card_id}:unban`, from: ADMIN }))
    await h.app.settle()
    expect(h.tg.calls.filter((c) => ['restrictChatMember', 'deleteMessage'].includes(c.method)).map((c) => [c.method, ...c.args])).toEqual([
      ['restrictChatMember', CHAT, BOB.id, DEFAULT_PERMISSIONS, undefined],
      ['deleteMessage', CHAT, 9000],
    ])
    expect(await requestCard()).toMatchObject({ status: 'resolved', resolution: 'unban' })
  })

  it('an administrator takes the record over while the model judges the appeal: the verdict is dropped', async () => {
    const real = h.jev.evaluate.bind(h.jev)
    h.jev.script('я человек', { appeal_genuine: 0.99 })
    h.jev.evaluate = async (request) => {
      await h.db.query(`UPDATE bans SET source = 'admin', by_admin_name = 'Admin', appeal_status = 'none' WHERE chat_id = $1 AND user_id = $2`, [CHAT, DMITRY])
      return real(request)
    }
    await h.db.query(`INSERT INTO members (chat_id, user_id, display_name, created_at) VALUES ($1,555,'x',$2) ON CONFLICT DO NOTHING`, [CHAT, h.clock.now()])
    const { submitAppeal } = await import('../src/appeal.js')
    expect(await submitAppeal(h.ctx, CHAT, DMITRY, 'я человек')).toEqual({ status: 'not_allowed' })
    expect(h.tg.count('restrictChatMember')).toBe(0)
    expect(await h.db.query('SELECT source, appeal_status FROM bans WHERE chat_id = $1 AND user_id = $2', [CHAT, DMITRY])).toEqual([{ source: 'admin', appeal_status: 'none' }])
  })

  it('a banned member has no place on the personal page', async () => {
    await act(BOB.id, 'ban')
    expect((await json(await get(web, `/api/members/${await publicId(BOB.id)}`, VECTORS.admin_admin))).place).toBeNull()
    expect((await json(await get(web, `/api/members/${await publicId(CAROL.id)}`, VECTORS.admin_admin))).place).toBe(2)
  })
})

describe('F33: «Боты в рейтинге»', () => {
  const HELPER = 777001
  const tagCalls = () => h.tg.of('setChatMemberTag').map((c) => c.args)
  const toggle = async (value: boolean): Promise<void> => {
    const version = (await json(await get(web, '/api/admin/settings', VECTORS.admin_admin))).versions.bots_in_rating
    expect((await send(web, 'PUT', '/api/admin/settings/bots_in_rating', VECTORS.admin_admin, { value, base_version: version })).status).toBe(200)
  }

  beforeEach(async () => {
    await h.db.query(`INSERT INTO members (chat_id, user_id, display_name, karma, is_bot, created_at) VALUES ($1,$2,'Helper Bot',900,true,$3)`, [CHAT, HELPER, h.clock.now()])
    await h.db.query(`INSERT INTO karma_events (chat_id, user_id, delta, reason, source, idempotency_key, created_at) VALUES ($1,$2,900,'seed','seed','helper',$3)`, [CHAT, HELPER, h.clock.now()])
    h.tg.bots.add(HELPER)
  })

  it('off by default: no bot in the leaderboard and no tag for it', async () => {
    await h.app.settle()
    expect(await names()).toEqual(['Alice', 'Bob', 'Carol'])
    expect(tagCalls().filter((args) => args[1] === HELPER)).toEqual([])
  })

  it('on: the bot stands in the leaderboard with its mark and gets the karma tag; off again: the row and the tag are gone', async () => {
    await toggle(true)
    const rows = (await json(await get(web, '/api/leaderboard?period=all', VECTORS.admin_admin))).rows
    expect(rows.map((r: { name: string; is_bot: boolean }) => [r.name, r.is_bot])).toEqual([['Helper Bot', true], ['Alice', false], ['Bob', false], ['Carol', false]])
    expect(await names('week')).toEqual(['Helper Bot', 'Alice', 'Carol'])
    await h.app.settle()
    expect(tagCalls().filter((args) => args[1] === HELPER)).toEqual([[CHAT, HELPER, '+900']])
    await toggle(false)
    expect(await names()).toEqual(['Alice', 'Bob', 'Carol'])
    h.clock.advance(2 * HOUR)
    await h.app.settle()
    expect(tagCalls().filter((args) => args[1] === HELPER)).toEqual([[CHAT, HELPER, '+900'], [CHAT, HELPER, '']])
    expect((await h.db.query('SELECT tag_text FROM members WHERE chat_id = $1 AND user_id = $2', [CHAT, HELPER]))[0].tag_text).toBeNull()
  })

  it('a tag somebody else put on the bot since is not erased when the checkbox goes off', async () => {
    await toggle(true)
    await h.app.settle()
    h.tg.tags.set(HELPER, 'мой бот')
    await toggle(false)
    h.clock.advance(2 * HOUR)
    await h.app.settle()
    expect(tagCalls().filter((args) => args[1] === HELPER)).toEqual([[CHAT, HELPER, '+900']])
    expect(h.tg.tags.get(HELPER)).toBe('мой бот')
    expect((await h.db.query('SELECT tag_text FROM members WHERE chat_id = $1 AND user_id = $2', [CHAT, HELPER]))[0].tag_text).toBeNull()
  })
})
