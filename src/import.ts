import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from './ctx.js'
import { DAY_MS } from './ctx.js'
import type { Q, Row } from './db.js'
import { messageFactor, round4 } from './formulas.js'
import { boostFor, award } from './karma.js'
import { historyText } from './jev/history.js'
import { fitRequest, selectQuestions, type JevState } from './jev/state.js'
import type { Answers } from './jev/facts.js'
import { upsertMember } from './members.js'
import { applyEvaluation, type EvalMeta } from './pipeline.js'
import { JevError } from './ports.js'
import { classify } from './reactions.js'
import { getSettings, type SettingsView } from './settings/settings.js'
import { contentHash, makeExcerpt, truncateGraphemes } from './text.js'
import { evaluationId } from './evaluation.js'
import { placeTagsAfterImport } from './tags.js'

export const IMPORT_MAX_BYTES = 50 * 1024 * 1024
const BATCH = 8

export interface ImportMessage {
  id: number
  authorId: number
  author: string
  postedAt: Date
  text: string
  replyTo: number | null
  reactions: Array<{ key: string; count: number }>
  /** A photo, file, sticker or other attachment: the export has no file_unique_id, so no content hash is stored. */
  media: boolean
}

export type ImportError = 'too_large' | 'not_json' | 'wrong_chat' | 'empty' | 'busy'

const SUPERGROUP_BASE = 1_000_000_000_000

/** Supergroups (-100…) match their own id or the id without the prefix; ordinary groups their id or its modulus. */
export function exportIdMatches(chatId: number, exportId: number): boolean {
  if (chatId < -SUPERGROUP_BASE) return exportId === chatId || exportId === -chatId - SUPERGROUP_BASE
  return exportId === chatId || exportId === -chatId
}

function plainText(text: unknown): string {
  if (typeof text === 'string') return text
  if (!Array.isArray(text)) return ''
  return text.map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '')).join('')
}

function oneReaction(raw: Row): { key: string; count: number } | null {
  const count = Number(raw?.count)
  if (!Number.isFinite(count) || count <= 0) return null
  if (typeof raw.emoji === 'string') return { key: `emoji:${raw.emoji}`, count }
  return raw?.type === 'paid' ? { key: 'paid', count } : null
}

function reactionsOf(raw: unknown): Array<{ key: string; count: number }> {
  if (!Array.isArray(raw)) return []
  return raw.map(oneReaction).filter((r): r is { key: string; count: number } => r !== null)
}

function hasMedia(raw: Row): boolean {
  return ['photo', 'file', 'media_type'].some((key) => raw[key] !== undefined)
}

function toMessage(raw: Row): ImportMessage | null {
  if (raw.type !== 'message' || typeof raw.from_id !== 'string' || !raw.from_id.startsWith('user')) return null
  const seconds = Number(raw.date_unixtime)
  const authorId = Number(raw.from_id.slice(4))
  if (!Number.isFinite(seconds) || !Number.isFinite(authorId)) return null
  return {
    id: Number(raw.id),
    authorId,
    author: typeof raw.from === 'string' && raw.from ? raw.from : String(authorId),
    postedAt: new Date(seconds * 1000),
    text: plainText(raw.text),
    replyTo: raw.reply_to_message_id ? Number(raw.reply_to_message_id) : null,
    reactions: reactionsOf(raw.reactions),
    media: hasMedia(raw),
  }
}

export function parseExport(content: string): { id: number; messages: ImportMessage[] } | null {
  let data: Row
  try {
    data = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || typeof data.id !== 'number' || !Array.isArray(data.messages)) return null
  const messages = (data.messages as Row[]).map(toMessage).filter((m): m is ImportMessage => m !== null)
  return { id: data.id, messages }
}

export function windowOf(messages: ImportMessage[], now: Date, days: number): ImportMessage[] {
  const from = now.getTime() - days * DAY_MS
  return messages.filter((m) => m.postedAt.getTime() >= from && m.postedAt.getTime() <= now.getTime()).sort((a, b) => a.id - b.id)
}

