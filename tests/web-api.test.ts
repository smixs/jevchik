import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/db.js'
import { createApp } from '../src/app.js'
import { pollOnce } from '../src/poller.js'
import { createWebApp } from '../src/web/api.js'
import { loadJokes } from '../src/sanctions.js'
import { tgError } from './support/fakes.js'
import { ALICE, CHAT, OTHER_CHAT, createHarness, karmaOf, message, type Harness } from './support/harness.js'
import { BOT_TOKEN, VECTORS } from './support/vectors.js'
import { buildClient, get, makeWeb, seedWorld, send } from './support/web.js'
import { fileURLToPath } from 'node:url'

let h: Harness
let web: Awaited<ReturnType<typeof makeWeb>>
beforeEach(async () => {
  h = await createHarness()
  await seedWorld(h)
  web = await makeWeb(h)
})
afterEach(async () => {
  await h.close()
})

const json = async (response: Response): Promise<any> => response.json() // eslint-disable-line @typescript-eslint/no-explicit-any

describe('F18: access to the API', () => {
  it('healthz answers 200 with the literal body', async () => {
    const response = await get(web, '/healthz')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok', db: 'ok' })
  })

  it('401 without initData, with a broken hash, with another bot, with an expired date', async () => {
    expect((await get(web, '/api/leaderboard')).status).toBe(401)
    expect((await get(web, '/api/leaderboard', `${VECTORS.bob_lb.slice(0, -1)}0`)).status).toBe(401)
    expect((await get(web, '/api/leaderboard', VECTORS.other_bot)).status).toBe(401)
    expect((await get(web, '/api/leaderboard', VECTORS.old)).status).toBe(401)
    const badScheme = await web.request('/api/leaderboard', { headers: { authorization: `Bearer ${VECTORS.bob_lb}` } })
    expect(badScheme.status).toBe(401)
    expect(await json(await get(web, '/api/leaderboard', VECTORS.old))).toEqual({ error: 'unauthorized', reason: 'expired' })
  })

  it('a request without a chat context or with an unknown chat is refused, never guessed', async () => {
    expect((await get(web, '/api/leaderboard', VECTORS.no_ctx)).status).toBe(400)
    expect((await get(web, '/api/leaderboard', VECTORS.outsider_unknown)).status).toBe(404)
  })

  it('the leaderboard, personal pages and the ban list are open to any verified user, chat membership is not required', async () => {
    expect((await get(web, '/api/leaderboard', VECTORS.outsider_lb)).status).toBe(200)
    expect((await get(web, '/api/bans', VECTORS.outsider_lb)).status).toBe(200)
    expect((await get(web, '/api/me', VECTORS.outsider_lb)).status).toBe(200)
  })

  it('the admin screen is for administrators only, checked fresh on every request', async () => {
    h.tg.members.set(99, 'administrator')
    expect((await get(web, '/api/admin/settings', VECTORS.bob_admin)).status).toBe(403)
    expect((await get(web, '/api/admin/whoami', VECTORS.admin_admin)).status).toBe(200)
    expect((await get(web, '/api/admin/audit', VECTORS.admin_admin)).status).toBe(200)
    expect(h.tg.count('getChatMember')).toBe(3)
    h.tg.members.set(99, 'member')
    expect((await get(web, '/api/admin/whoami', VECTORS.admin_admin)).status).toBe(403)
    h.tg.members.set(99, 'creator')
    expect((await get(web, '/api/admin/whoami', VECTORS.admin_admin)).status).toBe(200)
    h.tg.members.set(99, 'restricted')
    expect((await get(web, '/api/admin/whoami', VECTORS.admin_admin)).status).toBe(403)
    h.tg.members.set(99, 'left')
    expect((await get(web, '/api/admin/whoami', VECTORS.admin_admin)).status).toBe(403)
  })

  it('an administrator of another chat has no access: the check is bound to the chat of the signed context', async () => {
    h.tg.members.set(1, 'member')
    expect((await get(web, '/api/admin/whoami', VECTORS.alice_me)).status).toBe(403)
    expect(h.tg.of('getChatMember').map((c) => c.args)).toEqual([[CHAT, 1]])
  })

  it('T-member-down: when Telegram cannot confirm the role, access is not granted', async () => {
    h.tg.fail('getChatMember', tgError.server(), 3)
    const response = await get(web, '/api/admin/settings', VECTORS.admin_admin)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'try_later' })
    h.tg.failures.clear()
    h.tg.fail('getChatMember', tgError.bad('Bad Request: user not found'))
    expect((await get(web, '/api/admin/settings', VECTORS.admin_admin)).status).toBe(403)
  })
})

