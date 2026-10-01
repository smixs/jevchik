import { serve } from '@hono/node-server'
import { fileURLToPath } from 'node:url'
import { GrammyTelegram } from './adapters/telegram.js'
import { HttpJevClient } from './adapters/jev.js'
import { createApp } from './app.js'
import type { Config } from './config.js'
import { JEV_MODEL, type Ctx } from './ctx.js'
import { Db, migrate } from './db.js'
import { consoleLogger, systemClock, systemRng } from './ports.js'
import { createWebApp } from './web/api.js'

export async function runWeb(config: Config): Promise<{ close(): Promise<void> }> {
  const db = new Db(config.databaseUrl)
  await migrate(db)
  const tg = new GrammyTelegram(config.botToken, config.telegramApiRoot ?? undefined)
  const username = config.botUsername ?? (await tg.getMe()).username
  const ctx: Ctx = {
    db,
    tg,
    jev: new HttpJevClient(config.typesafeKey, config.jevUrl ?? undefined),
    vision: null,
    clock: systemClock,
    rng: systemRng,
    log: consoleLogger,
    env: { botUsername: username, botId: 0, importDir: config.importDir, jevModel: JEV_MODEL },
  }
  createApp(ctx)
  const app = createWebApp(ctx, {
    botToken: config.botToken,
    publicDir: config.publicDir ?? fileURLToPath(new URL('./public', import.meta.url)),
    imagesDir: fileURLToPath(new URL('../data-static/ban', import.meta.url)),
  })
  const server = serve({ fetch: app.fetch, port: config.port })
  consoleLogger.info('web_started', { port: config.port })
  return {
    close: async () => {
      server.close()
      await db.close()
    },
  }
}
