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
/** The guard may open the window only within 10 seconds of the request; the bot may write first for 5 minutes. */
const GUARD_MS = 10_000
const DM_MS = 5 * 60_000
/** A window still not taken this long after the request: the process stopped before opening it; the tick takes it over. */
const DOOR_LOST_MS = 15_000
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

/** 'letting': the frog is found and the answer to Telegram is on its way; 'stuck': Telegram did not take it, the admins decide. */
type DoorState = 'open' | 'letting' | 'passed' | 'stuck' | 'failed' | 'timeout' | 'gone' | 'unknown'

export interface DoorView {
  state: DoorState
  title?: string
  puzzle?: Sprite[]
  /** The number of the layout: a tap names the layout it was made on, a tap on an old one changes nothing. */
  round?: number
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

/**
 * One lock per chat and person. A new request takes it before its check is written; an answer by the pair chat/person
 * (it reaches whatever request is open now) takes it around the call, so it never reaches a newer request. Gate.tla, Fresh.
 */
async function pairLock(q: Q, chatId: unknown, userId: unknown): Promise<void> {
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`gate:${String(chatId)}:${String(userId)}`])
}

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
  await pairLock(q, req.chat.id, req.from.id)
  // Only checks the person was given count: the windows that opened or are opening, not the refusals of the limit.
  const recent = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM gate_checks
     WHERE chat_id = $1 AND user_id = $2 AND purpose = 'join' AND door IN ('todo', 'opening', 'open') AND created_at > $3`,
    [req.chat.id, req.from.id, new Date(now.getTime() - DAY_MS)],
  )
  // A new request of the same person: the old check cannot be answered any more, and an answer of an old check not sent
  // yet must not go out, because by the pair chat/person it would reach the new request.
  await q.query(`UPDATE gate_checks SET status = 'gone', reason = 'replaced', decided_at = $3 WHERE chat_id = $1 AND user_id = $2 AND purpose = 'join' AND status = 'pending'`, [
    req.chat.id,
    req.from.id,
    now,
  ])
  await q.query(`UPDATE gate_checks SET send = 'skipped', send_note = 'superseded' WHERE chat_id = $1 AND user_id = $2 AND purpose = 'join' AND send = 'todo'`, [req.chat.id, req.from.id])
  const limited = recent[0].n >= DAILY_CHECKS
  const rows = await q.query(
    `INSERT INTO gate_checks (chat_id, user_id, purpose, via, query_id, user_chat_id, token, puzzle, status, send, reason, door, created_at, decided_at)
     VALUES ($1,$2,'join',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
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
      limited ? 'none' : 'todo',
      now,
      limited ? now : null,
    ],
  )
  // The refusal of the limit goes to the guard at once too: its query lives 10 seconds.
  if (limited) posts.push(() => sendNow(ctx, Number(rows[0].check_id)))
  else posts.push(() => openDoor(ctx, rows[0], req.chat.title ?? 'чат'))
}

/**
 * Section 3.6.8: the window of the guard within its 10 seconds; failing that, a private message within 5 minutes; failing
 * that, the admins decide. Whoever moves `door` from 'todo' opens it: right after the request, or the tick after a stop.
 */