describe('F16: data of the leaderboard and the personal page', () => {
  it('the leaderboard for a week, a month and all time', async () => {
    const at = async (period: string) => json(await get(web, `/api/leaderboard?period=${period}`, VECTORS.bob_lb))
    const strip = (data: { rows: Array<{ place: number; name: string; karma: number; is_me: boolean }> }) => data.rows.map((r) => [r.place, r.name, r.karma, r.is_me])
    expect(strip(await at('week'))).toEqual([[1, 'Alice', 5, false], [2, 'Carol', 3, false]])
    expect(strip(await at('month'))).toEqual([[1, 'Alice', 12.5, false], [2, 'Bob', 7.25, true], [3, 'Carol', 3, false]])
    expect(strip(await at('all'))).toEqual([[1, 'Alice', 12.5, false], [2, 'Bob', 7.25, true], [3, 'Carol', 3, false]])
    expect((await at('month')).me).toEqual({ place: 2, karma: 7.25 })
    expect(strip(await at('nonsense'))).toEqual(strip(await at('all')))
  })

  it('two chats are not mixed', async () => {
    const other = await json(await get(web, '/api/leaderboard?period=all', VECTORS.alice_me_other))
    expect(other.rows.map((r: { name: string; karma: number }) => [r.name, r.karma])).toEqual([['Alice', 99], ['Erin', 40]])
    const here = await json(await get(web, '/api/leaderboard?period=all', VECTORS.alice_lb))
    expect(here.rows.map((r: { name: string }) => r.name)).toEqual(['Alice', 'Bob', 'Carol'])
    const me = await json(await get(web, '/api/me', VECTORS.alice_me_other))
    expect([me.karma, me.messages.latest.map((m: { excerpt: string }) => m.excerpt)]).toEqual([99, ['Сообщение Алисы из другого чата']])
    const mine = await json(await get(web, '/api/me', VECTORS.alice_me))
    expect(mine.karma).toBe(12.5)
    const context = await json(await get(web, '/api/context', VECTORS.alice_me_other))
    expect(context.chat.title).toBe('Other chat')
    expect([context.viewer.name, context.viewer.karma]).toEqual(['Alice', 99])
    expect((await json(await get(web, '/api/context', VECTORS.alice_me))).viewer.karma).toBe(12.5)
  })

  it('the personal page has every field of section 3.9', async () => {
    const page = await json(await get(web, '/api/me', VECTORS.alice_me))
    expect(page).toEqual({
      empty: false,
      name: 'Alice',
      hidden: false,
      is_channel: false,
      is_bot: false,
      karma: 12.5,
      place: 1,
      week_delta: 5,
      chart: [{ date: '2026-08-12', karma: 7.5 }, { date: '2026-08-30', karma: 12.5 }],
      thanks_count: 1,
      answers_count: 2,
      caught_spammers_count: 0,
      streak_weeks: 2,
      decay_warning: { starts_at: '2026-09-03T12:00:00.000Z', days_left: 2 },
      messages: {
        latest: [
          { message_id: 503, excerpt: 'Просто мнение', link: 'https://t.me/c/1234567890/503', karma: 0, replies: 0 },
          { message_id: 502, excerpt: 'Ссылка на документацию', link: 'https://t.me/c/1234567890/502', karma: 1, replies: 7 },
          { message_id: 501, excerpt: 'Разбор: как настроить агента на Jev', link: 'https://t.me/c/1234567890/501', karma: 5, replies: 2 },
        ],
        top_upvoted: [
          { message_id: 501, excerpt: 'Разбор: как настроить агента на Jev', link: 'https://t.me/c/1234567890/501', karma: 5, replies: 2 },
          { message_id: 502, excerpt: 'Ссылка на документацию', link: 'https://t.me/c/1234567890/502', karma: 1, replies: 7 },
          { message_id: 503, excerpt: 'Просто мнение', link: 'https://t.me/c/1234567890/503', karma: 0, replies: 0 },
        ],
        most_replied: [
          { message_id: 502, excerpt: 'Ссылка на документацию', link: 'https://t.me/c/1234567890/502', karma: 1, replies: 7 },
          { message_id: 501, excerpt: 'Разбор: как настроить агента на Jev', link: 'https://t.me/c/1234567890/501', karma: 5, replies: 2 },
          { message_id: 503, excerpt: 'Просто мнение', link: 'https://t.me/c/1234567890/503', karma: 0, replies: 0 },
        ],
      },
    })
  })

  it('a public chat gets links by username', async () => {
    await h.db.query(`UPDATE chats SET username = 'agents_chat' WHERE chat_id = $1`, [CHAT])
    const page = await json(await get(web, '/api/me', VECTORS.alice_me))
    expect(page.messages.latest[0].link).toBe('https://t.me/agents_chat/503')
  })

  it('a page of another participant is reachable by an opaque id', async () => {
    const board = await json(await get(web, '/api/leaderboard?period=all', VECTORS.bob_lb))
    const alice = board.rows[0]
    expect(alice.public_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(board)).not.toContain('"user_id"')
    const page = await json(await get(web, `/api/members/${alice.public_id}`, VECTORS.bob_lb))
    expect(page.name).toBe('Alice')
    expect((await get(web, '/api/members/not-an-id', VECTORS.bob_lb)).status).toBe(404)
    expect((await get(web, '/api/members/00000000-0000-0000-0000-000000000000', VECTORS.bob_lb)).status).toBe(404)
  })

  it('T-empty: a participant without records gets a 200 with empty blocks', async () => {
    const response = await get(web, '/api/me', VECTORS.outsider_lb)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      empty: true, name: 'Outsider', hidden: false, is_channel: false, is_bot: false, karma: 0, place: null, week_delta: 0, chart: [], thanks_count: 0, answers_count: 0,
      caught_spammers_count: 0, streak_weeks: 0, decay_warning: null, messages: { latest: [], top_upvoted: [], most_replied: [] },
    })
    const carol = await json(await get(web, '/api/leaderboard?period=all', VECTORS.bob_lb))
    const empty = await json(await get(web, `/api/members/${carol.rows[2].public_id}`, VECTORS.bob_lb))
    expect(empty.messages.latest).toEqual([])
  })
})

