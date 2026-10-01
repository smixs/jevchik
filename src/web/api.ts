import { Hono, type Context } from 'hono'
import { appealState, submitAppeal } from '../appeal.js'
import { renderCard, type CardRow } from '../card-text.js'
import type { Ctx } from '../ctx.js'
import { startImport } from '../import.js'
import { observationEnd } from '../members.js'
import { changeSetting, getSettings, getSettingsWithVersions, listAudit, SCHEMA, SettingsError } from '../settings/settings.js'
import { parseContext, verifyInitData, type Screen } from './auth.js'
import { banList, EMPTY_PAGE, leaderboard, memberPage, parsePeriod } from './queries.js'
import { readStatic } from './static.js'
import { IMPORT_MAX_BYTES } from '../import.js'
import { TelegramError } from '../ports.js'

export interface WebOptions {
  botToken: string
  publicDir: string
  imagesDir: string
}

interface Auth {
  userId: number
  name: string
  chatId: number
  screen: Screen
}

interface Viewer {
  userId: number
  name: string
}

type Env = { Variables: { auth: Auth; viewer: Viewer } }

function isDbDown(error: unknown): boolean {
  const e = error as { code?: string; message?: string }
  return Boolean(e?.code && (e.code.startsWith('08') || e.code.startsWith('57') || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT')) || /Connection terminated|timeout exceeded|ECONNREFUSED/i.test(e?.message ?? '')
}

async function readBody(c: Context, limit: number): Promise<Buffer | null> {
  const declared = Number(c.req.header('content-length'))
  if (Number.isFinite(declared) && declared > limit) return null
  const reader = c.req.raw.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

type Api = Hono<Env>

type Resolved = { chatId: number; screen: Screen } | { error: 'no_context' | 'bad_context' | 'unknown_chat' | 'not_member'; status: 400 | 403 | 404 }

async function chatKnown(ctx: Ctx, chatId: number): Promise<boolean> {
  return (await ctx.db.query('SELECT 1 FROM chats WHERE chat_id = $1', [chatId])).length > 0
}

/** A chat named by the client is taken only for a member of it, checked in the database on every request. */
const IN_CHAT = ['creator', 'administrator', 'member', 'restricted']
const CHATS_ASKED = 20

/** Somebody who never wrote since the bot came (an owner posting as the channel, a reader) is not in members: Telegram is asked. */
async function inChatByTelegram(ctx: Ctx, chatId: number, userId: number): Promise<boolean> {
  try {
    return IN_CHAT.includes((await ctx.tg.getChatMember(chatId, userId)).status)
  } catch {
    return false
  }
}

async function chatsOf(ctx: Ctx, userId: number): Promise<Array<{ chat_id: number; title: string }>> {
  const rows = await ctx.db.query(
    `SELECT c.chat_id, c.title, EXISTS (SELECT 1 FROM members m WHERE m.chat_id = c.chat_id AND m.user_id = $1) AS known
     FROM chats c ORDER BY c.title, c.chat_id LIMIT $2`,
    [userId, CHATS_ASKED],
  )
  const mine: Array<{ chat_id: number; title: string }> = []
  for (const r of rows) {
    if (r.known || (await inChatByTelegram(ctx, Number(r.chat_id), userId))) mine.push({ chat_id: Number(r.chat_id), title: r.title })
  }
  return mine
}

async function namedChat(ctx: Ctx, named: string, userId: number): Promise<Resolved> {
  const chatId = Number(named)
  if (!Number.isSafeInteger(chatId) || !(await chatKnown(ctx, chatId))) return { error: 'not_member', status: 403 }
  const rows = await ctx.db.query('SELECT 1 FROM members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  if (rows.length > 0 || (await inChatByTelegram(ctx, chatId, userId))) return { chatId, screen: 'lb' }
  return { error: 'not_member', status: 403 }
}

/**
 * Section 3.8: a signed start_param is the source of truth; a malformed one or one of a chat the bot does not know is refused.
 * Only without it (the "Open App" button of the bot profile) the client names the chat it chose from GET /api/chats.
 */
async function resolveContext(ctx: Ctx, from: { startParam: string | null; named: string | undefined; userId: number }): Promise<Resolved> {
  if (!from.startParam) return from.named !== undefined ? namedChat(ctx, from.named, from.userId) : { error: 'no_context', status: 400 }
  const context = parseContext(from.startParam)
  if (!context) return { error: 'bad_context', status: 400 }
  return (await chatKnown(ctx, context.chatId)) ? context : { error: 'unknown_chat', status: 404 }
}

function settingsFailure(c: Context, error: unknown): Response {
  if (!(error instanceof SettingsError)) throw error
  return c.json({ error: error.code, field: error.field, message: error.message }, error.code === 'conflict' ? 409 : 422)
}

function mountBase(app: Api, ctx: Ctx, options: WebOptions): void {
  app.onError((error, c) => {
    if (isDbDown(error)) return c.json({ error: 'db_down' }, 503)
    ctx.log.error('api_error', { path: c.req.path, error: String(error) })
    return c.json({ error: 'internal' }, 500)
  })

  app.get('/healthz', async (c) => {
    try {
      await ctx.db.query('SELECT 1')
      return c.json({ status: 'ok', db: 'ok' })
    } catch {
      return c.json({ status: 'error', db: 'down' }, 503)
    }
  })

  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const raw = header.startsWith('tma ') ? header.slice(4) : null
    const result = verifyInitData(raw, options.botToken, ctx.clock.now())
    if (!result.ok) return c.json({ error: 'unauthorized', reason: result.reason }, 401)
    const viewer = { userId: result.user.id, name: [result.user.first_name, result.user.last_name].filter(Boolean).join(' ') }
    c.set('viewer', viewer)
    if (c.req.path === '/api/chats') return next()
    const context = await resolveContext(ctx, { startParam: result.startParam, named: c.req.header('x-chat-id'), userId: viewer.userId })
    if ('error' in context) return c.json({ error: context.error }, context.status)
    c.set('auth', { ...viewer, chatId: context.chatId, screen: context.screen })
    await next()
  })

  app.use('/api/admin/*', async (c, next) => {
    const auth = c.get('auth')
    try {
      const member = await ctx.tg.getChatMember(auth.chatId, auth.userId)
      if (member.status !== 'creator' && member.status !== 'administrator') return c.json({ error: 'forbidden' }, 403)
    } catch (error) {
      if (error instanceof TelegramError && error.kind === 'client') return c.json({ error: 'forbidden' }, 403)
      return c.json({ error: 'try_later' }, 503)
    }
    await next()
  })
}

/** The tabs a viewer gets: the admin tab needs a fresh role, any failure of the check hides it. */
async function viewerIsAdmin(ctx: Ctx, auth: { chatId: number; userId: number }): Promise<boolean> {
  try {
    const member = await ctx.tg.getChatMember(auth.chatId, auth.userId)
    return member.status === 'creator' || member.status === 'administrator'
  } catch {
    return false
  }
}

async function viewerHasBan(ctx: Ctx, auth: { chatId: number; userId: number }): Promise<boolean> {
  const rows = await ctx.db.query('SELECT 1 FROM bans WHERE chat_id = $1 AND user_id = $2', [auth.chatId, auth.userId])
  return rows.length > 0
}

function mountPublic(app: Api, ctx: Ctx): void {
  /** The chats where the viewer is a member; only the signature of initData is needed (section 3.8). */
  app.get('/api/chats', async (c) => {
    return c.json({ chats: await chatsOf(ctx, c.get('viewer').userId) })
  })

  app.get('/api/context', async (c) => {
    const auth = c.get('auth')
    const chat = (await ctx.db.query('SELECT title FROM chats WHERE chat_id = $1', [auth.chatId]))[0]
    const me = (await ctx.db.query('SELECT public_id FROM members WHERE chat_id = $1 AND user_id = $2', [auth.chatId, auth.userId]))[0]
    const viewer = { public_id: me?.public_id ?? null, name: auth.name, is_admin: await viewerIsAdmin(ctx, auth), has_ban: await viewerHasBan(ctx, auth) }
    return c.json({ screen: auth.screen, chat: { title: chat.title }, viewer })
  })

  app.get('/api/leaderboard', async (c) => {
    const auth = c.get('auth')
    return c.json(await leaderboard(ctx, auth.chatId, parsePeriod(c.req.query('period')), auth.userId))
  })

  app.get('/api/me', async (c) => {
    const auth = c.get('auth')
    const rows = await ctx.db.query('SELECT * FROM members WHERE chat_id = $1 AND user_id = $2', [auth.chatId, auth.userId])
    return c.json(rows[0] ? await memberPage(ctx, auth.chatId, rows[0], auth.userId) : { ...EMPTY_PAGE, name: auth.name })
  })

  app.get('/api/members/:publicId', async (c) => {
    const auth = c.get('auth')
    const id = c.req.param('publicId')
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: 'not_found' }, 404)
    const rows = await ctx.db.query('SELECT * FROM members WHERE chat_id = $1 AND public_id = $2', [auth.chatId, id])
    if (!rows[0]) return c.json({ error: 'not_found' }, 404)
    if (rows[0].hidden && rows[0].user_id !== auth.userId) return c.json({ error: 'page_hidden' }, 404)
    return c.json(await memberPage(ctx, auth.chatId, rows[0], auth.userId))
  })

  app.post('/api/me/hide', async (c) => {
    const auth = c.get('auth')
    const body = (await c.req.json().catch(() => null)) as { hidden?: unknown } | null
    if (typeof body?.hidden !== 'boolean') return c.json({ error: 'invalid' }, 422)
    const rows = await ctx.db.query('UPDATE members SET hidden = $3 WHERE chat_id = $1 AND user_id = $2 RETURNING hidden', [auth.chatId, auth.userId, body.hidden])
    return rows[0] ? c.json({ hidden: rows[0].hidden }) : c.json({ error: 'not_found' }, 404)
  })

  app.get('/api/bans', async (c) => c.json({ bans: await banList(ctx, c.get('auth').chatId) }))

  app.get('/api/appeal', async (c) => {
    const auth = c.get('auth')
    return c.json(await appealState(ctx, auth.chatId, auth.userId))
  })

  app.post('/api/appeal', async (c) => {
    const auth = c.get('auth')
    const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
    const text = typeof body?.text === 'string' ? body.text : ''
    const result = await submitAppeal(ctx, auth.chatId, auth.userId, text)
    return c.json(result, result.status === 'invalid' ? 422 : 200)
  })
}

