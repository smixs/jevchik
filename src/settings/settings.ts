import { readFileSync } from 'node:fs'
import type { Db, Q } from '../db.js'
import { hasEmoji, karmaTag } from '../text.js'
import schemaFile from './schema.json' with { type: 'json' }

export interface KeySpec {
  name: string
  type: 'number' | 'integer' | 'string' | 'boolean' | 'string_array' | 'number_array' | 'timestamp' | 'timezone' | 'questions'
  default: unknown
  nullable: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  maxItems?: number
  length?: number
  format?: 'karma_tag'
  items?: { type: string; minimum?: number; maximum?: number; minLength?: number; maxLength?: number }
}

export const SCHEMA = schemaFile as { version: number; keys: KeySpec[]; invariants: string[] }
const SPECS = new Map(SCHEMA.keys.map((spec) => [spec.name, spec]))

export type QuestionSet = Record<string, Record<string, unknown>>

let defaultQuestions: QuestionSet | null = null

export function loadDefaultQuestions(): QuestionSet {
  defaultQuestions ??= JSON.parse(readFileSync(new URL('../../eval/questions.json', import.meta.url), 'utf8')) as QuestionSet
  return defaultQuestions
}

function defaultValue(spec: KeySpec): unknown {
  return spec.type === 'questions' ? loadDefaultQuestions() : spec.default
}

export class SettingsError extends Error {
  constructor(
    public readonly code: 'unknown_key' | 'invalid' | 'conflict',
    public readonly field: string,
    message: string,
  ) {
    super(message)
    this.name = 'SettingsError'
  }
}

export class SettingsView {
  constructor(private readonly values: Record<string, unknown>) {}

  num(key: string): number {
    return this.values[key] as number
  }

  str(key: string): string {
    return this.values[key] as string
  }

  bool(key: string): boolean {
    return this.values[key] as boolean
  }

  list<T = string>(key: string): T[] {
    return this.values[key] as T[]
  }

  raw(key: string): unknown {
    return this.values[key]
  }

  questions(): QuestionSet {
    return this.values.questions as QuestionSet
  }

  all(): Record<string, unknown> {
    return { ...this.values }
  }
}

function checkNumber(spec: KeySpec, value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number'
  if (spec.type === 'integer' && !Number.isInteger(value)) return 'must be an integer'
  if (spec.minimum !== undefined && value < spec.minimum) return `must be >= ${spec.minimum}`
  if (spec.maximum !== undefined && value > spec.maximum) return `must be <= ${spec.maximum}`
  return null
}

function checkString(spec: { minLength?: number; maxLength?: number }, value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string'
  if (spec.minLength !== undefined && value.length < spec.minLength) return 'too short'
  if (spec.maxLength !== undefined && value.length > spec.maxLength) return 'too long'
  return null
}

/** Section 3.12: the template contains {n}, has no emoji, and the tag for a six-digit karma is at most 16 characters. */
const TAG_MAX_LENGTH = 16
const SIX_DIGITS = 999_999

function checkTagTemplate(value: string): string | null {
  if (!value.includes('{n}')) return 'must contain {n}'
  if (hasEmoji(value)) return 'emoji are not allowed'
  if (karmaTag(value, -SIX_DIGITS).length > TAG_MAX_LENGTH) return `the tag for a six-digit karma must be at most ${TAG_MAX_LENGTH} characters`
  return null
}

function checkStringKey(spec: KeySpec, value: unknown): string | null {
  const problem = checkString(spec, value)
  if (problem || spec.format !== 'karma_tag') return problem
  return checkTagTemplate(value as string)
}

function checkArray(spec: KeySpec, value: unknown): string | null {
  if (!Array.isArray(value)) return 'must be an array'
  if (spec.length !== undefined && value.length !== spec.length) return `must have ${spec.length} items`
  if (spec.maxItems !== undefined && value.length > spec.maxItems) return 'too many items'
  const itemSpec = { ...spec.items, name: 'item', default: null, nullable: false } as KeySpec
  for (const item of value) {
    const problem = spec.type === 'string_array' ? checkString(itemSpec, item) : checkNumber({ ...itemSpec, type: 'number' }, item)
    if (problem) return `item: ${problem}`
  }
  return null
}

function checkQuestion(name: string, question: unknown): string | null {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) return `bad question name ${name}`
  if (typeof question !== 'object' || question === null) return `question ${name} must be an object`
  const q = question as Record<string, unknown>
  if (!['noul', 'score', 'choice'].includes(q.type as string)) return `question ${name}: bad type`
  if (typeof q.instructions !== 'string' || !q.instructions) return `question ${name}: instructions required`
  return null
}

function checkNormative(value: Record<string, unknown>): string | null {
  for (const [name, spec] of Object.entries(loadDefaultQuestions())) {
    const given = value[name] as { type?: unknown } | undefined
    if (!given) return `normative question ${name} is required`
    if (given.type !== spec.type) return `question ${name}: type must be ${String(spec.type)}`
  }
  return null
}

