import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadJokes } from '../src/sanctions.js'
import { CHAT, createHarness, type Harness } from './support/harness.js'
import { VECTORS } from './support/vectors.js'
import { openPage, type Page, type Patch } from './support/page.js'
import { buildClient, makeWeb, seedWorld } from './support/web.js'

let h: Harness
let server: ReturnType<typeof serve>
let base: string
let bundle: string

beforeAll(async () => {
  h = await createHarness()
  await seedWorld(h)
  const web = await makeWeb(h)
  const dir = await buildClient()
  bundle = readFileSync(join(dir, 'app.js'), 'utf8')
  await new Promise<void>((done) => {
    server = serve({ fetch: web.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      base = `http://127.0.0.1:${info.port}`
      done()
    })
  })
})
afterAll(async () => {
  server.close()
  await h.close()
})

const open = (initData: string, options: { patch?: Patch; motion?: boolean } = {}): Promise<Page> => openPage({ base, bundle }, initData, options)

const field = (page: Page, name: string): string => page.$(`[data-field="${name}"] b`)?.textContent ?? ''

describe('F16: Mini App in a browser environment, two chats with different fixtures', () => {
  it('the leaderboard: week by default, then month and all time; a tap opens the personal page', async () => {
    const page = await open(VECTORS.bob_lb)
    await page.waitFor('[data-testid=leaderboard]')
    expect(page.$$('button.row').map((row) => row.textContent)).toEqual(['1Alice5.00', '2Carol3.00'])
    await page.click('button[data-period=month]')
    await page.waitFor('button.row.me')
    expect(page.$$('button.row').map((row) => row.textContent)).toEqual(['1Alice12.50', '2Bob7.25', '3Carol3.00'])
    expect(page.$('button[data-period=month]')?.getAttribute('aria-current')).toBe('true')
    await page.click('button[data-period=all]')
    await page.waitFor('button.row.me')
    const alice = page.$$('button.row')[0]
    alice.dispatchEvent(new page.window.Event('click', { bubbles: true }))
    await page.waitFor('[data-field=karma]')
    expect(field(page, 'karma')).toBe('12.50')
    expect(field(page, 'place')).toBe('1')
    expect(field(page, 'week_delta')).toBe('5.00')
    expect(field(page, 'thanks_count')).toBe('1')
    expect(field(page, 'answers_count')).toBe('2')
    expect(field(page, 'caught_spammers_count')).toBe('0')
    expect(field(page, 'streak_weeks')).toBe('2')
    expect(page.$('[data-field=decay_warning]')?.textContent).toContain('Карма начнёт убывать')
    expect(page.$$('[data-field=messages_latest] li .excerpt').map((p) => p.textContent)).toEqual(['Просто мнение', 'Ссылка на документацию', 'Разбор: как настроить агента на Jev'])
    expect(page.$$('[data-field=messages_latest] li .meta span').map((span) => span.textContent)).toEqual(['0.00', '0', '+1.00', '7', '+5.00', '2'])
    expect(page.$$('[data-field=messages_latest] li a').map((a) => a.textContent)).toEqual(['Открыть в чате', 'Открыть в чате', 'Открыть в чате'])
    expect(page.$('[data-field=messages_latest] a')?.getAttribute('href')).toBe('https://t.me/c/1234567890/503')
    expect(page.$$('[data-field=messages_top_upvoted] li')[0].textContent).toContain('Разбор')
    expect(page.$$('[data-field=messages_most_replied] li')[0].textContent).toContain('Ссылка на документацию')
    expect(page.$('svg.chart')).not.toBeNull()
  })

  it('«Открыть в чате» asks Telegram to open the message: a plain link does nothing inside the Mini App', async () => {
    const page = await open(VECTORS.alice_me)
    await page.waitFor('[data-field=messages_latest] a')
    const link = page.$('[data-field=messages_latest] a')!
    const event = new page.window.Event('click', { bubbles: true, cancelable: true })
    link.dispatchEvent(event)
    expect(page.opened).toEqual(['https://t.me/c/1234567890/503'])
    expect(event.defaultPrevented).toBe(true)
  })

  it('the second chat shows only its own data', async () => {
    const page = await open(VECTORS.alice_me_other)
    await page.waitFor('[data-field=karma]')
    expect(field(page, 'karma')).toBe('99.00')
    expect(page.text()).toContain('Сообщение Алисы из другого чата')
    expect(page.text()).not.toContain('Разбор')
    await page.click('button[data-screen=lb]')
    await page.waitFor('[data-testid=leaderboard]')
    await page.click('button[data-period=all]')
    await page.waitFor('button.row.me')
    expect(page.$$('button.row').map((row) => row.textContent)).toEqual(['1Alice99.00', '2Erin40.00'])
  })

  it('the ban screen shows a masked name, the category, a joke and a picture, and no personal data', async () => {
    const page = await open(VECTORS.outsider_lb)
    await page.click('button[data-screen=bans]')
    await page.waitFor('article[data-ban-id]')
    const card = page.$('article[data-ban-id]')!
    expect(card.querySelector('h2')?.textContent).toBe('Д***')
    expect(card.querySelector('[data-field=category]')?.textContent).toBe('Поддакнул и достал рекламу')
    expect(card.querySelector('[data-field=explanation]')?.textContent).toBe(loadJokes().explanations[1])
    expect(card.querySelector('img')?.getAttribute('src')).toBe('/ban-images/steam.webp')
    expect(page.window.document.body.textContent).not.toMatch(/Дмитрий|dmitry|Заработай/)
  })

  it('a member who writes as a channel is marked in the leaderboard and on the page; a missing field means no mark', async () => {
    const channel = (path: string, body: Record<string, unknown>): Record<string, unknown> => {
      if (path === '/api/leaderboard') return { ...body, rows: (body.rows as Array<Record<string, unknown>>).map((row) => (row.name === 'Carol' ? { ...row, is_channel: true } : row)) }
      if (path.startsWith('/api/members/') && body.name === 'Carol') return { ...body, is_channel: true }
      return body
    }
    const page = await open(VECTORS.bob_lb, { patch: channel })
    await page.waitFor('[data-testid=leaderboard]')
    expect(page.$$('button.row').map((row) => row.textContent)).toEqual(['1Alice5.00', '2Carolканал3.00'])
    expect(page.$$('button.row [data-field=channel]').map((mark) => mark.textContent)).toEqual(['канал'])
    expect(page.$('button.row [data-field=channel] img')?.getAttribute('src')).toBe('/img/megaphone.webp')
    page.$$('button.row')[1].dispatchEvent(new page.window.Event('click', { bubbles: true }))
    await page.waitFor('[data-field=karma]')
    expect(page.$('.title h1')?.textContent).toBe('Carol')
    expect(page.$('.title [data-field=channel]')?.textContent).toBe('канал')
    const plain = await open(VECTORS.alice_me)
    await plain.waitFor('[data-field=karma]')
    expect(plain.$('[data-field=channel]')).toBeNull()
  })

  it('feel: each event reports its own vibration; motion classes only when motion is not reduced, the numbers stay true', async () => {
    const page = await open(VECTORS.bob_lb, { motion: true })
    await page.waitFor('[data-testid=leaderboard]')
    expect(page.$('[data-testid=leaderboard]')?.getAttribute('class')).toContain('jcascade')
    expect(page.$('#top .karma')?.textContent).toBe('+7.25')
    await page.click('button[data-period=month]')
    await page.waitFor('button.row.me')
    expect(page.$('.tabs .pill')?.getAttribute('style')).toContain('--at: 1')
    await page.click('button[data-screen=me]')
    await page.waitFor('[data-field=karma]')
    expect(page.$('[data-field=karma] b')?.textContent).toBe('7.25')
    await page.click('button[data-action=hide]')
    expect(page.haptics).toEqual(['selection', 'selection', 'impact:light'])
    const still = await open(VECTORS.bob_lb)
    await still.waitFor('[data-testid=leaderboard]')
    expect(still.$('[data-testid=leaderboard]')?.getAttribute('class')).not.toContain('jcascade')
    expect(still.$('#top .karma')?.getAttribute('class')).not.toContain('jcount')
    for (let i = 0; i < 100 && (await h.db.query('SELECT hidden FROM members WHERE user_id = 2 AND chat_id = $1', [CHAT]))[0].hidden !== true; i++) await new Promise((r) => setTimeout(r, 20))
    await h.db.query('UPDATE members SET hidden = false WHERE user_id = 2 AND chat_id = $1', [CHAT])
  })

  it('feel: a saved setting and a failed one feel different', async () => {
    h.tg.members.set(99, 'administrator')
    const page = await open(VECTORS.admin_admin)
    await page.waitFor('[data-field=settings]')
    await page.click('button[data-save=base_quote]')
    for (let i = 0; i < 100 && !page.$('[data-save=base_quote] + span')?.textContent; i++) await new Promise((r) => setTimeout(r, 20))
    expect(page.$('[data-save=base_quote] + span')?.textContent).toBe('Сохранено')
    const area = page.$('#set-reactions_minus') as unknown as { value: string }
    area.value = '[not json'
    await page.click('button[data-save=reactions_minus]')
    expect(page.haptics).toEqual(['impact:light', 'notification:success', 'impact:light', 'notification:error'])
    h.tg.members.clear()
    await h.db.query(`DELETE FROM chat_settings WHERE key = 'base_quote'`)
  })

  it('a bad signature shows an explanation instead of data', async () => {
    const page = await open(`${VECTORS.bob_lb.slice(0, -1)}0`)
    await page.waitFor('p.error')
    expect(page.text()).toContain('Откройте Mini App из чата')
  })

  it('hide my page: the button toggles and the state is stored', async () => {
    const page = await open(VECTORS.bob_lb)
    await page.click('button[data-screen=me]')
    await page.click('button[data-action=hide]')
    await page.waitFor('button[data-action=hide]')
    for (let i = 0; i < 100 && page.$('button[data-action=hide]')?.textContent !== 'Показать мою страницу'; i++) await new Promise((r) => setTimeout(r, 20))
    expect(page.$('button[data-action=hide]')?.textContent).toBe('Показать мою страницу')
    expect((await h.db.query('SELECT hidden FROM members WHERE user_id = 2 AND chat_id = $1', [CHAT]))[0].hidden).toBe(true)
    await page.click('button[data-action=hide]')
    const hidden = async (): Promise<boolean> => (await h.db.query('SELECT hidden FROM members WHERE user_id = 2 AND chat_id = $1', [CHAT]))[0].hidden
    for (let i = 0; i < 100 && (await hidden()); i++) await new Promise((r) => setTimeout(r, 20))
    expect(await hidden()).toBe(false)
  })
})