/**
 * Open, undelivered and decided cards with the same text and link the admins got in Telegram (sections 3.6.1, 3.6.2), and what
 * observation mode kept from being applied (section 3.6.3).
 */
async function adminCards(ctx: Ctx, chatId: number): Promise<unknown[]> {
  const rows = await ctx.db.query<Omit<CardRow, 'chat_id'>>(
    `SELECT card_id, kind, status, delivery, payload, decision, created_at FROM admin_cards
     WHERE chat_id = $1 AND (status = 'open' OR delivery IN ('undelivered', 'screen') OR decision IS NOT NULL) ORDER BY card_id DESC LIMIT 50`,
    [chatId],
  )
  const now = ctx.clock.now()
  const cards = []
  for (const row of rows) cards.push({ ...row, ...(await renderCard(ctx.db, { ...row, chat_id: chatId }, now)) })
  return cards
}

function mountAdmin(app: Api, ctx: Ctx): void {
  app.get('/api/admin/whoami', (c) => c.json({ admin: true }))

  app.get('/api/admin/settings', async (c) => {
    const { values, versions } = await getSettingsWithVersions(ctx.db, c.get('auth').chatId)
    return c.json({ values, versions, schema: SCHEMA })
  })

  app.put('/api/admin/settings/:key', async (c) => {
    const auth = c.get('auth')
    const body = (await c.req.json().catch(() => null)) as { value?: unknown; base_version?: unknown } | null
    if (!body || !('value' in body) || typeof body.base_version !== 'number') return c.json({ error: 'invalid', field: c.req.param('key') }, 422)
    try {
      const result = await changeSetting(ctx.db, { chatId: auth.chatId, key: c.req.param('key'), value: body.value, baseVersion: body.base_version, actor: auth.userId, now: ctx.clock.now() })
      return c.json(result)
    } catch (error) {
      return settingsFailure(c, error)
    }
  })

  app.get('/api/admin/audit', async (c) => c.json({ audit: await listAudit(ctx.db, c.get('auth').chatId) }))

  app.get('/api/admin/observation', async (c) => {
    const auth = c.get('auth')
    const settings = await getSettings(ctx.db, auth.chatId)
    const end = await observationEnd(ctx.db, auth.chatId, settings)
    return c.json({ ends_at: end?.toISOString() ?? null, active: end !== null && ctx.clock.now() < end })
  })

  app.post('/api/admin/observation', async (c) => {
    const auth = c.get('auth')
    const body = (await c.req.json().catch(() => null)) as { until?: unknown } | null
    const until = typeof body?.until === 'string' ? Date.parse(body.until) : NaN
    if (Number.isNaN(until)) return c.json({ error: 'invalid', field: 'until' }, 422)
    const { versions } = await getSettingsWithVersions(ctx.db, auth.chatId)
    const current = await observationEnd(ctx.db, auth.chatId, await getSettings(ctx.db, auth.chatId))
    if (current && until <= current.getTime()) return c.json({ error: 'invalid', field: 'until', message: 'can only extend' }, 422)
    try {
      const result = await changeSetting(ctx.db, { chatId: auth.chatId, key: 'observation_until', value: new Date(until).toISOString(), baseVersion: versions.observation_until, actor: auth.userId, now: ctx.clock.now() })
      return c.json(result)
    } catch (error) {
      return settingsFailure(c, error)
    }
  })

  app.post('/api/admin/import', async (c) => {
    const auth = c.get('auth')
    const body = await readBody(c, IMPORT_MAX_BYTES)
    if (!body) return c.json({ error: 'too_large' }, 413)
    const result = await startImport(ctx, auth.chatId, auth.userId, body)
    if (result.ok) return c.json({ job_id: result.jobId })
    const status = { too_large: 413, not_json: 400, wrong_chat: 422, empty: 422, busy: 409 }[result.error]
    return c.json({ error: result.error }, status as 400)
  })

  app.get('/api/admin/import', async (c) => {
    const rows = await ctx.db.query('SELECT status, cursor_index, total, error, created_at FROM import_jobs WHERE chat_id = $1 ORDER BY job_id DESC LIMIT 1', [c.get('auth').chatId])
    return c.json({ job: rows[0] ? { status: rows[0].status, processed: rows[0].cursor_index, total: rows[0].total, error: rows[0].error } : null })
  })

  app.get('/api/admin/operations', async (c) => {
    const rows = await ctx.db.query(
      `SELECT operation_id, operation_kind, status, attempt_count, next_attempt_at, last_error_code, last_error_at FROM operations
       WHERE chat_id = $1 AND status <> 'completed' ORDER BY operation_id DESC LIMIT 50`,
      [c.get('auth').chatId],
    )
    return c.json({ operations: rows })
  })

  app.get('/api/admin/held', async (c) => {
    const rows = await ctx.db.query(
      `SELECT message_id, author_name, text, reason, expires_at FROM held_texts WHERE chat_id = $1 AND expires_at > $2 AND reason <> 'card' ORDER BY created_at DESC LIMIT 50`,
      [c.get('auth').chatId, ctx.clock.now()],
    )
    return c.json({ held: rows })
  })

  app.get('/api/admin/cards', async (c) => c.json({ cards: await adminCards(ctx, c.get('auth').chatId) }))
}

function mountStatic(app: Api, options: WebOptions): void {
  app.get('/ban-images/:name', async (c) => {
    const file = await readStatic(options.imagesDir, c.req.param('name'))
    return file ? c.body(new Uint8Array(file.body), 200, { 'content-type': file.type, 'cache-control': 'public, max-age=86400' }) : c.notFound()
  })

  app.get('*', async (c) => {
    const path = c.req.path === '/' ? '/index.html' : c.req.path
    const file = await readStatic(options.publicDir, path)
    if (!file) return c.notFound()
    return c.body(new Uint8Array(file.body), 200, { 'content-type': file.type, 'cache-control': path === '/index.html' ? 'no-cache' : 'public, max-age=3600' })
  })
}

export function createWebApp(ctx: Ctx, options: WebOptions): Hono<Env> {
  const app = new Hono<Env>()
  mountBase(app, ctx, options)
  mountPublic(app, ctx)
  mountAdmin(app, ctx)
  mountStatic(app, options)
  return app
}
