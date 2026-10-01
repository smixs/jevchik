import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changeSetting,
  defaultValues,
  getSettings,
  getSettingsWithVersions,
  listAudit,
  loadDefaultQuestions,
  SCHEMA,
  SettingsError,
  validateInvariants,
  validateValue,
} from '../src/settings/settings.js'
import { DAY, ADMIN, CAROL, CHAT, botJoined, createHarness, message, pastObservation, type Harness } from './support/harness.js'
import { VECTORS } from './support/vectors.js'
import { get, makeWeb, send } from './support/web.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  await h.send(botJoined())
})
afterEach(async () => {
  await h.close()
})

const change = (key: string, value: unknown, base: number, actor = ADMIN.id) => changeSetting(h.db, { chatId: CHAT, key, value, baseVersion: base, actor, now: h.clock.now() })

describe('the settings schema', () => {
  it('is machine-readable and complete: every key has name, type, default, nullable and valid defaults', () => {
    expect(SCHEMA.keys.length).toBeGreaterThan(40)
    const names = SCHEMA.keys.map((k) => k.name)
    expect(new Set(names).size).toBe(names.length)
    for (const spec of SCHEMA.keys) {
      expect(typeof spec.name).toBe('string')
      expect(typeof spec.type).toBe('string')
      expect(typeof spec.nullable).toBe('boolean')
      expect('default' in spec).toBe(true)
      expect(validateValue(spec, spec.type === 'questions' ? loadDefaultQuestions() : spec.default), spec.name).toBeNull()
    }
    expect(validateInvariants(defaultValues())).toBeNull()
  })

  it('covers every parameter listed in sections 3.4 to 3.7', () => {
    const names = new Set(SCHEMA.keys.map((k) => k.name))
    for (const required of [
      'reactions_minus', 'reactions_ignore', 'base_reaction', 'base_reply', 'base_quote', 'base_dialog', 'base_thanks', 'base_minus',
      'report_author_delta', 'report_reporter_delta', 'usefulness_points', 'voter_scale', 'minus_daily_limit', 'minus_min_karma',
      'karma_lower_bound', 'silence_days', 'streak_bonus_per_week', 'streak_bonus_max', 'threshold_is_thanks', 'threshold_is_answer',
      'threshold_is_question', 'threshold_is_flood', 'threshold_media_fits', 'threshold_rude', 'previous_messages_count', 'react_min_level',
      'react_min_confidence', 'spam_auto_threshold', 'profile_auto_threshold', 'spam_review_delete_threshold', 'spam_review_threshold',
      'protect_threshold', 'import_days', 'timezone', 'observation_until', 'questions', 'dialog_window_hours', 'best_messages_limit',
    ]) expect(names.has(required), required).toBe(true)
  })

  it('the starting questions come from eval/questions.json', () => {
    const file = JSON.parse(readFileSync(new URL('../eval/questions.json', import.meta.url), 'utf8'))
    expect(defaultValues().questions).toEqual(file)
  })
})