async function openDoor(ctx: Ctx, check: Row, title: string): Promise<void> {
  const mine = await ctx.db.query(`UPDATE gate_checks SET door = 'opening' WHERE check_id = $1 AND door = 'todo' AND status = 'pending' RETURNING 1`, [check.check_id])
  if (mine.length === 0) return
  const age = () => ctx.clock.now().getTime() - new Date(check.created_at).getTime()
  const opened = (via: string) => ctx.db.query(`UPDATE gate_checks SET door = 'open', via = $2 WHERE check_id = $1 AND door = 'opening'`, [check.check_id, via])
  if (check.query_id && age() < GUARD_MS) {
    try {
      await ctx.tg.sendChatJoinRequestWebApp(check.query_id, doorUrl(ctx))
      await opened('guard')
      return
    } catch (error) {
      ctx.log.warn('gate_window_failed', { check_id: check.check_id, error: String(error) })
    }
  }
  if (check.user_chat_id && age() < DM_MS) {
    try {
      await ctx.tg.sendMessage(Number(check.user_chat_id), DM_TEXT(title), { buttons: [[{ text: 'Открыть дверь 🐸', web_app: { url: doorUrl(ctx, check.token) } }]] })
      await opened('dm')
      return
    } catch (error) {
      ctx.log.warn('gate_dm_failed', { check_id: check.check_id, error: String(error) })
    }
  }
  const left = await ctx.db.query(
    `UPDATE gate_checks SET status = 'gone', reason = 'door_failed', door = 'lost', decided_at = $2 WHERE check_id = $1 AND status = 'pending' RETURNING 1`,
    [check.check_id, ctx.clock.now()],
  )
  if (left.length > 0 && check.query_id && age() < GUARD_MS) await answerQuietly(ctx, check.query_id, 'queue')
}

