import { createHmac, timingSafeEqual } from 'node:crypto'

const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60

interface InitUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
}

export type InitResult =
  | { ok: true; user: InitUser; startParam: string | null; authDate: number }
  | { ok: false; reason: 'missing' | 'malformed' | 'bad_hash' | 'expired' }

export function dataCheckString(raw: string): { pairs: Array<[string, string]>; hash: string | null } | null {
  const params = new URLSearchParams(raw)
  const pairs: Array<[string, string]> = []
  let hash: string | null = null
  const seen = new Set<string>()
  for (const [key, value] of params) {
    if (seen.has(key)) return null
    seen.add(key)
    if (key === 'hash') hash = value
    else pairs.push([key, value])
  }
  return { pairs, hash }
}

function expectedHash(pairs: Array<[string, string]>, botToken: string): string {
  const text = [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest()
  return createHmac('sha256', secret).update(text).digest('hex')
}

function sameHash(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function readUser(raw: string | undefined): InitUser | null {
  try {
    const user = JSON.parse(raw ?? '') as InitUser
    return typeof user?.id === 'number' ? user : null
  } catch {
    return null
  }
}

export function verifyInitData(raw: string | undefined | null, botToken: string, now: Date): InitResult {
  if (!raw) return { ok: false, reason: 'missing' }
  const parsed = dataCheckString(raw)
  if (!parsed || !parsed.hash) return { ok: false, reason: 'malformed' }
  if (!sameHash(parsed.hash, expectedHash(parsed.pairs, botToken))) return { ok: false, reason: 'bad_hash' }
  const fields = new Map(parsed.pairs)
  const authDate = Number(fields.get('auth_date'))
  if (!Number.isFinite(authDate)) return { ok: false, reason: 'malformed' }
  if (now.getTime() / 1000 - authDate > INIT_DATA_MAX_AGE_SECONDS) return { ok: false, reason: 'expired' }
  const user = readUser(fields.get('user'))
  if (!user) return { ok: false, reason: 'malformed' }
  return { ok: true, user, startParam: fields.get('start_param') ?? null, authDate }
}

export type Screen = 'lb' | 'me' | 'bans' | 'appeal' | 'admin'

export function parseContext(startParam: string | null): { screen: Screen; chatId: number } | null {
  const match = /^(lb|me|bans|appeal|admin)_(-?\d{1,16})$/.exec(startParam ?? '')
  return match ? { screen: match[1] as Screen, chatId: Number(match[2]) } : null
}

export function buildContext(screen: Screen, chatId: number): string {
  return `${screen}_${chatId}`
}
