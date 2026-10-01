import type { Update } from 'grammy/types'
import { registerCardActionFlows } from './card-actions.js'
import { deliverCards } from './cards.js'
import type { Ctx } from './ctx.js'
import { processEvaluations } from './evaluation.js'
import { runFlows } from './flows.js'
import { recoverImports, runImports } from './import.js'
import { recoverStaleOps, runDueOps } from './ops.js'
import { registerReportFlow } from './report.js'
import { registerModerationFlows } from './moderation.js'
import { expireAdminSteam, registerSanctionFlows, scheduleDueBans } from './sanctions.js'
import { registerSpamCommandFlows } from './spam-command.js'
import { runDecay, runDigest, runMuteExpiry, runRetention } from './scheduled.js'
import { runTagPlacement } from './tags.js'
import { ingestUpdate } from './updates.js'

export interface App {
  ctx: Ctx
  handle(update: Update): Promise<void>
  /** One pass over everything that is due. Returns how much work was found. */
  tick(options?: { scheduled?: boolean }): Promise<number>
  /** Repeats passes until nothing is due. For tests and shutdown. */
  settle(): Promise<void>
  start(): Promise<void>
}

export function createApp(ctx: Ctx): App {
  registerSanctionFlows()
  registerReportFlow()
  registerSpamCommandFlows()
  registerCardActionFlows()
  registerModerationFlows()

  async function scheduled(): Promise<void> {
    await scheduleDueBans(ctx)
    await expireAdminSteam(ctx)
    await runMuteExpiry(ctx)
    await runDecay(ctx)
    await runDigest(ctx)
    await runRetention(ctx)
    await runTagPlacement(ctx)
  }

  async function tick(options: { scheduled?: boolean } = {}): Promise<number> {
    let work = 0
    await recoverStaleOps(ctx)
    work += await processEvaluations(ctx)
    work += await runFlows(ctx)
    work += await runDueOps(ctx)
    work += await deliverCards(ctx)
    work += await runImports(ctx)
    if (options.scheduled) {
      await scheduled()
      work += await runFlows(ctx)
      work += await runDueOps(ctx)
      work += await deliverCards(ctx)
    }
    return work
  }

  return {
    ctx,
    handle: (update) => ingestUpdate(ctx, update),
    tick,
    async settle() {
      for (let i = 0; i < 30; i++) {
        if ((await tick({ scheduled: i === 0 })) === 0) return
      }
    },
    async start() {
      await recoverStaleOps(ctx)
      await recoverImports(ctx)
    },
  }
}
