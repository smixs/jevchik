import type { App } from './app.js'
import type { Ctx } from './ctx.js'
import { runPoller } from './poller.js'

const SCHEDULED_EVERY_MS = 60_000

/** Runs the poller and the worker loop side by side until the signal aborts. */
export async function poll(ctx: Ctx, app: App, signal: AbortSignal, heartbeat: () => void): Promise<void> {
  let lastScheduled = 0
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    const nowMs = ctx.clock.now().getTime()
    const scheduled = nowMs - lastScheduled >= SCHEDULED_EVERY_MS
    if (scheduled) lastScheduled = nowMs
    app
      .tick({ scheduled })
      .then(heartbeat)
      .catch((error) => ctx.log.error('tick_failed', { error: String(error) }))
      .finally(() => {
        busy = false
      })
  }, 1000)
  try {
    await runPoller(ctx, app, signal)
  } finally {
    clearInterval(timer)
  }
}
