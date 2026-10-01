import { createHmac, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAnswers } from './support/fakes.js'
import { fakeServer, reply, type Fake } from './support/http.js'
import { runBot } from '../src/bot.js'
import { runWeb } from '../src/web.js'
import { readConfig } from '../src/config.js'
import { CHAT, createDatabase } from './support/harness.js'
import { buildClient } from './support/web.js'

// The whole path through the real entry points (dist-less, via tsx): fake Telegram and fake Jev servers on HTTP,
// a real PostgreSQL, real long polling, the worker loop and the web process. This is not a live Telegram run.

const TOKEN = '123456:E2E-TOKEN-abcdef'
const MESSAGE_ID = 4242
let telegram: Fake
let jev: Fake
let database: Awaited<ReturnType<typeof createDatabase>>
let delivered = false

function signedInitData(userId: number, startParam: string): string {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AAE2E',
    user: JSON.stringify({ id: userId, first_name: 'Alice' }),
    start_param: startParam,
  }
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest()
  const hash = createHmac('sha256', secret).update(check).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}

async function until<T>(what: string, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 40_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

beforeAll(async () => {
  database = await createDatabase()
  jev = await fakeServer((seen, _i, res) => {
    const request = JSON.parse(seen.body)
    reply(res, 200, { answers: buildAnswers(request, { usefulness: { score: 4, confidence: 0.9 } }), usage: { input_tokens: 100 } })
  })
  telegram = await fakeServer((seen, _i, res) => {
    const method = seen.url!.split('/').pop()!
    if (method === 'getMe') return reply(res, 200, { ok: true, result: { id: 777, is_bot: true, first_name: 'Jevchik', username: 'jevchik_bot' } })
    if (method === 'getUpdates') {
      if (!delivered) {
        delivered = true
        const update = {
          update_id: 5001,
          message: { message_id: MESSAGE_ID, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'supergroup', title: 'E2E chat' }, from: { id: 1, first_name: 'Alice', username: 'alice' }, text: 'Подробный разбор: как настроить агента и не сжечь бюджет' },
        }
        return reply(res, 200, { ok: true, result: [update] })
      }
      return void setTimeout(() => reply(res, 200, { ok: true, result: [] }), 400)
    }
    if (method === 'getChat') return reply(res, 200, { ok: true, result: { id: 1, type: 'private', first_name: 'Alice', bio: 'agents' } })
    reply(res, 200, { ok: true, result: true })
  })
  await database.db.query(`INSERT INTO chats (chat_id, title, observation_started_at, created_at) VALUES ($1,'E2E chat',now() - interval '30 days',now() - interval '30 days')`, [CHAT])
})

afterAll(async () => {
  await telegram.close()
  await jev.close()
  await database.drop()
})

describe('the real entry points against doubles', () => {
  it('bot: a message is polled, judged by Jev, karma is written and the bot reacts; the answers come from Jev, not from code', async () => {
    const env = {
      DATABASE_URL: database.url,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TYPESAFE_API_KEY: 'e2e-key',
      TELEGRAM_API_ROOT: telegram.url,
      JEV_API_URL: `${jev.url}/v1/systemone`,
      IMPORT_DIR: mkdtempSync(join(tmpdir(), 'jevchik-e2e-')),
      BOT_USERNAME: 'jevchik_bot',
    }
    const abort = new AbortController()
    let crash: unknown = null
    const running = runBot(readConfig(env), abort.signal, join(env.IMPORT_DIR, 'heartbeat')).catch((error) => {
      crash = error
    })
    await until('the reaction call', () => telegram.seen.find((s) => s.url!.endsWith('/setMessageReaction')), 40_000)
    const reaction = JSON.parse(telegram.seen.find((s) => s.url!.endsWith('/setMessageReaction'))!.body)
    expect(reaction).toEqual({ chat_id: CHAT, message_id: MESSAGE_ID, reaction: [{ type: 'emoji', emoji: '🔥' }] })

    expect(JSON.parse(jev.seen[0].body).model).toBe('jev-1.13.0')
    expect(jev.seen[0].headers.authorization).toBe('Bearer e2e-key')
    const evaluation = (await database.db.query('SELECT evaluation_id, chat_id, message_id, status, result FROM evaluations'))[0]
    expect(evaluation).toMatchObject({ evaluation_id: `msg:${CHAT}:${MESSAGE_ID}:0`, chat_id: CHAT, message_id: MESSAGE_ID, status: 'done' })
    const event = (await database.db.query('SELECT chat_id, message_id, delta, reason FROM karma_events'))[0]
    expect(event).toEqual({ chat_id: CHAT, message_id: MESSAGE_ID, delta: 0.525, reason: 'jev_usefulness' })
    expect((await database.db.query('SELECT status FROM operations WHERE operation_kind = $1', ['set_reaction']))[0].status).toBe('completed')
    expect((await database.db.query(`SELECT value FROM kv WHERE key = 'poll_offset'`))[0].value).toBe(5002)
    abort.abort()
    await running
    expect(crash).toBeNull()
    expect(readFileSync(join(env.IMPORT_DIR, 'heartbeat'), 'utf8')).toMatch(/^\d+$/)
  }, 60_000)

  it('web: healthz, and the same karma is visible through the signed API', async () => {
    const port = 20_000 + (randomBytes(2).readUInt16BE() % 20_000)
    const env = {
      DATABASE_URL: database.url,
      TELEGRAM_BOT_TOKEN: TOKEN,
      TYPESAFE_API_KEY: 'e2e-key',
      TELEGRAM_API_ROOT: telegram.url,
      IMPORT_DIR: mkdtempSync(join(tmpdir(), 'jevchik-e2e-web-')),
      BOT_USERNAME: 'jevchik_bot',
      PORT: String(port),
      PUBLIC_DIR: await buildClient(),
    }
    const web = await runWeb(readConfig(env))
    const health = await until('healthz', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null)
      return response && response.ok ? await response.json() : null
    })
    expect(health).toEqual({ status: 'ok', db: 'ok' })
    const board = await (await fetch(`http://127.0.0.1:${port}/api/leaderboard?period=all`, { headers: { authorization: `tma ${signedInitData(1, `lb_${CHAT}`)}` } })).json()
    expect(board.rows).toEqual([{ place: 1, public_id: expect.any(String), name: 'Alice', karma: 0.525, is_me: true, is_channel: false, is_bot: false }])
    const page = await fetch(`http://127.0.0.1:${port}/`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('id="app"')
    expect(await fetch(`http://127.0.0.1:${port}/api/leaderboard`, { headers: { authorization: 'tma nope' } }).then((r) => r.status)).toBe(401)
    await web.close()
  }, 60_000)

  it('the entry point refuses an unknown mode and missing configuration', async () => {
    const run = (args: string[], env: Record<string, string>) =>
      new Promise<{ code: number | null; stderr: string }>((done) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], { cwd: process.cwd(), env: { PATH: process.env.PATH ?? '', ...env } })
        let stderr = ''
        child.stderr.on('data', (c) => (stderr += c))
        child.on('exit', (code) => done({ code, stderr }))
      })
    expect((await run([], {})).code).toBe(2)
    const missing = await run(['bot'], {})
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('missing environment variable DATABASE_URL')
  })
})