function checkQuestions(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'must be an object'
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > 100) return 'must have 1..100 questions'
  for (const [name, question] of entries) {
    const problem = checkQuestion(name, question)
    if (problem) return problem
  }
  return checkNormative(value as Record<string, unknown>)
}

function checkTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return 'must be an ISO timestamp'
  return null
}

function checkTimezone(value: unknown): string | null {
  if (typeof value !== 'string') return 'must be a string'
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return null
  } catch {
    return 'unknown timezone'
  }
}

const VALIDATORS: Record<KeySpec['type'], (spec: KeySpec, value: unknown) => string | null> = {
  number: checkNumber,
  integer: checkNumber,
  string: checkStringKey,
  boolean: (_spec, value) => (typeof value === 'boolean' ? null : 'must be a boolean'),
  string_array: checkArray,
  number_array: checkArray,
  timestamp: (_spec, value) => checkTimestamp(value),
  timezone: (_spec, value) => checkTimezone(value),
  questions: (_spec, value) => checkQuestions(value),
}

export function validateValue(spec: KeySpec, value: unknown): string | null {
  if (value === null) return spec.nullable ? null : 'must not be null'
  return VALIDATORS[spec.type](spec, value)
}

const INVARIANT = /^(\w+) <= (\w+)$/

export function validateInvariants(values: Record<string, unknown>): string | null {
  for (const rule of SCHEMA.invariants) {
    const match = INVARIANT.exec(rule)
    if (!match) continue
    if ((values[match[1]] as number) > (values[match[2]] as number)) return rule
  }
  return null
}

export function defaultValues(): Record<string, unknown> {
  return Object.fromEntries(SCHEMA.keys.map((spec) => [spec.name, defaultValue(spec)]))
}

interface SettingRow {
  key: string
  version: number
  value: unknown
}

async function latestRows(q: Q, chatId: number, asOfSeq: number | null): Promise<SettingRow[]> {
  return q.query<SettingRow>(
    `SELECT DISTINCT ON (key) key, version, value FROM chat_settings
     WHERE chat_id = $1 AND ($2::bigint IS NULL OR seq <= $2)
     ORDER BY key, version DESC`,
    [chatId, asOfSeq],
  )
}

export async function getSettings(q: Q, chatId: number, asOfSeq: number | null = null): Promise<SettingsView> {
  const values = defaultValues()
  for (const row of await latestRows(q, chatId, asOfSeq)) values[row.key] = row.value
  return new SettingsView(values)
}

export async function getSettingsWithVersions(
  q: Q,
  chatId: number,
): Promise<{ values: Record<string, unknown>; versions: Record<string, number> }> {
  const values = defaultValues()
  const versions: Record<string, number> = Object.fromEntries(SCHEMA.keys.map((spec) => [spec.name, 0]))
  for (const row of await latestRows(q, chatId, null)) {
    values[row.key] = row.value
    versions[row.key] = row.version
  }
  return { values, versions }
}

export interface ChangeRequest {
  chatId: number
  key: string
  value: unknown
  baseVersion: number
  actor: number
  now: Date
}

export async function changeSetting(db: Db, request: ChangeRequest): Promise<{ version: number }> {
  const spec = SPECS.get(request.key)
  if (!spec) throw new SettingsError('unknown_key', request.key, `unknown key ${request.key}`)
  const problem = validateValue(spec, request.value)
  if (problem) throw new SettingsError('invalid', request.key, problem)
  return db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`settings:${request.chatId}`])
    const { values, versions } = await getSettingsWithVersions(q, request.chatId)
    if (versions[request.key] !== request.baseVersion) {
      throw new SettingsError('conflict', request.key, `current version is ${versions[request.key]}`)
    }
    const candidate = { ...values, [request.key]: request.value }
    const broken = validateInvariants(candidate)
    if (broken) throw new SettingsError('invalid', request.key, `violates ${broken}`)
    const version = request.baseVersion + 1
    await q.query('INSERT INTO chat_settings (chat_id, key, version, value, changed_by, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [
      request.chatId,
      request.key,
      version,
      JSON.stringify(request.value),
      request.actor,
      request.now,
    ])
    await q.query(
      `INSERT INTO settings_audit (chat_id, key, version, old_value, new_value, changed_by, changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [request.chatId, request.key, version, JSON.stringify(values[request.key]), JSON.stringify(request.value), request.actor, request.now],
    )
    return { version }
  })
}

export async function listAudit(q: Q, chatId: number, limit = 100): Promise<unknown[]> {
  return q.query(
    `SELECT key, version, old_value, new_value, changed_by, changed_at FROM settings_audit
     WHERE chat_id = $1 ORDER BY audit_id DESC LIMIT $2`,
    [chatId, limit],
  )
}
