import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Update } from 'grammy/types'
import pg from 'pg'
import { inject } from 'vitest'
import { createApp, type App } from '../../src/app.js'
import { changeSetting } from '../../src/settings/settings.js'
import type { Ctx } from '../../src/ctx.js'
import { Db, migrate } from '../../src/db.js'
import type { Logger } from '../../src/ports.js'
import { FakeClock, FakeJev, FakeTelegram, FakeVision, SeqRng } from './fakes.js'

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} }

export const T0 = '2026-09-01T12:00:00Z'
export const CHAT = -1001234567890
export const OTHER_CHAT = -1009876543210

export interface Harness {
  app: App
  ctx: Ctx
  db: Db
  tg: FakeTelegram
  jev: FakeJev
  vision: FakeVision
  clock: FakeClock
  importDir: string
  send(update: Update): Promise<void>
  /** Users who were in the chat before the bot came: the harness sends no join for them (section 3.6.0). */
  oldTimers: Set<number>
  close(): Promise<void>
}

export async function createDatabase(): Promise<{ db: Db; url: string; drop: () => Promise<void> }> {
  const admin = inject('pgAdminUrl')
  const name = `t_${randomUUID().replaceAll('-', '')}`
  const client = new pg.Client({ connectionString: admin })
  await client.connect()
  await client.query(`CREATE DATABASE ${name}`)
  await client.end()
  const url = admin.replace(/\/[^/]*$/, `/${name}`)
  const db = new Db(url, 8)
  await migrate(db)
  return {
    db,
    url,
    drop: async () => {
      await db.close()
      const c = new pg.Client({ connectionString: admin })
      await c.connect()
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await c.end()
    },
  }
}

export interface HarnessOptions {
  start?: string
  vision?: boolean
  rng?: number[]
  database?: { db: Db; drop: () => Promise<void> }
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { db, drop } = options.database ?? (await createDatabase())
  const clock = new FakeClock(Date.parse(options.start ?? T0))
  const tg = new FakeTelegram()
  const jev = new FakeJev()
  const vision = new FakeVision()
  const importDir = mkdtempSync(join(tmpdir(), 'jevchik-import-'))
  const ctx: Ctx = {
    db,
    tg,
    jev,
    vision: options.vision === false ? null : vision,
    clock,
    rng: new SeqRng(options.rng ?? [0]),
    log: silentLogger,
    env: { botUsername: 'jevchik_bot', botId: 777, importDir, jevModel: 'jev-1.13.0' },
  }
  const app = createApp(ctx)
  const seenAuthors = new Set<string>()
  const oldTimers = new Set<number>()
  return {
    app,
    ctx,
    db,
    tg,
    jev,
    vision,
    clock,
    importDir,
    send: async (update) => {
      const join = joinBefore(update, seenAuthors, oldTimers)
      if (join) await app.handle(join)
      await app.handle(update)
    },
    oldTimers,
    close: drop,
  }
}

/**
 * Section 3.6.0: a newcomer is somebody the bot saw joining. The authors of the tests are such people by default: before the
 * first message of an author the harness sends the membership update of their join. `oldTimers` opts a user out.
 */
function joinBefore(update: Update, seen: Set<string>, oldTimers: Set<number>): Update | null {
  const change = update.chat_member
  if (change) seen.add(`${change.chat.id}:${change.new_chat_member.user.id}`)
  const msg = update.message
  if (!msg?.from || msg.from.is_bot || msg.chat.type === 'private' || msg.sender_chat) return null
  const key = `${msg.chat.id}:${msg.from.id}`
  if (seen.has(key)) return null
  seen.add(key)
  if (oldTimers.has(msg.from.id)) return null
  return {
    update_id: joinUpdateId++,
    chat_member: {
      chat: msg.chat,
      from: msg.from,
      date: msg.date,
      old_chat_member: { status: 'left', user: msg.from },
      new_chat_member: { status: 'member', user: msg.from },
    },
  } as unknown as Update
}

let joinUpdateId = 900_000_000

let updateId = 1000
let nextMessage = 100

export function nextMessageId(): number {
  return nextMessage++
}

export interface User {
  id: number
  first_name: string
  username?: string
  is_bot?: boolean
}

export const ALICE: User = { id: 1, first_name: 'Alice', username: 'alice' }
export const BOB: User = { id: 2, first_name: 'Bob', username: 'bob' }
export const CAROL: User = { id: 3, first_name: 'Carol' }
export const ADMIN: User = { id: 99, first_name: 'Admin' }

export interface MessageOptions {
  chat?: number
  from?: User
  text?: string
  id?: number
  date?: string
  reply_to?: { message_id: number; from: User; text?: string; date?: string }
  quote?: boolean
  extra?: Record<string, unknown>
}

export function chatOf(id: number): { id: number; type: 'supergroup'; title: string; username?: string } {
  return { id, type: 'supergroup', title: `Chat ${id}` }
}

