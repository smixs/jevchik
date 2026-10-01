export interface Config {
  databaseUrl: string
  botToken: string
  typesafeKey: string
  visionBaseUrl: string | null
  visionModel: string | null
  visionKey: string | null
  port: number
  importDir: string
  botUsername: string | null
  telegramApiRoot: string | null
  jevUrl: string | null
  publicDir: string | null
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`missing environment variable ${name}`)
  return value
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  return env[name] || null
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: need(env, 'DATABASE_URL'),
    botToken: need(env, 'TELEGRAM_BOT_TOKEN'),
    typesafeKey: need(env, 'TYPESAFE_API_KEY'),
    visionBaseUrl: optional(env, 'VISION_BASE_URL'),
    visionModel: optional(env, 'VISION_MODEL'),
    visionKey: optional(env, 'VISION_API_KEY'),
    port: Number(env.PORT ?? 8080),
    importDir: env.IMPORT_DIR ?? '/data/imports',
    botUsername: optional(env, 'BOT_USERNAME'),
    telegramApiRoot: optional(env, 'TELEGRAM_API_ROOT'),
    jevUrl: optional(env, 'JEV_API_URL'),
    publicDir: optional(env, 'PUBLIC_DIR'),
  }
}
