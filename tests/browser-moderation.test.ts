import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN, BOB, CHAT, createHarness, type Harness } from './support/harness.js'
import { openPage, type Page } from './support/page.js'
import { VECTORS } from './support/vectors.js'
import { buildClient, makeWeb, seedWorld } from './support/web.js'

// Section 3.6.5 on the screen: what an admin sees and presses in the Mini App, and what the sanctioned member sees.

let h: Harness
let server: ReturnType<typeof serve>
let site: { base: string; bundle: string }

beforeEach(async () => {
  h = await createHarness()
  await seedWorld(h)
  h.tg.members.set(ADMIN.id, 'administrator')
  const web = await makeWeb(h)
  const bundle = readFileSync(join(await buildClient(), 'app.js'), 'utf8')
  await new Promise<void>((done) => {
    server = serve({ fetch: web.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => {
      site = { base: `http://127.0.0.1:${info.port}`, bundle }
      done()
    })
  })
})
afterEach(async () => {
  server.close()
  await h.close()
})

const press = (page: Page, selector: string): Promise<void> => page.click(selector)
const texts = (page: Page, selector: string): Array<string | null> => page.$$(selector).map((el) => el.textContent)

async function waitText(page: Page, selector: string, text: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (page.$(selector)?.textContent === text) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`"${text}" not shown in ${selector}: ${page.$(selector)?.textContent}`)
}

async function openBob(page: Page): Promise<void> {
  await press(page, 'button[data-screen=lb]')
  await press(page, 'button[data-period=all]')
  let bob = undefined as ReturnType<Page['$']> | undefined
  for (let i = 0; i < 150 && !bob; i++) {
    bob = page.$$('button.row').find((row) => row.textContent?.includes('Bob'))
    if (!bob) await new Promise((r) => setTimeout(r, 20))
  }
  bob!.dispatchEvent(new page.window.Event('click', { bubbles: true }))
  await page.waitFor('[data-field=karma]')
}

describe('F32: the moderation buttons of an admin', () => {
  it('the page of a member: «В парилку» opens three terms, a term sanctions, then «Выпустить из парилки» lifts it', async () => {
    const page = await openPage(site, VECTORS.admin_admin)
    await page.waitFor('[data-field=bots]')
    await openBob(page)
    await page.waitFor('[data-field=mod]')
    expect(page.$('[data-field=mod_state]')?.textContent).toBe('Наказаний нет.')
    expect(texts(page, '[data-field=mod] .row2:not(.terms) button')).toEqual(['В парилку', 'Забанить'])
    expect(page.$('[data-field=mod] .terms')?.getAttribute('hidden')).toBe('')
    await press(page, '[data-field=mod] [data-action=steam]')
    expect(page.$('[data-field=mod] .terms')?.getAttribute('hidden')).toBeNull()
    expect(texts(page, '[data-field=mod] .terms button')).toEqual(['1 час', 'Сутки', 'Неделя'])
    await press(page, '[data-field=mod] [data-hours="24"]')
    await waitText(page, '[data-field=mod_result]', 'Bob в парилке до 02.09.2026 17:00')
    expect(page.$('[data-field=mod_state]')?.textContent).toBe('Сейчас: в парилке до 02.09.2026 17:00, отправил Admin.')
    expect(texts(page, '[data-field=mod] .row2:not(.terms) button')).toEqual(['Выпустить из парилки', 'Забанить'])
    await press(page, '[data-field=mod] [data-action=unban]')
    await waitText(page, '[data-field=mod_result]', 'Bob выпущен из парилки')
    expect(page.$('[data-field=mod_state]')?.textContent).toBe('Наказаний нет.')
    expect(await h.db.query('SELECT 1 FROM bans WHERE chat_id = $1 AND user_id = $2', [CHAT, BOB.id])).toEqual([])
  })

  it('«Забанить» asks first and bans on the second press', async () => {
    const page = await openPage(site, VECTORS.admin_admin)
    await page.waitFor('[data-field=bots]')
    await openBob(page)
    await press(page, '[data-field=mod] [data-action=ban]')
    expect(page.$('[data-field=mod] [data-action=ban]')?.textContent).toBe('Точно забанить?')
    expect(h.tg.count('banChatMember')).toBe(0)
    await press(page, '[data-field=mod] [data-action=ban]')
    await waitText(page, '[data-field=mod_result]', 'Bob забанен')
    expect(texts(page, '[data-field=mod] .row2:not(.terms) button')).toEqual(['Разбанить'])
    expect(h.tg.of('banChatMember').map((c) => c.args)).toEqual([[CHAT, BOB.id]])
  })

  it('the bath: an admin sees the real name, the sanction and the button that lifts it; the journal keeps the action', async () => {
    const page = await openPage(site, VECTORS.admin_admin)
    await page.waitFor('[data-field=bots]')
    await press(page, 'button[data-screen=bans]')
    await page.waitFor('.ban-card [data-field=mod]')
    expect(page.$('.ban-card h2')?.textContent).toBe('Дмитрий (@dmitry_spam)')
    expect(page.$('.ban-card [data-field=mod_state]')?.textContent).toBe('Сейчас: в парилке за спам до 02.09.2026 17:00, потом бан.')
    await press(page, '.ban-card [data-action=unban]')
    await waitText(page, '.ban-card [data-field=mod_result]', 'Дмитрий выпущен из парилки')
    expect(page.$('.ban-card [data-action=unban]')).toBeNull()
    await press(page, 'button[data-screen=admin]')
    await page.waitFor('[data-field=modlog]')
    expect(page.$('[data-field=modlog]')?.textContent).toContain('Admin: Дмитрий выпущен из парилки')
  })

  it('a member who is not an admin sees no moderation: neither on a page nor in the bath', async () => {
    const page = await openPage(site, VECTORS.alice_lb)
    await page.waitFor('[data-testid=leaderboard]')
    await openBob(page)
    expect(page.$('[data-field=mod]')).toBeNull()
    await press(page, 'button[data-screen=bans]')
    await page.waitFor('.ban-card')
    expect(page.$('.ban-card [data-field=mod]')).toBeNull()
    expect(page.$('.ban-card h2')?.textContent).not.toBe('Дмитрий')
  })

  it('the admin tab: the search finds a member and opens the page with the buttons', async () => {
    const page = await openPage(site, VECTORS.admin_admin)
    await page.waitFor('[data-field=member_query]')
    ;(page.$('[data-field=member_query]') as unknown as { value: string }).value = 'car'
    await press(page, '[data-action=find]')
    await page.waitFor('[data-field=member_results] button.row')
    expect(texts(page, '[data-field=member_results] .name')).toEqual(['Carol'])
    await press(page, '[data-field=member_results] button.row')
    await page.waitFor('[data-field=mod]')
    expect(page.$('h1')?.textContent).toBe('Carol')
  })
})

