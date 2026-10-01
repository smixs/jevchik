import type { Ctx } from './ctx.js'
import type { Q, Row } from './db.js'
import { fitRequest, selectQuestions, type JevState } from './jev/state.js'
import type { Answers } from './jev/facts.js'
import { describeMedia, type MediaRef } from './media.js'
import { applyEvaluation, type EvalMeta } from './pipeline.js'
import { JevError, TelegramError } from './ports.js'
import { withRetry } from './retry.js'
import type { QuestionSet } from './settings/settings.js'

const MAX_JEV_ATTEMPTS = 3
const LEASE_MS = 5 * 60_000

export interface NewEvaluation {
  chatId: number
  messageId: number
  gen: number
  state: JevState
  questions: QuestionSet
  meta: EvalMeta
  media: MediaRef | null
  now: Date
}

export function evaluationId(chatId: number, messageId: number, gen: number): string {
  return `msg:${chatId}:${messageId}:${gen}`
}

export async function enqueueEvaluation(q: Q, e: NewEvaluation): Promise<boolean> {
  const rows = await q.query(
    `INSERT INTO evaluations (evaluation_id, chat_id, message_id, kind, status, next_attempt_at, created_at, request, media, meta, settings_seq)
     VALUES ($1,$2,$3,'message','pending',$4,$4,$5,$6,$7,(SELECT COALESCE(max(seq), 0) FROM chat_settings WHERE chat_id = $2))
     ON CONFLICT (evaluation_id) DO NOTHING RETURNING evaluation_id`,
    [
      evaluationId(e.chatId, e.messageId, e.gen),
      e.chatId,
      e.messageId,
      e.now,
      JSON.stringify({ state: e.state, questions: e.questions }),
      e.media ? JSON.stringify(e.media) : null,
      JSON.stringify(e.meta),
    ],
  )
  return rows.length > 0
}

interface Request {
  state: JevState
  questions: QuestionSet
}

async function fetchBio(ctx: Ctx, userId: number): Promise<string | null> {
  try {
    return (await withRetry(ctx, () => ctx.tg.getChat(userId))).bio ?? null
  } catch (error) {
    if (!(error instanceof TelegramError)) throw error
    return null
  }
}

/** Media description and profile bio are resolved once, before the first Jev call. */
async function prepare(ctx: Ctx, row: Row, request: Request, meta: EvalMeta): Promise<void> {
  if (meta.prepared) return
  if (row.media && request.state.media_description === null) {
    request.state.media_description = await describeMedia(ctx, row.media as MediaRef)
  }
  if (meta.fetchBio && request.state.sender_profile) {
    request.state.sender_profile.bio = await fetchBio(ctx, meta.authorId)
  }
  meta.prepared = true
  await ctx.db.query('UPDATE evaluations SET request = $2, meta = $3 WHERE evaluation_id = $1', [
    row.evaluation_id,
    JSON.stringify(request),
    JSON.stringify(meta),
  ])
}

interface Outcome {
  status: string
  answers: Answers | null
  error?: string
}

async function finish(ctx: Ctx, row: Row, outcome: Outcome): Promise<void> {
  const { status, answers, error } = outcome
  const request = row.request as Request
  const meta = row.meta as EvalMeta
  await ctx.db.tx(async (q) => {
    await q.query(`UPDATE evaluations SET status = $2, result = $3, request = NULL, last_error = $4 WHERE evaluation_id = $1`, [
      row.evaluation_id,
      status,
      answers ? JSON.stringify(answers) : null,
      error ?? null,
    ])
    await applyEvaluation(ctx, q, {
      chatId: row.chat_id,
      messageId: row.message_id,
      startedAt: new Date(row.created_at),
      settingsSeq: row.settings_seq,
      meta,
      text: request.state.message,
      answers,
      mediaDescribed: request.state.media_description !== null,
    })
  })
}

async function retryLater(ctx: Ctx, row: Row, error: JevError): Promise<void> {
  const attempts = row.attempt_count as number
  if (attempts >= MAX_JEV_ATTEMPTS) {
    ctx.log.warn('evaluation_unprocessed', { evaluation_id: row.evaluation_id, kind: error.kind })
    await finish(ctx, row, { status: 'unprocessed', answers: null, error: error.message })
    return
  }
  const wait = error.kind === 'rate_limit' && error.retryAfter ? error.retryAfter * 1000 : 2 ** attempts * 1000
  await ctx.db.query(`UPDATE evaluations SET status = 'pending', next_attempt_at = $2, last_error = $3 WHERE evaluation_id = $1`, [
    row.evaluation_id,
    new Date(ctx.clock.now().getTime() + wait),
    error.message,
  ])
}

