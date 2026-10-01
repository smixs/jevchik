import { writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { GrammyTelegram } from './adapters/telegram.js'
import { HttpJevClient } from './adapters/jev.js'
import { HttpVisionClient } from './adapters/vision.js'
import { createApp } from './app.js'
import type { Config } from './config.js'
import { JEV_MODEL, type Ctx } from './ctx.js'
import { Db, migrate } from './db.js'
import { poll } from './poll-loop.js'
import { consoleLogger, systemClock, systemRng } from './ports.js'

/** Runs the long-polling bot and the worker loop until the signal aborts. */
export async function runBot(config: Config, signal: AbortSignal, heartbeatFile = '/tmp/heartbeat'): Promise<void> {
  const db = new Db(config.databaseUrl)
  await migrate(db)
  mkdirSync(config.importDir, { recursive: true })
  const tg = new GrammyTelegram(config.botToken, config.telegramApiRoot ?? undefined)
  const me = await tg.getMe()
  const vision = config.visionBaseUrl && config.visionModel && config.visionKey ? new HttpVisionClient(config.visionBaseUrl, config.visionModel, config.visionKey) : null
  const ctx: Ctx = {
    db,
    tg,
    jev: new HttpJevClient(config.typesafeKey, config.jevUrl ?? undefined),
    vision,
    clock: systemClock,
    rng: systemRng,
    log: consoleLogger,
    env: { botUsername: me.username, botId: me.id, importDir: config.importDir, jevModel: JEV_MODEL },
  }
  const app = createApp(ctx)
  await app.start()
  await poll(ctx, app, signal, () => writeFileSync(heartbeatFile, String(Date.now())))
  await db.close()
}