describe('F17: the ban list', () => {
  it('shows the masked name, category, a joke explanation and a picture, and nothing that identifies the person', async () => {
    const response = await get(web, '/api/bans', VECTORS.outsider_lb)
    const body = await response.json()
    expect(body).toEqual({
      bans: [
        {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          name: 'Д***',
          category: 'spam_topic_pivot',
          category_title: 'Поддакнул и достал рекламу',
          explanation: loadJokes().explanations[1],
          image: '/ban-images/steam.webp',
          state: 'steam',
          date: '2026-09-01T11:00:00.000Z',
        },
      ],
    })
    const text = JSON.stringify(body)
    for (const forbidden of ['dmitry_spam', 'Дмитрий', 'Заработай', 'telegram_user_id', 'user_id', 'photo', 'username', '"4"']) expect(text).not.toContain(forbidden)
    expect(Object.keys(body.bans[0]).sort()).toEqual(['category', 'category_title', 'date', 'explanation', 'id', 'image', 'state', 'name'].sort())
  })

  it('the picture is served', async () => {
    const image = await web.request('/ban-images/steam.webp')
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/webp')
    for (const name of ['mascot', 'medal-1', 'medal-2', 'medal-3']) expect((await web.request(`/img/${name}.webp`)).headers.get('content-type'), name).toBe('image/webp')
    expect((await web.request('/img/..%2F..%2Fpackage.json')).status).toBe(404)
    expect((await web.request('/ban-images/..%2F..%2Fpackage.json')).status).toBe(404)
  })

  it('a chat without bans returns an empty list; the other chat does not see this ban', async () => {
    expect(await json(await get(web, '/api/bans', VECTORS.outsider_other))).toEqual({ bans: [] })
  })
})