describe('the appeal and admin screens', () => {
  beforeEach(() => {
    h.tg.members.set(99, 'administrator')
  })
  afterEach(() => {
    h.tg.members.clear()
  })

  it('appeal: "Я человек", the field, the result', async () => {
    await h.db.query(`INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at) VALUES ($1,3,'admin',0,0,0,'steam',$2,$2)`, [CHAT, h.clock.now()])
    await h.db.query('UPDATE members SET bans_count = 1 WHERE user_id = 3 AND chat_id = $1', [CHAT])
    h.jev.script('Я не бот, пришёл за советом', { appeal_genuine: 0.95 })
    const page = await open(VECTORS.carol_appeal)
    await page.waitFor('button[data-action=human]')
    expect(page.$$('#nav button').map((b) => b.getAttribute('data-screen'))).toEqual(['lb', 'me', 'bans', 'appeal'])
    await page.click('button[data-action=human]')
    const area = page.$('textarea') as unknown as { value: string }
    area.value = 'Я не бот, пришёл за советом'
    const send = page.$$('button.primary').find((b) => b.textContent === 'Отправить')!
    send.dispatchEvent(new page.window.Event('click', { bubbles: true }))
    for (let i = 0; i < 100 && !page.$('[data-field=appeal_result]')?.textContent; i++) await new Promise((r) => setTimeout(r, 20))
    expect(page.$('[data-field=appeal_result]')?.textContent).toContain('ограничение снято')
  })

  it('admin: settings with a save button, operations, cards, import and observation blocks', async () => {
    const page = await open(VECTORS.admin_admin)
    await page.waitFor('[data-field=settings]')
    expect(page.$$('#nav button').map((b) => b.getAttribute('data-screen'))).toEqual(['lb', 'me', 'bans', 'admin'])
    const input = page.$('#set-base_reply') as unknown as { value: string }
    expect(input.value).toBe('2')
    input.value = '2.5'
    await page.click('button[data-save=base_reply]')
    for (let i = 0; i < 100 && !page.$('[data-save=base_reply] + span')?.textContent; i++) await new Promise((r) => setTimeout(r, 20))
    expect(page.$('[data-save=base_reply] + span')?.textContent).toBe('Сохранено')
    expect((await h.db.query(`SELECT value FROM chat_settings WHERE key = 'base_reply'`))[0].value).toBe(2.5)
    for (const marker of ['[data-field=operations]', '[data-field=cards]', '[data-field=audit]', 'button[data-action=import]', '[data-field=observation]']) expect(page.$(marker)).not.toBeNull()
    expect(page.text()).toContain('не доказывает')
    const invalid = page.$('#set-spam_review_threshold') as unknown as { value: string }
    invalid.value = '0.95'
    await page.click('button[data-save=spam_review_threshold]')
    for (let i = 0; i < 100 && !page.$('[data-save=spam_review_threshold] + span')?.textContent; i++) await new Promise((r) => setTimeout(r, 20))
    expect(page.$('[data-save=spam_review_threshold] + span')?.textContent).toContain('Ошибка')
  })

  it('admin: a card shows the quote and the link to the message, as in Telegram (F27)', async () => {
    const text = '<b>Заработок</b> в канале @x, пиши'
    await h.db.query(`INSERT INTO held_texts (chat_id, message_id, author_id, author_name, text, reason, expires_at, created_at) VALUES ($1,4242,3,'Carol',$2,'card',$3,$4)`, [CHAT, text, new Date(h.clock.now().getTime() + 86_400_000), h.clock.now()])
    await h.db.query(`INSERT INTO admin_cards (chat_id, idempotency_key, kind, payload, delivery, created_at) VALUES ($1,'browser:4242','review',$2,'delivered',$3)`, [
      CHAT,
      JSON.stringify({ targetUserId: 3, targetName: 'Carol', messageId: 4242, category: 'spam_channel_bait', spam: 0.4 }),
      h.clock.now(),
    ])
    const page = await open(VECTORS.admin_admin)
    await page.waitFor('[data-field=cards] [data-field=card_text]')
    const card = page.$$('[data-field=cards] article').find((a) => a.querySelector('[data-field=card_text]')?.textContent?.includes('4242'))!
    expect(card.querySelector('[data-field=card_text]')?.textContent).toBe(
      [
        'Похоже на спам, реши',
        'Участник: Carol',
        'Категория: Заманивание в канал',
        'Уверенность: 40%',
        text,
        'Ссылка: https://t.me/c/1234567890/4242',
      ].join('\n'),
    )
    expect(card.querySelector('[data-field=card_text] b')).toBeNull()
    expect(card.querySelector('a[data-field=card_link]')?.getAttribute('href')).toBe('https://t.me/c/1234567890/4242')
    await h.db.query(`DELETE FROM admin_cards WHERE idempotency_key = 'browser:4242'`)
    await h.db.query('DELETE FROM held_texts WHERE message_id = 4242')
  })

  it('admin: a settings value that is not JSON is explained, nothing is sent', async () => {
    const page = await open(VECTORS.admin_admin)
    await page.waitFor('[data-field=settings]')
    const area = page.$('#set-reactions_minus') as unknown as { value: string }
    area.value = '[not json'
    await page.click('button[data-save=reactions_minus]')
    expect(page.$('[data-save=reactions_minus] + span')?.textContent).toBe('Ошибка: это не JSON')
    expect(await h.db.query(`SELECT 1 FROM chat_settings WHERE key = 'reactions_minus'`)).toEqual([])
  })

  it('admin link for a non-administrator: no admin tab, no data, the leaderboard opens', async () => {
    const page = await open(VECTORS.bob_admin)
    await page.waitFor('[data-testid=leaderboard]')
    expect(page.$('[data-field=settings]')).toBeNull()
    expect(page.$('p.error')).toBeNull()
    expect(page.$$('#nav button').map((b) => b.getAttribute('data-screen'))).toEqual(['lb', 'me', 'bans'])
  })

  it('tabs: a member without a ban sees no appeal tab, the appeal link opens the leaderboard', async () => {
    const page = await open(VECTORS.no_ctx)
    await page.waitFor('[data-testid=leaderboard]')
    expect(page.$$('#nav button').map((b) => b.textContent)).toEqual(['Лидерборд', 'Я', 'Баня'])
  })
})

