import { randomBytes, randomInt } from 'node:crypto'
import type { ChatJoinRequest } from 'grammy/types'
import type { Ctx } from './ctx.js'
import type { Q, Row } from './db.js'
import { KINDS, SHADES, sprite, type Kind, type Sprite } from './gate-sprites.js'
import { ensureChat } from './members.js'
import { TelegramError } from './ports.js'
import { getSettings } from './settings/settings.js'

/**
 * Section 3.6.8 (decision of the owner 24.11): the frog on the door. A join request gets one check: six pixel animals, one of
 * them the frog. The decision leaves 'pending' once (a conditional UPDATE: the press, the time limit and a join approved by an
 * admin race for it); the answer to Telegram is sent by whoever holds the lease of `send`. Model: specs/tla/Gate.tla.
 */

type Post = () => Promise<void>

/** One miss reshuffles the animals; the second fails the check. */
const MISSES_ALLOWED = 1
/** A person gets at most this many join checks in one chat per day; the next request is declined without the window. */
const DAILY_CHECKS = 3
const DAY_MS = 86_400_000
const SEND_LEASE_MS = 30_000
const SEND_TRIES = 8
const SEND_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000]
/** A failed check of the appeal button may be repeated after this long; the button itself is not burned. */
const APPEAL_COOLDOWN_MS = 10 * 60_000
/** An untouched check of the appeal button closes after this long. */
const APPEAL_CHECK_MS = 30 * 60_000
/** Telegram's answers that mean the request is no longer there to decide: the send is over. */
const SETTLED = /HIDE_REQUESTER_MISSING|USER_ALREADY_PARTICIPANT|REQUEST_NOT_FOUND|already (a )?(participant|member)|not found/i

interface Puzzle {
  slots: Kind[]
  flips: boolean[]
  shades: number[]
}

type DoorState = 'open' | 'passed' | 'failed' | 'timeout' | 'gone' | 'unknown'

export interface DoorView {
  state: DoorState
  title?: string
  puzzle?: Sprite[]
  missed?: boolean
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function newPuzzle(): Puzzle {
  const slots = shuffle(KINDS)
  return { slots, flips: slots.map(() => randomInt(2) === 1), shades: slots.map(() => randomInt(SHADES)) }
}

/** What the client sees: cells and colours in the order of the slots, without the names. */
function puzzleView(puzzle: Puzzle): Sprite[] {
  return puzzle.slots.map((kind, i) => sprite(kind, puzzle.flips[i], puzzle.shades[i]))
}

function newToken(): string {
  return randomBytes(16).toString('hex')
}

/** The address of the window: the guard passes the request in initData, the private chat passes the token in the address. */
function doorUrl(ctx: Ctx, token?: string): string {
  const base = (ctx.env.publicUrl ?? 'https://jevchik.com').replace(/\/+$/, '')
  return `${base}/?door=${token ?? 'guard'}`
}

const DM_TEXT = (title: string) =>
  `Это Жевчик, охраняю дверь в «${title}». Спамеров тут хватает, поэтому один вопрос: тыкни в лягушонка, и я тебя пущу. На всё про всё есть несколько минут.`

async function answerQuietly(ctx: Ctx, queryId: string, result: 'approve' | 'decline' | 'queue'): Promise<void> {
  await ctx.tg.answerChatJoinRequestQuery(queryId, result).catch((error: unknown) => ctx.log.warn('gate_query_answer_failed', { result, error: String(error) }))
}

// ---------------------------------------------------------------- the request

/**
 * A `chat_join_request` update, inside the transaction of the update. Off: a guard query goes to the admins at once, a plain
 * request is left alone. On: one check is written and the window is opened after the commit.
 */
export async function receiveJoinRequest(ctx: Ctx, q: Q, req: ChatJoinRequest, posts: Post[]): Promise<void> {
  if (req.chat.type !== 'supergroup') return
  const now = ctx.clock.now()
  await ensureChat(q, req.chat, now)
  const settings = await getSettings(q, req.chat.id)
  const queryId = req.query_id ?? null
  if (!settings.bool('join_gate') || req.from.is_bot) {
    if (queryId) posts.push(() => answerQuietly(ctx, queryId, 'queue'))
    return
  }
  const recent = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM gate_checks WHERE chat_id = $1 AND user_id = $2 AND purpose = 'join' AND created_at > $3`,
    [req.chat.id, req.from.id, new Date(now.getTime() - DAY_MS)],
  )
  // A request Telegram sends again while one is pending replaces it: the old one cannot be answered any more.
  await q.query(`UPDATE gate_checks SET status = 'gone', reason = 'replaced', decided_at = $4 WHERE chat_id = $1 AND user_id = $2 AND purpose = $3 AND status = 'pending'`, [
    req.chat.id,
    req.from.id,
    'join',
    now,
  ])
  const limited = recent[0].n >= DAILY_CHECKS
  const rows = await q.query(
    `INSERT INTO gate_checks (chat_id, user_id, purpose, via, query_id, user_chat_id, token, puzzle, status, send, reason, created_at, decided_at)
     VALUES ($1,$2,'join',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      req.chat.id,
      req.from.id,
      queryId ? 'guard' : 'dm',
      queryId,
      req.user_chat_id,
      newToken(),
      JSON.stringify(newPuzzle()),
      limited ? 'failed' : 'pending',
      limited ? 'todo' : 'none',
      limited ? 'daily_limit' : null,
      now,
      limited ? now : null,
    ],
  )
  if (!limited) posts.push(() => openDoor(ctx, rows[0], req.chat.title ?? 'чат'))
}