describe('F33: the checkbox «Боты в рейтинге»', () => {
  it('unchecked by default; a tick saves the setting and says so', async () => {
    const page = await openPage(site, VECTORS.admin_admin)
    const box = (await page.waitFor('#bots-in-rating')) as unknown as { checked: boolean; dispatchEvent(event: unknown): boolean }
    expect(box.checked).toBe(false)
    expect(page.$('[data-field=settings] [data-key=bots_in_rating]')).toBeNull()
    box.checked = true
    box.dispatchEvent(new page.window.Event('change', { bubbles: true }))
    await waitText(page, '[data-field=bots] [role=status]', 'Боты включены в рейтинг')
    expect((await h.db.query(`SELECT value FROM chat_settings WHERE chat_id = $1 AND key = 'bots_in_rating' ORDER BY seq DESC LIMIT 1`, [CHAT]))[0].value).toBe(true)
  })
})

describe('F32: the member under a sanction of an admin', () => {
  it('the appeal tab says whose decision it is and sends one request', async () => {
    await h.db.query(
      `INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at, source, by_admin_id, by_admin_name)
       VALUES ($1,1,'admin',0,0,0,'steam',$2,$3,'admin',99,'Admin')`,
      [CHAT, new Date(h.clock.now().getTime() + 3_600_000), h.clock.now()],
    )
    const page = await openPage(site, VECTORS.alice_appeal)
    await page.waitFor('[data-field=sanction]')
    expect(page.$('[data-field=sanction]')?.textContent).toBe('Вы в парилке до 01.09.2026 18:00.')
    expect(page.$('[data-action=human]')).toBeNull()
    await press(page, '[data-action=request]')
    await waitText(page, '[data-field=appeal_result]', 'Просьба у админов, ждите решения.')
    expect(page.$('[data-action=request]')).toBeNull()
    expect((await h.db.query(`SELECT kind FROM admin_cards WHERE chat_id = $1`, [CHAT])).map((c) => c.kind)).toEqual(['unban_request'])
  })
})