describe('section 3.8: the Mini App opened without start_param (the "Open App" button of the bot profile)', () => {
  it('one chat: its leaderboard at once, no error', async () => {
    const page = await open(VECTORS.no_ctx)
    await page.waitFor('[data-testid=leaderboard]')
    expect(page.$$('button.row').map((row) => row.textContent)).toEqual(['1Alice5.00', '2Carol3.00'])
    expect(page.$('p.error')).toBeNull()
  })

  it('several chats: a choice of chat, then the leaderboard of the chosen one', async () => {
    const page = await open(VECTORS.alice_no_ctx)
    await page.waitFor('[data-field=chats] button')
    expect(page.$$('[data-field=chats] button').map((b) => b.textContent)).toEqual(['Agents chat', 'Other chat'])
    await page.click(`[data-field=chats] button[data-chat-id="${-1009876543210}"]`)
    await page.waitFor('[data-testid=leaderboard]')
    await page.click('button[data-period=all]')
    await page.waitFor('button.row.me')
    expect(page.$$('button.row').map((row) => row.textContent)).toEqual(['1Alice99.00', '2Erin40.00'])
  })

  it('no chat: a plain explanation instead of an error', async () => {
    const page = await open(VECTORS.outsider_no_ctx)
    await page.waitFor('[data-field=no_chats]')
    expect(page.text()).toBe('Вы пока не участвуете ни в одном чате с Жевчиком.')
    expect(page.$('p.error')).toBeNull()
  })

  it('a start_param of an unknown chat is refused, and the reason is said plainly', async () => {
    const page = await open(VECTORS.bob_unknown_ctx)
    await page.waitFor('p.error')
    expect(page.text()).toBe('Этот чат не подключён к Жевчику.')
  })
})