/** Section 3.6.8: the window of the guard within its 10 seconds; failing that, a private message; failing that, the admins decide. */
async function openDoor(ctx: Ctx, check: Row, title: string): Promise<void> {
  if (check.query_id) {
    try {
      await ctx.tg.sendChatJoinRequestWebApp(check.query_id, doorUrl(ctx))
      return
    } catch (error) {
      ctx.log.warn('gate_window_failed', { check_id: check.check_id, error: String(error) })
    }
  }
  try {
    await ctx.tg.sendMessage(Number(check.user_chat_id), DM_TEXT(title), { buttons: [[{ text: 'Открыть дверь 🐸', web_app: { url: doorUrl(ctx, check.token) } }]] })
    await ctx.db.query(`UPDATE gate_checks SET via = 'dm' WHERE check_id = $1`, [check.check_id])
    return
  } catch (error) {
    ctx.log.warn('gate_dm_failed', { check_id: check.check_id, error: String(error) })
  }
  const left = await ctx.db.query(`UPDATE gate_checks SET status = 'gone', reason = 'door_failed', decided_at = $2 WHERE check_id = $1 AND status = 'pending' RETURNING 1`, [
    check.check_id,
    ctx.clock.now(),
  ])
  if (left.length > 0 && check.query_id) await answerQuietly(ctx, check.query_id, 'queue')
}

/** Section 3.6.8: the member came in (an admin approved the request by hand, or it was approved already): the check is over. */
export async function joinedChat(q: Q, chatId: number, userId: number, now: Date): Promise<void> {
  await q.query(`UPDATE gate_checks SET status = 'gone', reason = 'joined', decided_at = $3 WHERE chat_id = $1 AND user_id = $2 AND purpose = 'join' AND status = 'pending'`, [
    chatId,
    userId,
    now,
  ])
}

// ---------------------------------------------------------------- the window

/** The check the window belongs to: by the guard's query of this user, or by the token of the private message of this user. */
export async function findDoor(ctx: Ctx, from: { userId: number; queryId: string | null; token: string | null }): Promise<Row | null> {
  if (from.queryId) {
    const rows = await ctx.db.query(`SELECT * FROM gate_checks WHERE purpose = 'join' AND query_id = $1 AND user_id = $2 ORDER BY check_id DESC LIMIT 1`, [from.queryId, from.userId])
    if (rows[0]) return rows[0]
  }
  if (from.token && /^[0-9a-f]{32}$/.test(from.token)) {
    const rows = await ctx.db.query(`SELECT * FROM gate_checks WHERE purpose = 'join' AND token = $1 AND user_id = $2`, [from.token, from.userId])
    if (rows[0]) return rows[0]
  }
  return null
}

const STATES: Record<string, DoorState> = { pending: 'open', passed: 'passed', failed: 'failed', timeout: 'timeout', gone: 'gone', used: 'passed' }

export async function doorView(ctx: Ctx, check: Row | null, missed = false): Promise<DoorView> {
  if (!check) return { state: 'unknown' }
  const title = (await ctx.db.query('SELECT title FROM chats WHERE chat_id = $1', [check.chat_id]))[0]?.title ?? 'чат'
  const state = STATES[check.status as string] ?? 'unknown'
  return state === 'open' ? { state, title, puzzle: puzzleView(check.puzzle as Puzzle), ...(missed ? { missed } : {}) } : { state, title }
}

export type PickResult = { result: 'passed' } | { result: 'miss'; check: Row } | { result: 'failed' } | { result: 'closed'; check: Row }

/**
 * One tap on the slot `index`. The frog decides the check; a miss reshuffles once, the second miss fails it. Every change
 * is conditional on the state that was read, so two taps at once count once.
 */
