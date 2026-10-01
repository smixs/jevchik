import { mkdtempSync, mkdirSync, cpSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { createWebApp } from '../../src/web/api.js'
import { BOT_TOKEN } from './vectors.js'
import { CHAT, OTHER_CHAT, type Harness, seedMember, ALICE, BOB, CAROL } from './harness.js'

let cached: string | null = null

/** Builds the Mini App client into a temp directory once per process. */
export async function buildClient(): Promise<string> {
  if (cached) return cached
  const dir = mkdtempSync(join(tmpdir(), 'jevchik-public-'))
  mkdirSync(dir, { recursive: true })
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../../src/web/client/app.ts', import.meta.url))], bundle: true, minify: true, format: 'iife', target: 'es2020', write: false })
  writeFileSync(join(dir, 'app.js'), bundle.outputFiles[0].text)
  cpSync(fileURLToPath(new URL('../../src/web/client/index.html', import.meta.url)), join(dir, 'index.html'))
  cpSync(fileURLToPath(new URL('../../src/web/client/style.css', import.meta.url)), join(dir, 'style.css'))
  cached = dir
  return dir
}

export type Web = ReturnType<typeof createWebApp>

export async function makeWeb(h: Harness): Promise<Web> {
  return createWebApp(h.ctx, {
    botToken: BOT_TOKEN,
    publicDir: await buildClient(),
    imagesDir: fileURLToPath(new URL('../../data-static/img', import.meta.url)),
  })
}

export async function get(app: Web, path: string, initData?: string): Promise<Response> {
  return await app.request(path, { headers: initData ? { authorization: `tma ${initData}` } : {} })
}

export async function send(app: Web, method: string, path: string, initData: string, body?: unknown, raw?: BodyInit): Promise<Response> {
  return await app.request(path, {
    method,
    headers: { authorization: `tma ${initData}`, 'content-type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  })
}

const ago = (h: Harness, ms: number): Date => new Date(h.clock.now().getTime() - ms)
const HOUR = 3_600_000
const DAY = 24 * HOUR

async function event(h: Harness, chat: number, user: number, delta: number, at: Date, key: string, messageId: number | null = null): Promise<void> {
  await h.db.query(`INSERT INTO karma_events (chat_id, user_id, delta, reason, source, message_id, idempotency_key, created_at) VALUES ($1,$2,$3,'seed','seed',$4,$5,$6)`, [chat, user, delta, messageId, key, at])
}

async function message(h: Harness, chat: number, id: number, author: number, excerpt: string, at: Date, karma = 0, replies = 0): Promise<void> {
  await h.db.query(
    `INSERT INTO messages (chat_id, message_id, author_id, posted_at, excerpt, karma_sum, reply_count) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [chat, id, author, at, excerpt, karma, replies],
  )
}

/** Two chats with different fixtures, written straight to the database so the numbers are literal. */
export async function seedWorld(h: Harness): Promise<void> {
  await seedMember(h, ALICE, 12.5, CHAT)
  await seedMember(h, BOB, 7.25, CHAT)
  await seedMember(h, CAROL, 3, CHAT)
  await seedMember(h, { id: 4, first_name: 'Дмитрий', username: 'dmitry_spam' }, 0, CHAT)
  await seedMember(h, ALICE, 99, OTHER_CHAT)
  await seedMember(h, { id: 5, first_name: 'Erin' }, 40, OTHER_CHAT)
  // Who is in which chat by Telegram: the fake answers 'member' for everybody unless told otherwise.
  for (const id of [BOB.id, CAROL.id, 4, 555]) h.tg.statusIn.set(`${OTHER_CHAT}:${id}`, 'left')
  for (const id of [5, 555]) h.tg.statusIn.set(`${CHAT}:${id}`, 'left')
  await h.db.query(`UPDATE chats SET title = 'Agents chat' WHERE chat_id = $1`, [CHAT])
  await h.db.query(`UPDATE chats SET title = 'Other chat' WHERE chat_id = $1`, [OTHER_CHAT])
  await event(h, CHAT, 1, 5, ago(h, 2 * DAY), 'a1', 501)
  await event(h, CHAT, 1, 7.5, ago(h, 20 * DAY), 'a2')
  await event(h, CHAT, 2, 7.25, ago(h, 10 * DAY), 'b1')
  await event(h, CHAT, 3, 3, ago(h, HOUR), 'c1')
  await event(h, OTHER_CHAT, 1, 99, ago(h, DAY), 'o1')
  await event(h, OTHER_CHAT, 5, 40, ago(h, DAY), 'o2')
  await message(h, CHAT, 501, 1, 'Разбор: как настроить агента на Jev', ago(h, 2 * DAY), 5, 2)
  await message(h, CHAT, 502, 1, 'Ссылка на документацию', ago(h, DAY), 1, 7)
  await message(h, CHAT, 503, 1, 'Просто мнение', ago(h, HOUR), 0, 0)
  await message(h, CHAT, 601, 2, 'Сообщение Боба', ago(h, DAY), 1, 0)
  await message(h, OTHER_CHAT, 701, 1, 'Сообщение Алисы из другого чата', ago(h, DAY), 3, 1)
  await h.db.query(`INSERT INTO links (chat_id, from_message_id, to_message_id, actor_id, target_user_id, signal, awarded, factor, created_at) VALUES ($1,9001,501,2,1,'thanks',6,1,$2)`, [CHAT, h.clock.now()])
  await h.db.query(`UPDATE messages SET is_answer = true WHERE chat_id = $1 AND message_id IN (501, 502)`, [CHAT])
  await h.db.query(`INSERT INTO member_weeks (chat_id, user_id, week) VALUES ($1,1,'2026-W36'),($1,1,'2026-W35')`, [CHAT])
  await h.db.query(`UPDATE members SET last_active_at = $2 WHERE chat_id = $1 AND user_id = 1`, [CHAT, ago(h, 12 * DAY)])
  await h.db.query(
    `INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at) VALUES ($1,4,'spam_topic_pivot',0,1,2,'steam',$2,$3)`,
    [CHAT, new Date(h.clock.now().getTime() + DAY), ago(h, HOUR)],
  )
  await h.db.query(`UPDATE members SET bans_count = 1 WHERE chat_id = $1 AND user_id = 4`, [CHAT])
  await h.db.query(
    `INSERT INTO held_texts (chat_id, message_id, author_id, author_name, text, reason, expires_at, created_at) VALUES ($1,880,4,'Дмитрий','Заработай миллион на крипте',$3,$2,$4)`,
    [CHAT, new Date(h.clock.now().getTime() + DAY), 'spam', h.clock.now()],
  )
}
