import { createHmac, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAnswers } from './support/fakes.js'
import { fakeServer, reply, type Fake } from './support/http.js'
import { CHAT, createDatabase } from './support/harness.js'

// Packaging check for the compiled output that the Docker image runs. `npm test` builds dist/ first; without it these tests fail.
const TOKEN = '123456:DIST-TOKEN-abcdef'
let database: Awaited<ReturnType<typeof createDatabase>>

beforeAll(async () => {
  database = await createDatabase()
})
afterAll(async () => {
  await database.drop()
})

function signed(userId: number, startParam: string): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: 'Alice' }), start_param: startParam }
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
  const hash = createHmac('sha256', createHmac('sha256', 'WebAppData').update(TOKEN).digest()).update(check).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}

describe('the compiled build', () => {
  it('exists', () => {
    for (const path of ['dist/main.js', 'dist/public/index.html', 'dist/migrations/001_init.sql', 'dist/migrations/002_import_attempts.sql']) expect(existsSync(path), path).toBe(true)
  })

  it('starts from dist/, applies migrations, serves the app, the pictures and the API with default settings and jokes', async () => {
    const q = database.db
    await q.query(`INSERT INTO chats (chat_id, title, observation_started_at, created_at) VALUES ($1,'Dist chat',now(),now())`, [CHAT])
    await q.query(`INSERT INTO members (chat_id, user_id, display_name, karma, created_at) VALUES ($1,1,'Alice',3,now()),($1,4,'Дмитрий',0,now())`, [CHAT])
    await q.query(`INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at) VALUES ($1,4,'spam_topic_pivot',0,0,0,'steam',now(),now())`, [CHAT])
    const port = 20_000 + (randomBytes(2).readUInt16BE() % 20_000)
    const child = spawn(process.execPath, ['dist/main.js', 'web'], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: database.url, TELEGRAM_BOT_TOKEN: TOKEN, TYPESAFE_API_KEY: 'k', BOT_USERNAME: 'jevchik_bot', PORT: String(port), IMPORT_DIR: '/tmp' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c))
    try {
      let health: unknown = null
      for (let i = 0; i < 100 && !health; i++) {
        health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => (r.ok ? r.json() : null), () => null)
        if (!health) await new Promise((r) => setTimeout(r, 150))
      }
      expect(health, stderr).toEqual({ status: 'ok', db: 'ok' })
      const headers = { authorization: `tma ${signed(1, `me_${CHAT}`)}` }
      const me = await (await fetch(`http://127.0.0.1:${port}/api/me`, { headers })).json()
      expect([me.name, me.karma]).toEqual(['Alice', 3])
      const bans = await (await fetch(`http://127.0.0.1:${port}/api/bans`, { headers })).json()
      expect(bans.bans[0].name).toBe('Д***')
      expect(bans.bans[0].explanation.length).toBeGreaterThan(5)
      expect((await fetch(`http://127.0.0.1:${port}${bans.bans[0].image}`)).status).toBe(200)
      const page = await fetch(`http://127.0.0.1:${port}/`)
      expect(await page.text()).toContain('id="app"')
      expect((await fetch(`http://127.0.0.1:${port}/app.js`)).status).toBe(200)
      expect(stderr).toBe('')
    } finally {
      child.kill('SIGTERM')
      await new Promise((done) => child.once('exit', done))
    }
  }, 40_000)

  it('starts the bot from dist/, polls, asks Jev, stores the evaluation and stops cleanly on SIGTERM', async () => {
    const jev = await fakeServer((seen, _i, res) => reply(res, 200, { answers: buildAnswers(JSON.parse(seen.body), { usefulness: { score: 2, confidence: 0.5 } }) }))
    let delivered = false
    const telegram: Fake = await fakeServer((seen, _i, res) => {
      const method = seen.url!.split('/').pop()!
      if (method === 'getMe') return reply(res, 200, { ok: true, result: { id: 777, is_bot: true, first_name: 'J', username: 'jevchik_bot' } })
      if (method === 'getUpdates') {
        if (delivered) return void setTimeout(() => reply(res, 200, { ok: true, result: [] }), 300)
        delivered = true
        const message = { message_id: 77, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: 'supergroup', title: 'Dist bot chat' }, from: { id: 1, first_name: 'Alice' }, text: 'сообщение для сборки' }
        return reply(res, 200, { ok: true, result: [{ update_id: 9001, message }] })
      }
      reply(res, 200, { ok: true, result: method === 'getChat' ? { id: 1, type: 'private', first_name: 'Alice' } : true })
    })
    const child = spawn(process.execPath, ['dist/main.js', 'bot'], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '', DATABASE_URL: database.url, TELEGRAM_BOT_TOKEN: TOKEN, TYPESAFE_API_KEY: 'k', BOT_USERNAME: 'jevchik_bot', TELEGRAM_API_ROOT: telegram.url, JEV_API_URL: `${jev.url}/v1/systemone`, IMPORT_DIR: '/tmp' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (c) => (stderr += c))
    try {
      let row: { status?: string } | undefined
      for (let i = 0; i < 200 && row?.status !== 'done'; i++) {
        row = (await database.db.query('SELECT status FROM evaluations WHERE chat_id = $1 AND message_id = 77', [CHAT]).catch(() => []))[0]
        if (row?.status !== 'done') await new Promise((r) => setTimeout(r, 150))
      }
      expect(row?.status, stderr).toBe('done')
      expect((await database.db.query(`SELECT value FROM kv WHERE key = 'poll_offset'`))[0].value).toBe(9002)
    } finally {
      child.kill('SIGTERM')
    }
    const code = await new Promise((done) => child.once('exit', done))
    await telegram.close()
    await jev.close()
    expect(code).toBe(0)
  }, 60_000)
})