export async function pick(ctx: Ctx, check: Row, index: number): Promise<PickResult> {
  const now = ctx.clock.now()
  const puzzle = check.puzzle as Puzzle
  const toSend = check.purpose === 'join' ? 'todo' : 'none'
  const passed = check.purpose === 'join' ? 'passed' : 'used'
  if (check.status !== 'pending') return { result: 'closed', check }
  if (puzzle.slots[index] === 'frog') {
    const won = await ctx.db.query(`UPDATE gate_checks SET status = $2, send = $3, decided_at = $4 WHERE check_id = $1 AND status = 'pending' AND misses = $5 RETURNING *`, [
      check.check_id,
      passed,
      toSend,
      now,
      check.misses,
    ])
    if (won.length === 0) return closedOrAgain(ctx, check.check_id)
    if (toSend === 'todo') await sendNow(ctx, Number(check.check_id))
    return { result: 'passed' }
  }
  if (Number(check.misses) >= MISSES_ALLOWED) {
    const lost = await ctx.db.query(
      `UPDATE gate_checks SET status = 'failed', send = $2, reason = 'missed', decided_at = $3, misses = misses + 1 WHERE check_id = $1 AND status = 'pending' AND misses = $4 RETURNING *`,
      [check.check_id, toSend, now, check.misses],
    )
    if (lost.length === 0) return closedOrAgain(ctx, check.check_id)
    if (toSend === 'todo') await sendNow(ctx, Number(check.check_id))
    return { result: 'failed' }
  }
  const again = await ctx.db.query(`UPDATE gate_checks SET misses = misses + 1, puzzle = $2 WHERE check_id = $1 AND status = 'pending' AND misses = $3 RETURNING *`, [
    check.check_id,
    JSON.stringify(newPuzzle()),
    check.misses,
  ])
  if (again.length === 0) return closedOrAgain(ctx, check.check_id)
  return { result: 'miss', check: again[0] }
}

/** Somebody else changed the check between the read and the tap: the caller shows what it is now. */
async function closedOrAgain(ctx: Ctx, checkId: unknown): Promise<PickResult> {
  const row = (await ctx.db.query('SELECT * FROM gate_checks WHERE check_id = $1', [checkId]))[0]
  return { result: 'closed', check: row }
}

// ---------------------------------------------------------------- time and the answer to Telegram

/** Section 3.6.8: a join check without an answer for `join_gate_minutes` is declined; an appeal check simply closes. */
export async function expireChecks(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now()
  const rows = await ctx.db.query(`SELECT check_id, chat_id, created_at FROM gate_checks WHERE purpose = 'join' AND status = 'pending' AND created_at < $1`, [new Date(now.getTime() - 2 * 60_000)])
  const minutes = new Map<number, number>()
  for (const row of rows) {
    const chatId = Number(row.chat_id)
    if (!minutes.has(chatId)) minutes.set(chatId, (await getSettings(ctx.db, chatId)).num('join_gate_minutes'))
    if (new Date(row.created_at).getTime() + minutes.get(chatId)! * 60_000 > now.getTime()) continue
    await ctx.db.query(`UPDATE gate_checks SET status = 'timeout', send = 'todo', decided_at = $2 WHERE check_id = $1 AND status = 'pending'`, [row.check_id, now])
  }
  await ctx.db.query(`UPDATE gate_checks SET status = 'timeout', decided_at = $1 WHERE purpose = 'appeal' AND status = 'pending' AND created_at < $2`, [
    now,
    new Date(now.getTime() - APPEAL_CHECK_MS),
  ])
}

/**
 * Takes the lease of sends that are due: a 'todo' whose pause is over, or a 'sending' whose lease ran out. The lease is the
 * number of the try: only the holder of that number may close the send.
 */
