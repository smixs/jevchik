import type { App } from './app.js'
import type { Ctx } from './ctx.js'

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]

async function readOffset(ctx: Ctx): Promise<number> {
  const rows = await ctx.db.query(`SELECT value FROM kv WHERE key = 'poll_offset'`)
  return rows[0] ? Number(rows[0].value) : 0
}

async function saveOffset(ctx: Ctx, offset: number): Promise<void> {
  await ctx.db.query(`INSERT INTO kv (key, value) VALUES ('poll_offset', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify(offset)])
}

/**
 * One polling step. The offset moves past an update only after it was written to the database,
 * so a failed write makes Telegram deliver it again.
 */
export async function pollOnce(ctx: Ctx, app: App, offset: number): Promise<{ offset: number; ok: boolean }> {
  let updates
  try {
    updates = await ctx.tg.getUpdates(offset, 30)
  } catch (error) {
    ctx.log.warn('poll_failed', { error: String(error) })
    return { offset, ok: false }
  }
  let next = offset
  for (const update of updates) {
    try {
      await app.handle(update)
    } catch (error) {
      ctx.log.error('update_failed', { update_id: update.update_id, error: String(error) })
      return { offset: next, ok: false }
    }
    next = update.update_id + 1
  }
  if (next !== offset) await saveOffset(ctx, next).catch(() => {})
  return { offset: next, ok: true }
}

export async function runPoller(ctx: Ctx, app: App, signal: AbortSignal): Promise<void> {
  let offset = await readOffset(ctx).catch(() => 0)
  let failures = 0
  while (!signal.aborted) {
    const result = await pollOnce(ctx, app, offset)
    offset = result.offset
    failures = result.ok ? 0 : failures + 1
    if (!result.ok) await ctx.clock.sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1])
  }
}