describe('F20: versions and audit', () => {
  it('a change writes a new version and an audit record with who, when, key, old and new value', async () => {
    h.clock.set('2026-09-02T10:00:00Z')
    expect(await change('base_reply', 2.5, 0)).toEqual({ version: 1 })
    const rows = await h.db.query('SELECT key, version, value, changed_by FROM chat_settings')
    expect(rows).toEqual([{ key: 'base_reply', version: 1, value: 2.5, changed_by: ADMIN.id }])
    expect(await listAudit(h.db, CHAT)).toEqual([
      { key: 'base_reply', version: 1, old_value: 2, new_value: 2.5, changed_by: ADMIN.id, changed_at: new Date('2026-09-02T10:00:00Z') },
    ])
  })

  it('going back to the old value is an ordinary new change', async () => {
    await change('base_reply', 2.5, 0)
    await change('base_reply', 2, 1)
    const { values, versions } = await getSettingsWithVersions(h.db, CHAT)
    expect([values.base_reply, versions.base_reply]).toEqual([2, 2])
    const audit = await listAudit(h.db, CHAT)
    expect(audit.map((a) => [(a as { old_value: number }).old_value, (a as { new_value: number }).new_value])).toEqual([[2.5, 2], [2, 2.5]])
  })

  it('a new version acts only on operations started after it was written', async () => {
    await pastObservation(h)
    h.jev.script('Заработай 500 долларов в день', { spam_earnings_crypto: 0.9 })
    h.jev.failures.push(new Error('never used'))
    h.jev.failures.length = 0
    const { JevError } = await import('../src/ports.js')
    h.jev.failures.push(new JevError('transient', 'down'))
    await h.send(message({ id: 1, from: CAROL, text: 'Заработай 500 долларов в день' }))
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(0)
    await change('spam_auto_threshold', 0.99, 0)
    h.clock.advance(5000)
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
    await h.send(message({ id: 2, from: { id: 4, first_name: 'Dan' }, text: 'Заработай 500 долларов в день' }))
    await h.app.settle()
    expect(h.tg.count('restrictChatMember')).toBe(1)
    expect(h.tg.of('deleteMessage').map((c) => c.args[1])).toEqual([1])
    expect(await h.db.query(`SELECT kind, payload->>'messageId' AS id FROM admin_cards WHERE kind = 'review'`)).toEqual([{ kind: 'review', id: '2' }])
    expect((await getSettings(h.db, CHAT, 0)).num('spam_auto_threshold')).toBe(0.9)
    expect((await getSettings(h.db, CHAT)).num('spam_auto_threshold')).toBe(0.99)
  })

  it('a changed question set is used for later messages only', async () => {
    const questions = { ...loadDefaultQuestions() } as Record<string, Record<string, unknown>>
    questions.help_type = { ...questions.help_type, instructions: 'What kind of help is `message`, in one word' }
    await h.send(message({ id: 1, from: CAROL, text: 'первое' }))
    await change('questions', questions, 0)
    await h.send(message({ id: 2, from: CAROL, text: 'второе' }))
    await h.app.settle()
    expect((h.jev.requests[0].questions as Record<string, { instructions: string }>).help_type.instructions).toBe(loadDefaultQuestions().help_type.instructions)
    expect((h.jev.requests[1].questions as Record<string, { instructions: string }>).help_type.instructions).toBe('What kind of help is `message`, in one word')
  })
})