async function claimSends(ctx: Ctx, only: number | null): Promise<Row[]> {
  const now = ctx.clock.now()
  return ctx.db.query(
    `UPDATE gate_checks SET send = 'sending', send_until = $1, send_tries = send_tries + 1
     WHERE check_id IN (
       SELECT check_id FROM gate_checks
       WHERE purpose = 'join' AND ($3::bigint IS NULL OR check_id = $3)
         AND ((send = 'todo' AND (send_until IS NULL OR send_until <= $2)) OR (send = 'sending' AND send_until <= $2))
       ORDER BY check_id LIMIT 20 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [new Date(now.getTime() + SEND_LEASE_MS), now, only],
  )
}

/** For the guard the query first; when Telegram refuses the query (it lives 10 seconds), the request itself. */
async function callTelegram(ctx: Ctx, check: Row, approve: boolean): Promise<void> {
  if (check.query_id) {
    try {
      await ctx.tg.answerChatJoinRequestQuery(check.query_id, approve ? 'approve' : 'decline')
      return
    } catch (error) {
      if (!(error instanceof TelegramError) || error.kind !== 'client') throw error
    }
  }
  if (approve) await ctx.tg.approveChatJoinRequest(Number(check.chat_id), Number(check.user_id))
  else await ctx.tg.declineChatJoinRequest(Number(check.chat_id), Number(check.user_id))
}

async function finishSend(ctx: Ctx, check: Row, fields: { send: string; note?: string | null; until?: Date | null }): Promise<void> {
  await ctx.db.query(
    `UPDATE gate_checks SET send = $3, send_note = COALESCE($4, send_note), send_until = $5 WHERE check_id = $1 AND send = 'sending' AND send_tries = $2`,
    [check.check_id, check.send_tries, fields.send, fields.note ?? null, fields.until ?? null],
  )
}

async function sendOne(ctx: Ctx, check: Row): Promise<void> {
  try {
    await callTelegram(ctx, check, check.status === 'passed')
    await finishSend(ctx, check, { send: 'done' })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof TelegramError && error.kind === 'client') {
      await finishSend(ctx, check, { send: SETTLED.test(message) ? 'done' : 'failed', note: message.slice(0, 200) })
      return
    }
    const tries = Number(check.send_tries)
    if (tries >= SEND_TRIES) {
      await finishSend(ctx, check, { send: 'failed', note: message.slice(0, 200) })
      return
    }
    const pause = error instanceof TelegramError && error.kind === 'rate_limit' ? (error.retryAfter ?? 1) * 1000 : SEND_BACKOFF_MS[Math.min(tries, SEND_BACKOFF_MS.length) - 1]
    await finishSend(ctx, check, { send: 'todo', until: new Date(ctx.clock.now().getTime() + pause) })
  }
}

/** Right after the tap, so the person is let in at once; a failure is repeated by the bot's tick. */
async function sendNow(ctx: Ctx, checkId: number): Promise<void> {
  for (const check of await claimSends(ctx, checkId)) await sendOne(ctx, check)
}

/** The bot's tick: due answers to Telegram. Returns how many were tried. */
export async function sendDecisions(ctx: Ctx): Promise<number> {
  const due = await claimSends(ctx, null)
  for (const check of due) await sendOne(ctx, check)
  return due.length
}

// ---------------------------------------------------------------- the appeal button

export type AppealCheck = { state: 'open'; puzzle: Sprite[] } | { state: 'wait' }

/** Section 3.6.8: the check before «Разбанить меня». A pending one is reused; after a failure a new one only after 10 minutes. */
export async function appealCheck(ctx: Ctx, chatId: number, userId: number): Promise<AppealCheck> {
  const now = ctx.clock.now()
  const pending = await ctx.db.query(`SELECT * FROM gate_checks WHERE chat_id = $1 AND user_id = $2 AND purpose = 'appeal' AND status = 'pending'`, [chatId, userId])
  if (pending[0]) return { state: 'open', puzzle: puzzleView(pending[0].puzzle as Puzzle) }
  const failed = await ctx.db.query(`SELECT 1 FROM gate_checks WHERE chat_id = $1 AND user_id = $2 AND purpose = 'appeal' AND status = 'failed' AND decided_at > $3`, [
    chatId,
    userId,
    new Date(now.getTime() - APPEAL_COOLDOWN_MS),
  ])
  if (failed.length > 0) return { state: 'wait' }
  const rows = await ctx.db.query(
    `INSERT INTO gate_checks (chat_id, user_id, purpose, token, puzzle, created_at) VALUES ($1,$2,'appeal',$3,$4,$5)
     ON CONFLICT (chat_id, user_id, purpose) WHERE status = 'pending' DO NOTHING RETURNING *`,
    [chatId, userId, newToken(), JSON.stringify(newPuzzle()), now],
  )
  if (rows[0]) return { state: 'open', puzzle: puzzleView(rows[0].puzzle as Puzzle) }
  return appealCheck(ctx, chatId, userId)
}

export type AppealPick = { result: 'passed' } | { result: 'miss'; puzzle: Sprite[] } | { result: 'failed' } | { result: 'none' }

/** A tap in the appeal check. 'passed' spends the check: the caller presses the button right after. */
export async function appealPick(ctx: Ctx, chatId: number, userId: number, index: number): Promise<AppealPick> {
  const check = (await ctx.db.query(`SELECT * FROM gate_checks WHERE chat_id = $1 AND user_id = $2 AND purpose = 'appeal' AND status = 'pending'`, [chatId, userId]))[0]
  if (!check) return { result: 'none' }
  const result = await pick(ctx, check, index)
  if (result.result === 'miss') return { result: 'miss', puzzle: puzzleView(result.check.puzzle as Puzzle) }
  if (result.result === 'closed') return result.check?.status === 'used' ? { result: 'passed' } : { result: 'none' }
  return result
}