export function message(options: MessageOptions): Update {
  const id = options.id ?? nextMessage++
  const date = Math.floor(Date.parse(options.date ?? T0) / 1000)
  const msg: Record<string, unknown> = {
    message_id: id,
    date,
    chat: chatOf(options.chat ?? CHAT),
    from: options.from ?? ALICE,
    ...options.extra,
  }
  if (options.text !== undefined) msg.text = options.text
  if (options.reply_to) {
    msg.reply_to_message = {
      message_id: options.reply_to.message_id,
      date: Math.floor(Date.parse(options.reply_to.date ?? T0) / 1000) - 1,
      chat: chatOf(options.chat ?? CHAT),
      from: options.reply_to.from,
      text: options.reply_to.text ?? 'original',
    }
  }
  if (options.quote) msg.quote = { text: 'original', position: 0 }
  return { update_id: updateId++, message: msg } as unknown as Update
}

export function command(options: MessageOptions & { text: string }): Update {
  const update = message(options)
  const msg = (update as unknown as { message: Record<string, unknown> }).message
  const length = options.text.split(/\s/)[0].length
  msg.entities = [{ type: 'bot_command', offset: 0, length }]
  return update
}

export function edited(options: MessageOptions & { id: number; edit_date: string }): Update {
  const update = message(options)
  const msg = (update as unknown as { message: Record<string, unknown> }).message
  msg.edit_date = Math.floor(Date.parse(options.edit_date) / 1000)
  return { update_id: update.update_id, edited_message: msg } as unknown as Update
}

export function reaction(options: {
  chat?: number
  message_id: number
  from?: User
  actor_chat?: number
  old?: string[]
  new?: string[]
  date?: string
}): Update {
  const emoji = (list: string[] = []) => list.map((e) => ({ type: 'emoji', emoji: e }))
  return {
    update_id: updateId++,
    message_reaction: {
      chat: chatOf(options.chat ?? CHAT),
      message_id: options.message_id,
      ...(options.actor_chat !== undefined ? { actor_chat: chatOf(options.actor_chat) } : { user: options.from ?? BOB }),
      date: Math.floor(Date.parse(options.date ?? T0) / 1000),
      old_reaction: emoji(options.old),
      new_reaction: emoji(options.new),
    },
  } as unknown as Update
}

export function reactionCount(options: { chat?: number; message_id: number; counts: Record<string, number>; date?: string }): Update {
  return {
    update_id: updateId++,
    message_reaction_count: {
      chat: chatOf(options.chat ?? CHAT),
      message_id: options.message_id,
      date: Math.floor(Date.parse(options.date ?? T0) / 1000),
      reactions: Object.entries(options.counts).map(([emoji, total_count]) => ({ type: { type: 'emoji', emoji }, total_count })),
    },
  } as unknown as Update
}

export function callback(options: { data: string; from: User; id?: string }): Update {
  return {
    update_id: updateId++,
    callback_query: { id: options.id ?? `cb${updateId}`, from: options.from, chat_instance: 'x', data: options.data },
  } as unknown as Update
}

export function botJoined(chat = CHAT): Update {
  return {
    update_id: updateId++,
    my_chat_member: {
      chat: chatOf(chat),
      from: ADMIN,
      date: Math.floor(Date.parse(T0) / 1000),
      old_chat_member: { status: 'left', user: { id: 777, is_bot: true, first_name: 'Jevchik' } },
      new_chat_member: { status: 'administrator', user: { id: 777, is_bot: true, first_name: 'Jevchik' } },
    },
  } as unknown as Update
}

export async function karmaOf(h: Harness, userId: number, chat = CHAT): Promise<number> {
  const rows = await h.db.query('SELECT karma FROM members WHERE chat_id = $1 AND user_id = $2', [chat, userId])
  return rows[0]?.karma ?? 0
}

export async function eventsOf(h: Harness, userId: number, chat = CHAT): Promise<Array<{ delta: number; reason: string }>> {
  return h.db.query('SELECT delta, reason FROM karma_events WHERE chat_id = $1 AND user_id = $2 ORDER BY event_id', [chat, userId])
}

/** Puts a member past observation and gives them karma without going through the pipeline. */
export async function setKarma(h: Harness, userId: number, karma: number, chat = CHAT): Promise<void> {
  await h.db.query('UPDATE members SET karma = $3 WHERE chat_id = $1 AND user_id = $2', [chat, userId, karma])
}

export const DAY = 86_400_000
export const AFTER_OBSERVATION = '2026-09-10T12:00:00Z'

/** A new process on the same database: fresh fakes, nothing in memory. */
export async function restartHarness(old: Harness, options: HarnessOptions = {}): Promise<Harness> {
  return createHarness({ ...options, start: options.start ?? old.clock.now().toISOString(), database: { db: old.db, drop: old.close } })
}

/** The chat joined, then 8 days passed. The weekly digest is switched off so that it does not add sends to the scenario. */
export async function pastObservation(h: Harness, chat = CHAT): Promise<void> {
  await h.send(botJoined(chat))
  await changeSetting(h.db, { chatId: chat, key: 'digest_enabled', value: false, baseVersion: 0, actor: 1, now: h.clock.now() })
  h.clock.advance(8 * DAY)
}

export async function seedMember(h: Harness, user: User, karma = 0, chat = CHAT): Promise<void> {
  await h.db.query(
    `INSERT INTO chats (chat_id, title, observation_started_at, created_at) VALUES ($1,'t',$2,$2) ON CONFLICT DO NOTHING`,
    [chat, h.clock.now()],
  )
  await h.db.query(
    `INSERT INTO members (chat_id, user_id, display_name, username, karma, created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [chat, user.id, user.first_name, user.username ?? null, karma, h.clock.now()],
  )
}
