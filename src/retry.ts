import type { Ctx } from './ctx.js'
import { TelegramError } from './ports.js'

/** General rule for read-only calls: 429 by retry_after, network and 5xx up to three attempts, 400 and 403 never. */
export async function withRetry<T>(ctx: Ctx, call: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (!(error instanceof TelegramError) || error.kind === 'client' || attempt >= attempts) throw error
      const wait = error.kind === 'rate_limit' ? (error.retryAfter ?? 1) * 1000 : 2 ** attempt * 1000
      await ctx.clock.sleep(wait)
    }
  }
}