/** Validates the upload and stores the file until the job finishes. Nothing stays on disk after a rejection. */
export async function startImport(ctx: Ctx, chatId: number, actorId: number, body: Buffer): Promise<{ ok: true; jobId: number } | { ok: false; error: ImportError }> {
  if (body.length > IMPORT_MAX_BYTES) return { ok: false, error: 'too_large' }
  const parsed = parseExport(body.toString('utf8'))
  if (!parsed) return { ok: false, error: 'not_json' }
  if (!exportIdMatches(chatId, parsed.id)) return { ok: false, error: 'wrong_chat' }
  const now = ctx.clock.now()
  const days = (await getSettings(ctx.db, chatId)).num('import_days')
  if (windowOf(parsed.messages, now, days).length === 0) return { ok: false, error: 'empty' }
  const path = join(ctx.env.importDir, `import-${chatId}-${now.getTime()}-${randomUUID()}.json`)
  await writeFile(path, body)
  try {
    const rows = await ctx.db.query(
      `INSERT INTO import_jobs (chat_id, status, file_path, created_by, created_at) VALUES ($1,'pending',$2,$3,$4) RETURNING job_id`,
      [chatId, path, actorId, now],
    )
    return { ok: true, jobId: rows[0].job_id }
  } catch (error) {
    await removeFile(path)
    if ((error as { code?: string }).code === '23505') return { ok: false, error: 'busy' }
    throw error
  }
}

/** True when the file is gone (deleted now or already absent). */
export async function removeFile(path: string): Promise<boolean> {
  try {
    await unlink(path)
    return true
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT'
  }
}

async function finishJob(ctx: Ctx, job: Row, status: string, error?: string): Promise<void> {
  const gone = job.file_path ? await removeFile(job.file_path) : true
  await ctx.db.query(`UPDATE import_jobs SET status = $2, error = $3, finished_at = $4, file_path = CASE WHEN $5 THEN NULL ELSE file_path END WHERE job_id = $1`, [
    job.job_id,
    status,
    error ?? null,
    ctx.clock.now(),
    gone,
  ])
}

/** Messages of each author: the sorted import and the rows already in the chat that the file does not repeat. */
type Authored = Map<number, Array<{ id: number; at: number }>>

async function authoredIndex(ctx: Ctx, chatId: number, all: ImportMessage[]): Promise<Authored> {
  const rows = await ctx.db.query(
    'SELECT author_id, message_id, posted_at FROM messages WHERE chat_id = $1 AND author_id = ANY($2) AND NOT (message_id = ANY($3))',
    [chatId, [...new Set(all.map((m) => m.authorId))], all.map((m) => m.id)],
  )
  const index: Authored = new Map()
  const add = (author: number, id: number, at: number): void => void index.set(author, [...(index.get(author) ?? []), { id, at }])
  for (const r of rows) add(r.author_id, r.message_id, new Date(r.posted_at).getTime())
  for (const m of all) add(m.authorId, m.id, m.postedAt.getTime())
  return index
}

/** Section 3.6.0 for an imported message: the author's messages before it, from the file and from the chat. */
function importHistory(authored: Authored, m: ImportMessage): string {
  const earlier = (authored.get(m.authorId) ?? []).filter((x) => x.id < m.id)
  const first = earlier.length > 0 ? new Date(Math.min(...earlier.map((x) => x.at))) : null
  return historyText(earlier.length, first, m.postedAt)
}

interface Context {
  all: ImportMessage[]
  byId: Map<number, ImportMessage>
  authored: Authored
  count: number
}

function stateFor(c: Context, index: number): JevState {
  const m = c.all[index]
  const line = (x: ImportMessage): string => `${x.author}: ${truncateGraphemes(x.text, 200)}`
  const parent = m.replyTo !== null ? c.byId.get(m.replyTo) : undefined
  return {
    message: m.text,
    replied_to: parent ? line(parent) : null,
    previous_messages: c.all.slice(Math.max(0, index - c.count), index).filter((x) => x.text).map(line),
    sender_history: importHistory(c.authored, m),
    media_description: null,
    sender_profile: null,
  }
}