async function evaluateOne(ctx: Ctx, row: Row): Promise<void> {
  const request = row.request as Request
  const meta = row.meta as EvalMeta
  await prepare(ctx, row, request, meta)
  const state = request.state
  if (!state.message.trim() && state.media_description === null) {
    await finish(ctx, row, { status: 'done', answers: null, error: 'nothing_to_evaluate' })
    return
  }
  const questions = selectQuestions(request.questions, {
    hasProfile: state.sender_profile !== null,
    hasMedia: state.media_description !== null,
    hasReply: state.replied_to !== null,
  })
  const fitted = fitRequest(state, questions)
  if (!fitted) {
    ctx.log.error('context_too_large', { evaluation_id: row.evaluation_id })
    await finish(ctx, row, { status: 'context_too_large', answers: null, error: 'context_too_large' })
    return
  }
  try {
    const response = await ctx.jev.evaluate(fitted.request)
    await finish(ctx, row, { status: 'done', answers: (response.answers ?? {}) as Answers })
  } catch (error) {
    if (!(error instanceof JevError)) throw error
    if (error.kind === 'reject') {
      ctx.log.error('jev_rejected', { evaluation_id: row.evaluation_id, status: error.status, body: safeBody(error.body, (row.request as Request).state.message) })
      await finish(ctx, row, { status: 'rejected', answers: null, error: `${error.status}` })
    } else if (error.kind === 'garbage') {
      ctx.log.warn('jev_garbage', { evaluation_id: row.evaluation_id })
      await finish(ctx, row, { status: 'done', answers: {}, error: 'garbage' })
    } else {
      await retryLater(ctx, row, error)
    }
  }
}

const LOG_BODY_LIMIT = 300

/** A rejected answer may echo the request: the message text is masked and the rest is cut. */
function safeBody(body: string | undefined, text: string): string {
  const masked = text.length >= 3 ? (body ?? '').split(text).join('[text]') : (body ?? '')
  return masked.slice(0, LOG_BODY_LIMIT)
}

async function claimHeads(ctx: Ctx, limit: number): Promise<Row[]> {
  const now = ctx.clock.now()
  const heads = await ctx.db.query(
    `SELECT e.evaluation_id FROM evaluations e
     WHERE e.status = 'pending' AND e.next_attempt_at <= $1
       AND e.seq = (SELECT min(x.seq) FROM evaluations x WHERE x.chat_id = e.chat_id AND x.status IN ('pending','running'))
     ORDER BY e.seq LIMIT $2`,
    [now, limit],
  )
  const claimed: Row[] = []
  for (const head of heads) {
    const rows = await ctx.db.query(
      `UPDATE evaluations SET status = 'running', attempt_count = attempt_count + 1, next_attempt_at = $2
       WHERE evaluation_id = $1 AND status = 'pending' RETURNING *`,
      [head.evaluation_id, new Date(now.getTime() + LEASE_MS)],
    )
    if (rows[0]) claimed.push(rows[0])
  }
  return claimed
}

/** Runs the head of each chat's queue until nothing is due. Order inside a chat is preserved. */
export async function processEvaluations(ctx: Ctx): Promise<number> {
  await ctx.db.query(`UPDATE evaluations SET status = 'pending' WHERE status = 'running' AND next_attempt_at < $1`, [ctx.clock.now()])
  let total = 0
  for (let round = 0; round < 1000; round++) {
    const claimed = await claimHeads(ctx, 20)
    if (claimed.length === 0) break
    total += claimed.length
    await Promise.all(
      claimed.map(async (row) => {
        try {
          await evaluateOne(ctx, row)
        } catch (error) {
          ctx.log.error('evaluation_crashed', { evaluation_id: row.evaluation_id, error: String(error) })
          await ctx.db.query(`UPDATE evaluations SET status = 'pending', next_attempt_at = $2 WHERE evaluation_id = $1`, [
            row.evaluation_id,
            new Date(ctx.clock.now().getTime() + 5000),
          ])
        }
      }),
    )
  }
  return total
}