describe('F19: hide my page', () => {
  it('removes the page and the excerpts for others; the leaderboard row stays with a masked name', async () => {
    const board = await json(await get(web, '/api/leaderboard?period=all', VECTORS.alice_lb))
    const bobId = board.rows[1].public_id
    expect((await send(web, 'POST', '/api/me/hide', VECTORS.bob_lb, { hidden: true })).status).toBe(200)
    const asAlice = await get(web, `/api/members/${bobId}`, VECTORS.alice_lb)
    expect(asAlice.status).toBe(404)
    expect(await asAlice.json()).toEqual({ error: 'page_hidden' })
    const after = await json(await get(web, '/api/leaderboard?period=all', VECTORS.alice_lb))
    expect(after.rows.map((r: { name: string; karma: number }) => [r.name, r.karma])).toEqual([['Alice', 12.5], ['B***', 7.25], ['Carol', 3]])
    const own = await json(await get(web, '/api/me', VECTORS.bob_lb))
    expect(own.hidden).toBe(true)
    expect(own.messages.latest).toHaveLength(1)
    await send(web, 'POST', '/api/me/hide', VECTORS.bob_lb, { hidden: false })
    expect((await get(web, `/api/members/${bobId}`, VECTORS.alice_lb)).status).toBe(200)
  })

  it('validates the body', async () => {
    expect((await send(web, 'POST', '/api/me/hide', VECTORS.bob_lb, { hidden: 'yes' })).status).toBe(422)
    expect((await send(web, 'POST', '/api/me/hide', VECTORS.outsider_lb, { hidden: true })).status).toBe(404)
  })
})

describe('the appeal through the API', () => {
  it('runs the same flow as the function', async () => {
    await h.db.query(`INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at) VALUES ($1,3,'admin',0,0,0,'steam',$2,$2)`, [CHAT, h.clock.now()])
    await h.db.query('UPDATE members SET bans_count = 1 WHERE user_id = 3 AND chat_id = $1', [CHAT])
    expect(await json(await get(web, '/api/appeal', VECTORS.carol_appeal))).toEqual({ status: 'none', allowed: true })
    expect((await send(web, 'POST', '/api/appeal', VECTORS.carol_appeal, { text: '' })).status).toBe(422)
    h.jev.script('Я человек', { appeal_genuine: 0.95 })
    const response = await send(web, 'POST', '/api/appeal', VECTORS.carol_appeal, { text: 'Я человек' })
    expect(await response.json()).toEqual({ status: 'accepted', lifted: true })
    expect(await karmaOf(h, ALICE.id)).toBe(12.5)
  })
})

describe('T-db-down', () => {
  it('healthz gives 503, the API tells the client, updates are not acknowledged', async () => {
    const dead = new Db('postgres://postgres@127.0.0.1:1/none', 2)
    const ctx = { ...h.ctx, db: dead }
    const app = createWebApp(ctx, { botToken: BOT_TOKEN, publicDir: await buildClient(), imagesDir: fileURLToPath(new URL('../data-static/img', import.meta.url)) })
    const health = await app.request('/healthz')
    expect(health.status).toBe(503)
    expect(await health.json()).toEqual({ status: 'error', db: 'down' })
    const api = await app.request('/api/leaderboard', { headers: { authorization: `tma ${VECTORS.bob_lb}` } })
    expect(api.status).toBe(503)
    expect(await api.json()).toEqual({ error: 'db_down' })
    const botApp = createApp(ctx)
    const update = message({ id: 1, text: 'привет' })
    h.tg.updates = [update]
    const result = await pollOnce(ctx, botApp, update.update_id)
    expect(result).toEqual({ offset: update.update_id, ok: false })
    await dead.close()
  })
})

describe('text of removed messages', () => {
  it('is shown only to a freshly checked administrator of that chat', async () => {
    h.tg.members.set(99, 'administrator')
    const admin = await (await get(web, '/api/admin/held', VECTORS.admin_admin)).json()
    expect(admin.held).toEqual([expect.objectContaining({ message_id: 880, author_name: 'Дмитрий', text: 'Заработай миллион на крипте', reason: 'spam' })])
    expect((await get(web, '/api/admin/held', VECTORS.bob_admin)).status).toBe(403)
    expect((await get(web, '/api/admin/held', VECTORS.bob_lb)).status).toBe(403)
    h.clock.advance(31 * 86_400_000)
    h.clock.set('2026-09-01T12:00:00Z')
    await h.db.query(`UPDATE held_texts SET expires_at = $1`, [new Date('2026-09-01T11:59:00Z')])
    expect((await (await get(web, '/api/admin/held', VECTORS.admin_admin)).json()).held).toEqual([])
  })
})

describe('static files', () => {
  it('serves the app shell and refuses path tricks', async () => {
    const page = await web.request('/')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('id="app"')
    expect((await web.request('/app.js')).status).toBe(200)
    expect((await web.request('/..%2f..%2fpackage.json')).status).toBe(404)
    expect((await web.request('/nope.txt')).status).toBe(404)
    expect(OTHER_CHAT).toBeLessThan(0)
  })
})