interface Env {
  ctx: Ctx
  settings: SettingsView
  chatId: number
}

async function countUnits(q: Q, env: Env, unit: { m: ImportMessage; author: number; signals: number }): Promise<{ signals: number }> {
  const { ctx, settings, chatId } = env
  const { m, author } = unit
  const now = ctx.clock.now()
  let count = unit.signals
  for (const r of m.reactions) {
    const snap = await q.query('SELECT count FROM reaction_counts WHERE chat_id = $1 AND message_id = $2 AND reaction_type = $3 FOR UPDATE', [chatId, m.id, r.key])
    const known = snap[0]?.count ?? 0
    if (r.count <= known) continue
    let effective = 0
    if (classify(settings, r.key) === 'plus') {
      let total = 0
      for (let i = 0; i < r.count - known; i++) total += settings.num('base_reaction') * messageFactor(count + 1 + i)
      total *= await boostFor(q, settings, { chatId, userId: author }, m.postedAt)
      count += r.count - known
      const key = `import-count:${m.id}:${r.key}:${r.count}`
      effective = (await award(q, { chatId, userId: author, delta: total, reason: 'reaction_plus', source: 'import', messageId: m.id, key, now: m.postedAt, settings, positiveOnly: true })).delta
    }
    await q.query(
      `INSERT INTO reaction_counts (chat_id, message_id, reaction_type, count, awarded, last_date) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (chat_id, message_id, reaction_type) DO UPDATE SET count = $4, awarded = reaction_counts.awarded + $5, last_date = $6`,
      [chatId, m.id, r.key, r.count, round4(effective), now],
    )
  }
  return { signals: count }
}

async function countReactions(q: Q, env: Env, m: ImportMessage): Promise<void> {
  const msg = await q.query('SELECT author_id, signal_count FROM messages WHERE chat_id = $1 AND message_id = $2 FOR UPDATE', [env.chatId, m.id])
  const { signals } = await countUnits(q, env, { m, author: msg[0].author_id, signals: msg[0].signal_count })
  await q.query('UPDATE messages SET signal_count = $3 WHERE chat_id = $1 AND message_id = $2', [env.chatId, m.id, signals])
}

/** Length of the run of consecutive messages by the same author, counted from the export order (stateless, so resuming keeps it). */
function runLengthAt(all: ImportMessage[], index: number): number {
  let k = 1
  while (index - k >= 0 && all[index - k].authorId === all[index].authorId) k++
  return k
}

/** The hash a live message with the same content gets (section 3.6); unknown for an attachment, so its first edit only stores one. */
function importHash(m: ImportMessage): Buffer | null {
  return m.media ? null : contentHash({ text: m.text, caption: '', attachment: null })
}

async function storeMessage(q: Q, env: Env, m: ImportMessage, runK: number): Promise<boolean> {
  const { ctx, settings, chatId } = env
  const now = ctx.clock.now()
  await upsertMember(q, chatId, { id: m.authorId, first_name: m.author }, now)
  const fresh = now.getTime() - m.postedAt.getTime() < settings.num('excerpt_days') * DAY_MS
  const parentRow = m.replyTo !== null ? await q.query('SELECT author_id FROM messages WHERE chat_id = $1 AND message_id = $2', [chatId, m.replyTo]) : []
  const inserted = await q.query(
    `INSERT INTO messages (chat_id, message_id, author_id, posted_at, reply_to_message_id, reply_to_author_id, run_k, excerpt, content_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (chat_id, message_id) DO NOTHING RETURNING message_id`,
    [chatId, m.id, m.authorId, m.postedAt, parentRow[0] ? m.replyTo : null, parentRow[0]?.author_id ?? null, runK, fresh && m.text ? makeExcerpt(m.text) : null, importHash(m)],
  )
  return inserted.length > 0
}