describe('settings failures', () => {
  it('T-settings-race: two administrators on the same version: one wins, the other sees a conflict', async () => {
    const results = await Promise.allSettled([change('base_reply', 3, 0, 1), change('base_reply', 4, 0, 2)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(SettingsError)
    expect((rejected.reason as SettingsError).code).toBe('conflict')
    expect(await h.db.query('SELECT 1 FROM settings_audit')).toHaveLength(1)
  })

  it('T-settings-invalid: unknown keys and values outside the schema are rejected before any write', async () => {
    const bad: Array<[string, unknown]> = [
      ['no_such_key', 1], ['base_reply', 'abc'], ['base_reply', 101], ['base_reply', -101], ['threshold_rude', 1.5], ['threshold_rude', -0.1],
      ['spam_auto_threshold', 2], ['silence_days', 0], ['silence_days', 367], ['silence_days', 1.5], ['steam_hours', 8785], ['timezone', 'Mars/Base'],
      ['usefulness_points', [0, 1]], ['usefulness_points', [0, 0, 0, 0, 999]], ['reactions_minus', 'x'], ['reactions_minus', [1]], ['questions', {}],
      ['questions', { a: { type: 'weird', instructions: 'x' } }], ['questions', { 'Bad Name': { type: 'noul', instructions: 'x' } }], ['base_reply', null],
      ['observation_until', 'tomorrow'], ['karma_lower_bound', 5], ['digest_hour', 24], ['import_days', 0], ['import_days', 367], ['import_days', 1.5], ['bot_reaction_emoji', ''],
    ]
    for (const [key, value] of bad) {
      await expect(change(key, value, 0), `${key}=${JSON.stringify(value)}`).rejects.toBeInstanceOf(SettingsError)
    }
    expect(await h.db.query('SELECT 1 FROM chat_settings')).toEqual([])
    expect(await h.db.query('SELECT 1 FROM settings_audit')).toEqual([])
  })

  it('mutual invariants: review <= review_delete <= auto', async () => {
    await expect(change('spam_review_threshold', 0.6, 0)).rejects.toThrow('violates')
    await expect(change('spam_auto_threshold', 0.4, 0)).rejects.toThrow('violates')
    await change('spam_review_delete_threshold', 0.6, 0)
    await expect(change('spam_review_threshold', 0.65, 0)).rejects.toThrow('violates')
    await change('spam_review_threshold', 0.6, 0)
    await expect(change('appeal_reject', 0.9, 0)).rejects.toThrow('violates')
    await expect(change('punish_mute_week_karma', -5, 0)).rejects.toThrow('violates')
  })

  it('nullable values: observation_until may be cleared', async () => {
    await change('observation_until', '2026-10-01T00:00:00Z', 0)
    await change('observation_until', null, 1)
    expect((await getSettings(h.db, CHAT)).raw('observation_until')).toBeNull()
  })

  it('T-settings-atomic: when the audit record cannot be written the setting is not written either', async () => {
    await h.db.query(`CREATE FUNCTION fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$ LANGUAGE plpgsql`)
    await h.db.query(`CREATE TRIGGER fail_audit BEFORE INSERT ON settings_audit FOR EACH ROW EXECUTE FUNCTION fail_audit()`)
    await expect(change('base_reply', 3, 0)).rejects.toThrow('audit down')
    expect(await h.db.query('SELECT 1 FROM chat_settings')).toEqual([])
    await h.db.query('DROP TRIGGER fail_audit ON settings_audit')
    expect(await change('base_reply', 3, 0)).toEqual({ version: 1 })
  })

  it('settings of one chat do not leak into another', async () => {
    await h.send(botJoined(-1009876543210))
    await change('base_reply', 3, 0)
    expect((await getSettings(h.db, -1009876543210)).num('base_reply')).toBe(2)
    expect(DAY).toBeGreaterThan(0)
  })
})

describe('settings through the API', () => {
  it('reads values, versions and the schema; writes with a version check; lists the audit', async () => {
    h.tg.members.set(ADMIN.id, 'administrator')
    const web = await makeWeb(h)
    const read = await (await get(web, '/api/admin/settings', VECTORS.admin_admin)).json()
    expect(read.values.base_reply).toBe(2)
    expect(read.versions.base_reply).toBe(0)
    expect(read.schema.keys.length).toBe(SCHEMA.keys.length)
    const ok = await send(web, 'PUT', '/api/admin/settings/base_reply', VECTORS.admin_admin, { value: 3, base_version: 0 })
    expect([ok.status, await ok.json()]).toEqual([200, { version: 1 }])
    const stale = await send(web, 'PUT', '/api/admin/settings/base_reply', VECTORS.admin_admin, { value: 4, base_version: 0 })
    expect([stale.status, (await stale.json()).error]).toEqual([409, 'conflict'])
    const invalid = await send(web, 'PUT', '/api/admin/settings/base_reply', VECTORS.admin_admin, { value: 500, base_version: 1 })
    expect([invalid.status, (await invalid.json()).field]).toEqual([422, 'base_reply'])
    const unknown = await send(web, 'PUT', '/api/admin/settings/nope', VECTORS.admin_admin, { value: 1, base_version: 0 })
    expect([unknown.status, (await unknown.json()).error]).toEqual([422, 'unknown_key'])
    const noBody = await send(web, 'PUT', '/api/admin/settings/base_reply', VECTORS.admin_admin, { value: 1 })
    expect(noBody.status).toBe(422)
    const audit = await (await get(web, '/api/admin/audit', VECTORS.admin_admin)).json()
    expect(audit.audit).toHaveLength(1)
    expect(audit.audit[0]).toMatchObject({ key: 'base_reply', old_value: 2, new_value: 3, changed_by: ADMIN.id })
  })

  it('a non-administrator cannot change anything', async () => {
    const web = await makeWeb(h)
    const denied = await send(web, 'PUT', '/api/admin/settings/base_reply', VECTORS.bob_admin, { value: 3, base_version: 0 })
    expect(denied.status).toBe(403)
    expect(await h.db.query('SELECT 1 FROM chat_settings')).toEqual([])
  })

  it('the observation can only be extended, and the extension is audited', async () => {
    h.tg.members.set(ADMIN.id, 'administrator')
    const web = await makeWeb(h)
    const early = await send(web, 'POST', '/api/admin/observation', VECTORS.admin_admin, { until: '2026-09-02T00:00:00Z' })
    expect(early.status).toBe(422)
    const late = await send(web, 'POST', '/api/admin/observation', VECTORS.admin_admin, { until: '2026-09-20T00:00:00Z' })
    expect(late.status).toBe(200)
    const state = await (await get(web, '/api/admin/observation', VECTORS.admin_admin)).json()
    expect(state).toEqual({ ends_at: '2026-09-20T00:00:00.000Z', active: true })
    expect((await listAudit(h.db, CHAT)).length).toBe(1)
    expect((await send(web, 'POST', '/api/admin/observation', VECTORS.admin_admin, { until: 'soon' })).status).toBe(422)
  })
})