/** The tick: windows nobody took after the request (the process stopped between the commit and the call). */
async function openLostDoors(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query(
    `SELECT g.*, c.title FROM gate_checks g LEFT JOIN chats c ON c.chat_id = g.chat_id
     WHERE g.purpose = 'join' AND g.status = 'pending' AND g.door = 'todo' AND g.created_at < $1 ORDER BY g.check_id LIMIT 20`,
    [new Date(ctx.clock.now().getTime() - DOOR_LOST_MS)],
  )
  for (const row of rows) await openDoor(ctx, row, (row.title as string | null) ?? 'чат')
  return rows.length
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
/** A found frog is «Пустил» only when Telegram took the approval. */
const PASSED_BY_SEND: Record<string, DoorState> = { todo: 'letting', sending: 'letting', done: 'passed', failed: 'stuck', skipped: 'gone' }

function stateOf(check: Row): DoorState {
  if (check.status === 'passed') return PASSED_BY_SEND[check.send as string] ?? 'letting'
  return STATES[check.status as string] ?? 'unknown'
}

export async function doorView(ctx: Ctx, check: Row | null, missed = false): Promise<DoorView> {
  if (!check) return { state: 'unknown' }
  const title = (await ctx.db.query('SELECT title FROM chats WHERE chat_id = $1', [check.chat_id]))[0]?.title ?? 'чат'
  const state = stateOf(check)
  if (state !== 'open') return { state, title }
  return { state, title, puzzle: puzzleView(check.puzzle as Puzzle), round: Number(check.misses), ...(missed ? { missed } : {}) }
}

export type PickResult =
  | { result: 'passed' }
  | { result: 'miss'; check: Row }
  | { result: 'failed' }
  | { result: 'closed'; check: Row }
  /** The tap was made on a layout that is not the current one: nothing is spent, the current layout is shown. */
  | { result: 'stale'; check: Row }

/** How long a check waits for the tap: `join_gate_minutes` of the chat for the door, 30 minutes for the appeal button. */
async function windowMs(ctx: Ctx, check: Row): Promise<number> {
  if (check.purpose !== 'join') return APPEAL_CHECK_MS
  return (await getSettings(ctx.db, Number(check.chat_id))).num('join_gate_minutes') * 60_000
}

/**
 * The time of a check is over. A join check is declined only when its window surely opened; a window that did not open
 * (or whose opening was cut off) leaves the request to the admins. An appeal check simply closes.
 */
async function expireOne(ctx: Ctx, check: Row, now: Date): Promise<void> {
  if (check.purpose !== 'join') {
    await ctx.db.query(`UPDATE gate_checks SET status = 'timeout', decided_at = $2 WHERE check_id = $1 AND status = 'pending'`, [check.check_id, now])
    return
  }
  await ctx.db.query(
    `UPDATE gate_checks SET
       status = CASE WHEN door = 'open' THEN 'timeout' ELSE 'gone' END,
       reason = CASE WHEN door = 'open' THEN reason ELSE 'door_failed' END,
       send = CASE WHEN door = 'open' THEN 'todo' ELSE send END,
       door = CASE WHEN door = 'open' THEN door ELSE 'lost' END,
       decided_at = $2
     WHERE check_id = $1 AND status = 'pending'`,
    [check.check_id, now],
  )
}

/**
 * One tap on the slot `index`. The frog decides the check; a miss reshuffles once, the second miss fails it. Every change
 * is conditional on the state that was read, so two taps at once count once.
 */
export async function pick(ctx: Ctx, check: Row, index: number, round: number): Promise<PickResult> {
  const now = ctx.clock.now()
  const puzzle = check.puzzle as Puzzle
  const toSend = check.purpose === 'join' ? 'todo' : 'none'
  const passed = check.purpose === 'join' ? 'passed' : 'used'
  if (check.status !== 'pending') return { result: 'closed', check }
  if (round !== Number(check.misses)) return { result: 'stale', check }
  // The time limit holds at the tap too, not only at the next pass of the tick; the UPDATEs below keep it at the boundary.
  const since = new Date(now.getTime() - (await windowMs(ctx, check)))
  if (new Date(check.created_at).getTime() <= since.getTime()) {
    await expireOne(ctx, check, now)
    return closedOrAgain(ctx, check.check_id)
  }
  if (puzzle.slots[index] === 'frog') {
    const won = await ctx.db.query(
      `UPDATE gate_checks SET status = $2, send = $3, decided_at = $4 WHERE check_id = $1 AND status = 'pending' AND misses = $5 AND created_at > $6 RETURNING *`,
      [check.check_id, passed, toSend, now, check.misses, since],
    )
    if (won.length === 0) return closedOrAgain(ctx, check.check_id)
    if (toSend === 'todo') await sendNow(ctx, Number(check.check_id))
    return { result: 'passed' }
  }
  if (Number(check.misses) >= MISSES_ALLOWED) {
    const lost = await ctx.db.query(
      `UPDATE gate_checks SET status = 'failed', send = $2, reason = 'missed', decided_at = $3, misses = misses + 1
       WHERE check_id = $1 AND status = 'pending' AND misses = $4 AND created_at > $5 RETURNING *`,
      [check.check_id, toSend, now, check.misses, since],
    )
    if (lost.length === 0) return closedOrAgain(ctx, check.check_id)
    if (toSend === 'todo') await sendNow(ctx, Number(check.check_id))
    return { result: 'failed' }
  }
  const again = await ctx.db.query(`UPDATE gate_checks SET misses = misses + 1, puzzle = $2 WHERE check_id = $1 AND status = 'pending' AND misses = $3 AND created_at > $4 RETURNING *`, [
    check.check_id,
    JSON.stringify(newPuzzle()),
    check.misses,
    since,
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

/** Section 3.6.8: a join check without an answer for `join_gate_minutes` is declined (when its window opened); an appeal check closes. */
export async function expireChecks(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now()
  const rows = await ctx.db.query(`SELECT * FROM gate_checks WHERE status = 'pending' AND created_at < $1`, [new Date(now.getTime() - 2 * 60_000)])
  const minutes = new Map<number, number>()
  for (const row of rows) {
    const chatId = Number(row.chat_id)
    if (row.purpose === 'join' && !minutes.has(chatId)) minutes.set(chatId, await windowMs(ctx, row))
    const limit = row.purpose === 'join' ? minutes.get(chatId)! : APPEAL_CHECK_MS
    if (new Date(row.created_at).getTime() + limit > now.getTime()) continue
    await expireOne(ctx, row, now)
  }
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

/**
 * For the guard the query first (it belongs to this request); when Telegram refuses the query (it lives 10 seconds), the
 * request by the pair chat/person, under the lock of the pair and only while no newer request of the person is there.
 */
async function callTelegram(ctx: Ctx, check: Row, approve: boolean): Promise<'sent' | 'superseded'> {
  if (check.query_id) {
    try {
      await ctx.tg.answerChatJoinRequestQuery(check.query_id, approve ? 'approve' : 'decline')
      return 'sent'
    } catch (error) {
      if (!(error instanceof TelegramError) || error.kind !== 'client') throw error
    }
  }
  return ctx.db.tx(async (q) => {
    await pairLock(q, check.chat_id, check.user_id)
    const newer = await q.query(`SELECT 1 FROM gate_checks WHERE chat_id = $1 AND user_id = $2 AND purpose = 'join' AND check_id > $3 LIMIT 1`, [
      check.chat_id,
      check.user_id,
      check.check_id,
    ])
    if (newer.length > 0) return 'superseded'
    if (approve) await ctx.tg.approveChatJoinRequest(Number(check.chat_id), Number(check.user_id))
    else await ctx.tg.declineChatJoinRequest(Number(check.chat_id), Number(check.user_id))
    return 'sent'
  })
}

async function finishSend(ctx: Ctx, check: Row, fields: { send: string; note?: string | null; until?: Date | null }): Promise<void> {
  await ctx.db.query(
    `UPDATE gate_checks SET send = $3, send_note = COALESCE($4, send_note), send_until = $5 WHERE check_id = $1 AND send = 'sending' AND send_tries = $2`,
    [check.check_id, check.send_tries, fields.send, fields.note ?? null, fields.until ?? null],
  )
}

async function sendOne(ctx: Ctx, check: Row): Promise<void> {
  try {
    const sent = await callTelegram(ctx, check, check.status === 'passed')
    await finishSend(ctx, check, sent === 'sent' ? { send: 'done' } : { send: 'skipped', note: 'superseded' })
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

/** The bot's tick: windows left unopened, then due answers to Telegram. Returns how many were tried. */
export async function sendDecisions(ctx: Ctx): Promise<number> {
  const doors = await openLostDoors(ctx)
  const due = await claimSends(ctx, null)
  for (const check of due) await sendOne(ctx, check)
  return doors + due.length
}

// ---------------------------------------------------------------- the appeal button

export type AppealCheck = { state: 'open'; puzzle: Sprite[]; round: number } | { state: 'wait' }

/** Section 3.6.8: the check before «Разбанить меня». A pending one is reused; after a failure a new one only after 10 minutes. */
export async function appealCheck(ctx: Ctx, chatId: number, userId: number): Promise<AppealCheck> {
  const now = ctx.clock.now()
  const pending = await ctx.db.query(`SELECT * FROM gate_checks WHERE chat_id = $1 AND user_id = $2 AND purpose = 'appeal' AND status = 'pending'`, [chatId, userId])
  if (pending[0]) return { state: 'open', puzzle: puzzleView(pending[0].puzzle as Puzzle), round: Number(pending[0].misses) }
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
  if (rows[0]) return { state: 'open', puzzle: puzzleView(rows[0].puzzle as Puzzle), round: Number(rows[0].misses) }
  return appealCheck(ctx, chatId, userId)
}

export type AppealPick =
  | { result: 'passed' }
  | { result: 'miss' | 'stale'; puzzle: Sprite[]; round: number }
  | { result: 'failed' }
  | { result: 'none' }

/** A tap in the appeal check. 'passed' spends the check: the caller presses the button right after. */
export async function appealPick(ctx: Ctx, chatId: number, userId: number, index: number, round: number): Promise<AppealPick> {
  const check = (await ctx.db.query(`SELECT * FROM gate_checks WHERE chat_id = $1 AND user_id = $2 AND purpose = 'appeal' AND status = 'pending'`, [chatId, userId]))[0]
  if (!check) return { result: 'none' }
  const result = await pick(ctx, check, index, round)
  if (result.result === 'miss' || result.result === 'stale') return { result: result.result, puzzle: puzzleView(result.check.puzzle as Puzzle), round: Number(result.check.misses) }
  if (result.result === 'closed') return result.check?.status === 'used' ? { result: 'passed' } : { result: 'none' }
  return result
}