async function askJev(ctx: Ctx, settings: SettingsView, state: JevState): Promise<Answers | null> {
  const fitted = fitRequest(state, selectQuestions(settings.questions(), { hasProfile: false, hasMedia: false, hasReply: state.replied_to !== null }))
  if (!fitted) return null
  return (await ctx.jev.evaluate(fitted.request)).answers as Answers
}

interface Item {
  message: ImportMessage
  runK: number
  answers: Answers | null
}

function importMeta(m: ImportMessage): EvalMeta {
  return { authorId: m.authorId, authorName: m.author, postedAt: m.postedAt.toISOString(), gen: 0, isEdit: false, mediaKind: null, mediaOnly: false, hasLinks: false, probation: false, fetchBio: false, mode: 'import' }
}

async function processOne(env: Env, item: Item): Promise<void> {
  const { ctx, chatId } = env
  const m = item.message
  await ctx.db.tx(async (q) => {
    const id = evaluationId(chatId, m.id, 0)
    const seen = await q.query('SELECT 1 FROM evaluations WHERE evaluation_id = $1', [id])
    const created = await storeMessage(q, env, m, item.runK)
    if (seen.length > 0) return
    await q.query(
      `INSERT INTO evaluations (evaluation_id, chat_id, message_id, kind, status, next_attempt_at, created_at, result)
       VALUES ($1,$2,$3,'import','done',$4,$4,$5) ON CONFLICT DO NOTHING`,
      [id, chatId, m.id, ctx.clock.now(), item.answers ? JSON.stringify(item.answers) : null],
    )
    if (!created) return
    await applyEvaluation(ctx, q, { chatId, messageId: m.id, startedAt: ctx.clock.now(), settingsSeq: null, meta: importMeta(m), text: m.text, answers: item.answers, mediaDescribed: false })
    await countReactions(q, env, m)
  })
}

type Asked = { answers: Answers | null } | { error: unknown } | { skip: true }

async function evaluatedIds(ctx: Ctx, chatId: number, slice: ImportMessage[]): Promise<Set<number>> {
  const rows = await ctx.db.query('SELECT message_id FROM evaluations WHERE chat_id = $1 AND evaluation_id = ANY($2)', [
    chatId,
    slice.map((m) => evaluationId(chatId, m.id, 0)),
  ])
  return new Set(rows.map((r) => r.message_id as number))
}

async function askAll(env: Env, work: Work, from: number): Promise<Asked[]> {
  const { ctx, settings } = env
  const { all } = work
  const context: Context = { all, byId: new Map(all.map((m) => [m.id, m])), authored: work.authored, count: settings.num('previous_messages_count') }
  const slice = all.slice(from, from + BATCH)
  const done = await evaluatedIds(ctx, env.chatId, slice)
  return Promise.all(
    slice.map(async (m, i): Promise<Asked> => {
      if (done.has(m.id)) return { skip: true }
      if (!m.text) return { answers: null }
      try {
        return { answers: await askJev(ctx, settings, stateFor(context, from + i)) }
      } catch (error) {
        return { error }
      }
    }),
  )
}

function isOutage(error: unknown): error is JevError {
  if (!(error instanceof JevError)) throw error
  return error.kind === 'transient' || error.kind === 'rate_limit'
}

interface Work {
  job: Row
  all: ImportMessage[]
  authored: Authored
}

const MAX_MESSAGE_ATTEMPTS = 3

