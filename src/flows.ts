import type { Ctx } from './ctx.js'
import type { Q, Row } from './db.js'

export type StepResult = 'ok' | 'wait' | 'stop'
export type Step = (ctx: Ctx, flow: Flow) => Promise<StepResult>

export interface Flow {
  flowId: number
  chatId: number
  kind: string
  key: string
  data: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  step: number
  settingsSeq: number
  createdAt: Date
}

export interface NewFlow {
  chatId: number
  kind: string
  key: string
  data: Record<string, unknown>
  now: Date
}

const LEASE_MS = 5 * 60_000
const RETRY_WAIT_MS = 5_000

const registry = new Map<string, Step[]>()

export function registerFlow(kind: string, steps: Step[]): void {
  registry.set(kind, steps)
}

export async function createFlow(q: Q, flow: NewFlow): Promise<boolean> {
  const rows = await q.query(
    `INSERT INTO flows (chat_id, kind, idempotency_key, data, next_attempt_at, settings_seq, created_at)
     VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(max(seq), 0) FROM chat_settings WHERE chat_id = $1),$5)
     ON CONFLICT (chat_id, idempotency_key) DO NOTHING RETURNING flow_id`,
    [flow.chatId, flow.kind, flow.key, JSON.stringify(flow.data), flow.now],
  )
  return rows.length > 0
}

function toFlow(row: Row): Flow {
  return {
    flowId: row.flow_id,
    chatId: row.chat_id,
    kind: row.kind,
    key: row.idempotency_key,
    data: row.data,
    step: row.step,
    settingsSeq: row.settings_seq,
    createdAt: new Date(row.created_at),
  }
}

async function runOne(ctx: Ctx, row: Row): Promise<void> {
  const steps = registry.get(row.kind)
  const flow = toFlow(row)
  if (!steps) throw new Error(`unknown flow kind ${row.kind}`)
  let step = flow.step
  let status = 'running'
  let wait = false
  while (step < steps.length) {
    const result = await steps[step](ctx, { ...flow, step })
    if (result === 'wait') {
      wait = true
      break
    }
    step++
    if (result === 'stop') {
      status = 'completed'
      break
    }
    await ctx.db.query('UPDATE flows SET step = $2 WHERE flow_id = $1', [flow.flowId, step])
  }
  if (step >= steps.length) status = 'completed'
  const next = new Date(ctx.clock.now().getTime() + (wait ? RETRY_WAIT_MS : 0))
  await ctx.db.query('UPDATE flows SET step = $2, status = $3, next_attempt_at = $4 WHERE flow_id = $1', [flow.flowId, step, status, next])
}

async function runClaimed(ctx: Ctx, rows: Row[], now: Date): Promise<void> {
  for (const row of rows) {
    try {
      await runOne(ctx, row)
    } catch (error) {
      ctx.log.error('flow_failed', { flow_id: row.flow_id, kind: row.kind, error: String(error) })
      await ctx.db.query('UPDATE flows SET next_attempt_at = $2 WHERE flow_id = $1', [row.flow_id, new Date(now.getTime() + RETRY_WAIT_MS * 6)])
    }
  }
}

/** Runs every due flow once, from its first unfinished step. */
export async function runFlows(ctx: Ctx, limit = 50): Promise<number> {
  const now = ctx.clock.now()
  const claimed = await ctx.db.query(
    `UPDATE flows SET next_attempt_at = $2 WHERE flow_id IN (
       SELECT flow_id FROM flows WHERE status = 'running' AND next_attempt_at <= $1 ORDER BY flow_id LIMIT $3 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [now, new Date(now.getTime() + LEASE_MS), limit],
  )
  await runClaimed(ctx, claimed, now)
  return claimed.length
}

/** Runs one flow at once, when it is due and nobody else holds it (the answer to a pressed button, section 3.6.2). */
export async function runFlowNow(ctx: Ctx, chatId: number, key: string): Promise<{ status: string; data: Record<string, unknown> } | null> {
  const now = ctx.clock.now()
  const claimed = await ctx.db.query(
    `UPDATE flows SET next_attempt_at = $4 WHERE chat_id = $1 AND idempotency_key = $2 AND status = 'running' AND next_attempt_at <= $3 RETURNING *`,
    [chatId, key, now, new Date(now.getTime() + LEASE_MS)],
  )
  await runClaimed(ctx, claimed, now)
  const rows = await ctx.db.query('SELECT status, data FROM flows WHERE chat_id = $1 AND idempotency_key = $2', [chatId, key])
  return rows[0] ? { status: rows[0].status, data: rows[0].data } : null
}

/**
 * The steps go on after one of them stops: the rest are skipped, but `last` still runs, so that a flow can report what it did
 * and what it could not do. The stop is remembered in the flow data.
 */
export function withReport(steps: Step[], last: Step): Step[] {
  const guarded = steps.map((step): Step => async (ctx, flow) => {
    if (flow.data.stopped === true) return 'ok'
    const result = await step(ctx, flow)
    if (result !== 'stop') return result
    flow.data.stopped = true
    await ctx.db.query(`UPDATE flows SET data = data || '{"stopped": true}' WHERE flow_id = $1`, [flow.flowId])
    return 'ok'
  })
  return [...guarded, last]
}
