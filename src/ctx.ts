import type { Db } from './db.js'
import type { Clock, JevClient, Logger, Rng, TelegramApi, VisionClient } from './ports.js'

interface AppEnv {
  botUsername: string
  botId: number
  importDir: string
  jevModel: string
}

export interface Ctx {
  db: Db
  tg: TelegramApi
  jev: JevClient
  vision: VisionClient | null
  clock: Clock
  rng: Rng
  log: Logger
  env: AppEnv
}

export const JEV_MODEL = 'jev-1.13.0'
export const DAY_MS = 86_400_000
export const HOUR_MS = 3_600_000
/** Section 3.10: a removed or carded message text lives at most this long, whatever the stored setting says. */
export const HELD_TEXT_MAX_DAYS = 30