/** A failed message is asked again later, at most three times in total, then it is "not processed". Returns the next cursor or null to stop. */
async function handleOutage(env: Env, work: Work, failed: { index: number; error: JevError }): Promise<number | null> {
  const { ctx } = env
  const rows = await ctx.db.query('UPDATE import_jobs SET attempts = attempts + 1 WHERE job_id = $1 RETURNING attempts', [work.job.job_id])
  if (rows[0].attempts >= MAX_MESSAGE_ATTEMPTS) {
    const m = work.all[failed.index]
    await ctx.db.query(
      `INSERT INTO evaluations (evaluation_id, chat_id, message_id, kind, status, next_attempt_at, created_at, last_error)
       VALUES ($1,$2,$3,'import','unprocessed',$4,$4,$5) ON CONFLICT DO NOTHING`,
      [evaluationId(env.chatId, m.id, 0), env.chatId, m.id, ctx.clock.now(), failed.error.message],
    )
    await ctx.db.query('UPDATE import_jobs SET attempts = 0, cursor_index = $2 WHERE job_id = $1', [work.job.job_id, failed.index + 1])
    return failed.index + 1
  }
  const wait = (failed.error.retryAfter ?? 30) * 1000
  await ctx.db.query(`UPDATE import_jobs SET status = 'pending', retry_at = $2, cursor_index = $3 WHERE job_id = $1`, [
    work.job.job_id,
    new Date(ctx.clock.now().getTime() + wait),
    failed.index,
  ])
  return null
}

async function processBatch(env: Env, work: Work, cursor: number): Promise<number | null> {
  const asked = await askAll(env, work, cursor)
  let failed: { index: number; error: JevError } | null = null
  for (let i = 0; i < asked.length; i++) {
    const outcome = asked[i]
    if ('error' in outcome && isOutage(outcome.error)) {
      failed ??= { index: cursor + i, error: outcome.error as JevError }
      continue
    }
    await processOne(env, { message: work.all[cursor + i], runK: runLengthAt(work.all, cursor + i), answers: 'answers' in outcome ? outcome.answers : null })
  }
  if (failed) return handleOutage(env, work, failed)
  const next = Math.min(work.all.length, cursor + BATCH)
  await env.ctx.db.query('UPDATE import_jobs SET cursor_index = $2, attempts = 0 WHERE job_id = $1', [work.job.job_id, next])
  return next
}

async function runJob(ctx: Ctx, job: Row): Promise<void> {
  const chatId = job.chat_id as number
  const parsed = parseExport(await readFile(job.file_path, 'utf8'))
  if (!parsed) return finishJob(ctx, job, 'failed', 'unreadable')
  const all = windowOf(parsed.messages, new Date(job.created_at), (await getSettings(ctx.db, chatId)).num('import_days'))
  await ctx.db.query('UPDATE import_jobs SET total = $2 WHERE job_id = $1', [job.job_id, all.length])
  if ((await ctx.db.query('SELECT 1 FROM chats WHERE chat_id = $1', [chatId])).length === 0) return finishJob(ctx, job, 'failed', 'unknown_chat')
  const env: Env = { ctx, settings: await getSettings(ctx.db, chatId), chatId }
  const work: Work = { job, all, authored: await authoredIndex(ctx, chatId, all) }
  let cursor: number | null = job.cursor_index as number
  while (cursor !== null && cursor < all.length) cursor = await processBatch(env, work, cursor)
  if (cursor === null) return
  await finishJob(ctx, job, 'done')
  // The import is done whatever happens to the tags; the first-placement pass catches up a failed placement.
  await placeTagsAfterImport(ctx, chatId, job.job_id).catch((error) =>
    ctx.log.error('tag_placement_failed', { chat_id: chatId, job_id: job.job_id, error: String(error).slice(0, 200) }),
  )
}

/** Continues the active import of every chat; a job survives restarts because its state is the file and the cursor. */
export async function runImports(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now()
  const jobs = await ctx.db.query(
    `UPDATE import_jobs SET status = 'running' WHERE job_id IN (
       SELECT job_id FROM import_jobs WHERE status = 'pending' AND (retry_at IS NULL OR retry_at <= $1) FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [now],
  )
  for (const job of jobs) {
    try {
      await runJob(ctx, job)
    } catch (error) {
      ctx.log.error('import_failed', { job_id: job.job_id, error: String(error) })
      await finishJob(ctx, job, 'failed', String(error).slice(0, 200))
    }
  }
  return jobs.length
}

export async function recoverImports(ctx: Ctx): Promise<void> {
  await ctx.db.query(`UPDATE import_jobs SET status = 'pending' WHERE status = 'running'`)
}
