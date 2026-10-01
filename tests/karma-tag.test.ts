import type { Update } from 'grammy/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startImport } from '../src/import.js'
import { isObserving } from '../src/members.js'
import { changeSetting, getSettings, getSettingsWithVersions, SettingsError } from '../src/settings/settings.js'
import { tgError } from './support/fakes.js'
import { ADMIN, ALICE, BOB, CAROL, CHAT, DAY, T0, botJoined, chatOf, createHarness, karmaOf, message, reaction, setKarma, type Harness, type User } from './support/harness.js'
import { VECTORS } from './support/vectors.js'
import { makeWeb, send } from './support/web.js'

const DAVE: User = { id: 4, first_name: 'Dave' }
const EVE: User = { id: 5, first_name: 'Eve' }
const MIN = 60_000

let h: Harness
let logs: Array<{ event: string; fields?: Record<string, unknown> }>
beforeEach(async () => {
  h = await createHarness()
  logs = []
  h.ctx.log = { info: () => {}, warn: () => {}, error: (event, fields) => logs.push({ event, fields }) }
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  await h.send(botJoined())
  await h.send(message({ id: 1000, from: ALICE, text: 'полезное сообщение' }))
  await h.send(message({ id: 1001, from: BOB, text: 'привет' }))
  await h.app.settle()
  h.tg.calls.length = 0
})
afterEach(async () => {
  await h.close()
})

let roleUpdateId = 900_000
function role(user: User, status: string): Update {
  return {
    update_id: roleUpdateId++,
    chat_member: {
      chat: chatOf(CHAT),
      from: ADMIN,
      date: Math.floor(Date.parse(T0) / 1000),
      old_chat_member: { status: 'member', user: { ...user, is_bot: false } },
      new_chat_member: { status, user: { ...user, is_bot: false } },
    },
  } as unknown as Update
}

const tags = () => h.tg.of('setChatMemberTag').map((c) => c.args)
async function react(from: User, messageId = 1000, change: { old?: string[]; new?: string[] } = { new: ['👍'] }): Promise<void> {
  await h.send(reaction({ message_id: messageId, from, ...change }))
  await h.app.settle()
}
async function later(ms: number): Promise<void> {
  h.clock.advance(ms)
  await h.app.settle()
}
async function tagOps(): Promise<unknown[]> {
  return h.db.query(`SELECT (payload->>'userId')::bigint AS user_id, status, attempt_count, last_error_code FROM operations WHERE operation_kind = 'set_tag' ORDER BY operation_id`)
}
async function tagState(user: User): Promise<unknown> {
  return (await h.db.query('SELECT tag_text, tag_set_at, tag_exempt FROM members WHERE chat_id = $1 AND user_id = $2', [CHAT, user.id]))[0]
}
async function set(key: string, value: unknown): Promise<void> {
  const { versions } = await getSettingsWithVersions(h.db, CHAT)
  await changeSetting(h.db, { chatId: CHAT, key, value, baseVersion: versions[key], actor: ADMIN.id, now: h.clock.now() })
}

describe('F26: the member tag shows karma as a signed number', () => {
  it('a karma change of an ordinary member sets the tag through setChatMemberTag, also in observation mode', async () => {
    expect(await isObserving(h.db, CHAT, await getSettings(h.db, CHAT), h.clock.now())).toBe(true)
    await react(BOB)
    expect(await karmaOf(h, ALICE.id)).toBe(1.05)
    expect(tags()).toEqual([[CHAT, ALICE.id, '+1']])
    expect(await tagState(ALICE)).toEqual({ tag_text: '+1', tag_set_at: new Date(T0), tag_exempt: null })
    expect(await tagOps()).toEqual([{ user_id: ALICE.id, status: 'completed', attempt_count: 1, last_error_code: null }])
  })

  it('the same text is not set again when the whole karma does not change', async () => {
    await react(BOB)
    h.jev.script('ещё полезное', { usefulness: { score: 2, confidence: 0.9 } })
    await h.send(message({ id: 1002, from: ALICE, text: 'ещё полезное' }))
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(1.155)
    await later(30 * MIN)
    expect(tags()).toEqual([[CHAT, ALICE.id, '+1']])
    expect(await tagOps()).toHaveLength(1)
  })

  it('a positive karma reads +321, a negative one -12', async () => {
    await setKarma(h, ALICE.id, 320)
    await react(BOB)
    await setKarma(h, BOB.id, 5)
    await h.send(message({ id: 1003, from: CAROL, text: 'текст Карол' }))
    await setKarma(h, CAROL.id, -11.2)
    await react(BOB, 1003, { new: ['👎'] })
    expect(await karmaOf(h, CAROL.id)).toBe(-12.2488)
    expect(tags()).toEqual([
      [CHAT, ALICE.id, '+321'],
      [CHAT, CAROL.id, '-12'],
    ])
  })

  it('karma back at 0 after events reads 0; a member with karma 0 and no events gets no tag', async () => {
    await react(BOB)
    await later(MIN)
    await react(BOB, 1000, { old: ['👍'], new: [] })
    expect(await karmaOf(h, ALICE.id)).toBe(0)
    await later(10 * MIN)
    expect(tags()).toEqual([
      [CHAT, ALICE.id, '+1'],
      [CHAT, ALICE.id, '0'],
    ])
    expect(await karmaOf(h, BOB.id)).toBe(0)
    expect(tags().filter((args) => args[1] === BOB.id)).toEqual([])
  })

  it('administrators and the owner of the chat get no call; the tag follows the role again after it changes', async () => {
    await h.send(role(CAROL, 'administrator'))
    await h.send(role(DAVE, 'creator'))
    await h.send(message({ id: 1003, from: CAROL, text: 'текст Карол' }))
    await h.send(message({ id: 1004, from: DAVE, text: 'текст Дейва' }))
    await react(ALICE, 1003)
    await react(ALICE, 1004)
    await later(30 * MIN)
    expect(await karmaOf(h, CAROL.id)).toBe(1)
    expect(await karmaOf(h, DAVE.id)).toBe(1.05)
    expect(tags()).toEqual([])
    await h.send(role(CAROL, 'member'))
    await react(BOB, 1003)
    expect(tags()).toEqual([[CHAT, CAROL.id, '+2']])
  })

  it('a bot gets no call', async () => {
    await h.db.query('UPDATE members SET is_bot = true WHERE chat_id = $1 AND user_id = $2', [CHAT, ALICE.id])
    await react(BOB)
    await later(30 * MIN)
    expect(await karmaOf(h, ALICE.id)).toBe(1.05)
    expect(tags()).toEqual([])
  })

  it('the template of the setting wraps the number', async () => {
    await set('karma_tag_template', 'карма {n}')
    await react(BOB)
    expect(tags()).toEqual([[CHAT, ALICE.id, 'карма +1']])
  })

  it('with karma_tag_enabled = false no new tag is set and none is removed; switching it back on places the tags', async () => {
    await react(BOB)
    await set('karma_tag_enabled', false)
    await later(MIN)
    await react(CAROL)
    await later(30 * MIN)
    expect(tags()).toEqual([[CHAT, ALICE.id, '+1']])
    await set('karma_tag_enabled', true)
    await later(MIN)
    expect(tags()).toEqual([
      [CHAT, ALICE.id, '+1'],
      [CHAT, ALICE.id, '+2'],
    ])
    expect(tags().filter((args) => args[1] === BOB.id)).toEqual([])
  })
})

describe('a waiting tag operation reads karma_tag_enabled before the call', () => {
  it('switched off while the operation waits: it ends without a call', async () => {
    await react(BOB)
    await later(MIN)
    await react(CAROL)
    await set('karma_tag_enabled', false)
    await later(10 * MIN)
    expect(tags()).toEqual([[CHAT, ALICE.id, '+1']])
    expect(await tagOps()).toEqual([
      { user_id: ALICE.id, status: 'completed', attempt_count: 1, last_error_code: null },
      { user_id: ALICE.id, status: 'completed', attempt_count: 1, last_error_code: null },
    ])
    expect(await tagState(ALICE)).toEqual({ tag_text: '+1', tag_set_at: new Date(T0), tag_exempt: null })
  })
})

describe('T-tag-down: network, 5xx and 429 follow the general rule', () => {
  it('5xx is retried up to three attempts, then the operation is failed; the next karma change creates a new operation', async () => {
    h.tg.fail('setChatMemberTag', tgError.server(), 3)
    await react(BOB)
    await later(2_000)
    await later(4_000)
    await later(10 * MIN)
    expect(tags()).toEqual([
      [CHAT, ALICE.id, '+1'],
      [CHAT, ALICE.id, '+1'],
      [CHAT, ALICE.id, '+1'],
    ])
    expect(await tagOps()).toEqual([{ user_id: ALICE.id, status: 'failed', attempt_count: 3, last_error_code: 'server' }])
    expect(await karmaOf(h, ALICE.id)).toBe(1.05)
    expect(await tagState(ALICE)).toEqual({ tag_text: null, tag_set_at: null, tag_exempt: null })
    await react(CAROL)
    expect(tags()).toHaveLength(4)
    expect(tags()[3]).toEqual([CHAT, ALICE.id, '+2'])
    expect(await tagOps()).toEqual([
      { user_id: ALICE.id, status: 'failed', attempt_count: 3, last_error_code: 'server' },
      { user_id: ALICE.id, status: 'completed', attempt_count: 1, last_error_code: null },
    ])
  })

  it('429 waits retry_after, a network error is retried', async () => {
    h.tg.fail('setChatMemberTag', tgError.rate(30))
    h.tg.fail('setChatMemberTag', tgError.network())
    await react(BOB)
    await later(29_000)
    expect(tags()).toHaveLength(1)
    await later(1_000)
    expect(tags()).toHaveLength(2)
    await later(4_000)
    expect(tags()).toEqual([
      [CHAT, ALICE.id, '+1'],
      [CHAT, ALICE.id, '+1'],
      [CHAT, ALICE.id, '+1'],
    ])
    expect(await tagOps()).toEqual([{ user_id: ALICE.id, status: 'completed', attempt_count: 3, last_error_code: null }])
    expect(await tagState(ALICE)).toEqual({ tag_text: '+1', tag_set_at: new Date(Date.parse(T0) + 34_000), tag_exempt: null })
  })
})

describe('T-tag-denied: no right, an administrator target, a member who left', () => {
  const cases: Array<[string, Error, string]> = [
    ['no can_manage_tags right', tgError.bad('Bad Request: CHAT_ADMIN_REQUIRED'), 'no_rights'],
    ['no can_manage_tags right, in words', tgError.bad('Bad Request: not enough rights to manage tags'), 'no_rights'],
    ['the target is an administrator or the owner', tgError.bad('Bad Request: CHAT_CREATOR_REQUIRED'), 'target_admin'],
    ['the member left', tgError.bad('Bad Request: USER_NOT_PARTICIPANT'), 'member_gone'],
    ['the member is deactivated', tgError.bad('Forbidden: user is deactivated', 403), 'member_gone'],
    ['an emoji in the tag', tgError.bad('Bad Request: TAG_EMOJI_NOT_ALLOWED'), 'tag_denied'],
  ]
  for (const [name, error, code] of cases) {
    it(`${name}: no retry, no card, a journal entry, karma unchanged`, async () => {
      h.tg.fail('setChatMemberTag', error)
      await react(BOB)
      await later(30 * MIN)
      expect(tags()).toEqual([[CHAT, ALICE.id, '+1']])
      expect(await tagOps()).toEqual([{ user_id: ALICE.id, status: 'failed', attempt_count: 1, last_error_code: code }])
      expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([])
      expect(h.tg.count('sendMessage')).toBe(0)
      expect(logs).toContainEqual({ event: 'operation_not_completed', fields: expect.objectContaining({ kind: 'set_tag', status: 'failed', code }) })
      expect(await karmaOf(h, ALICE.id)).toBe(1.05)
    })
  }

  it('an administrator answer marks the member as not subject to a tag until the role changes', async () => {
    h.tg.fail('setChatMemberTag', tgError.bad('Bad Request: CHAT_CREATOR_REQUIRED'))
    await react(BOB)
    expect(await tagState(ALICE)).toEqual({ tag_text: null, tag_set_at: null, tag_exempt: 'target_admin' })
    await react(CAROL)
    await later(30 * MIN)
    expect(tags()).toHaveLength(1)
    expect(await tagOps()).toHaveLength(1)
    await h.send(role(ALICE, 'member'))
    await react(DAVE)
    expect(tags()).toEqual([
      [CHAT, ALICE.id, '+1'],
      [CHAT, ALICE.id, '+2'],
    ])
  })
})

describe('T-tag-burst: frequent karma changes of one member', () => {
  it('not more than one call per interval, with the karma at the moment of sending', async () => {
    await react(BOB)
    await later(MIN)
    await react(CAROL)
    await later(2 * MIN)
    await react(DAVE)
    await later(2 * MIN)
    await react(EVE)
    await later(4 * MIN)
    expect(tags()).toEqual([[CHAT, ALICE.id, '+1']])
    expect(await karmaOf(h, ALICE.id)).toBe(2.6104)
    await later(MIN)
    expect(tags()).toEqual([
      [CHAT, ALICE.id, '+1'],
      [CHAT, ALICE.id, '+3'],
    ])
    expect(await tagOps()).toEqual([
      { user_id: ALICE.id, status: 'completed', attempt_count: 1, last_error_code: null },
      { user_id: ALICE.id, status: 'completed', attempt_count: 1, last_error_code: null },
    ])
    expect(await tagState(ALICE)).toEqual({ tag_text: '+3', tag_set_at: new Date(Date.parse(T0) + 10 * MIN), tag_exempt: null })
  })

  it('a change that comes back to the set value before the interval ends sends nothing', async () => {
    await react(BOB)
    await later(MIN)
    await react(CAROL)
    await later(MIN)
    await react(CAROL, 1000, { old: ['👍'], new: [] })
    await later(30 * MIN)
    expect(tags()).toEqual([[CHAT, ALICE.id, '+1']])
  })

  it('the interval is a setting', async () => {
    await set('karma_tag_min_interval_minutes', 2)
    await react(BOB)
    await later(MIN)
    await react(CAROL)
    expect(tags()).toHaveLength(1)
    await later(MIN)
    expect(tags()).toEqual([
      [CHAT, ALICE.id, '+1'],
      [CHAT, ALICE.id, '+2'],
    ])
  })
})

describe('the first placement after an import goes through the same queue at 20 calls a minute', () => {
  it('members with karma events get their tag, a member without events does not', async () => {
    const at = new Date(h.clock.now().getTime() - DAY).toISOString()
    const users = Array.from({ length: 25 }, (_, i) => 100 + i)
    const messages = users.map((n, i) => ({ id: 5000 + i, type: 'message', from: `U${n}`, from_id: `user${n}`, text: `сообщение ${i}`, date_unixtime: String(Math.floor(Date.parse(at) / 1000) + i), reactions: [{ type: 'emoji', count: 1, emoji: '👍' }] }))
    messages.push({ id: 5100, type: 'message', from: 'Quiet', from_id: 'user200', text: 'без реакций', date_unixtime: String(Math.floor(Date.parse(at) / 1000) + 100), reactions: [] })
    const started = await startImport(h.ctx, CHAT, ADMIN.id, Buffer.from(JSON.stringify({ id: 1234567890, messages })))
    expect(started.ok).toBe(true)
    await h.app.settle()
    expect((await h.db.query('SELECT status FROM import_jobs'))[0].status).toBe('done')
    expect(await karmaOf(h, 100)).toBe(1.05)
    expect(tags()).toEqual(users.slice(0, 20).map((id) => [CHAT, id, '+1']))
    await later(59_000)
    expect(tags()).toHaveLength(20)
    await later(1_000)
    expect(tags()).toEqual(users.map((id) => [CHAT, id, '+1']))
    expect(tags().filter((args) => args[1] === 200)).toEqual([])
  })
})

describe('a failed placement after an import', () => {
  it('leaves the import done, is logged, and the first-placement pass catches up', async () => {
    await h.db.query('CREATE SEQUENCE tag_boom')
    await h.db.query(
      `CREATE FUNCTION tag_boom() RETURNS trigger AS $$ BEGIN
         IF NEW.operation_kind = 'set_tag' AND nextval('tag_boom') = 1 THEN RAISE EXCEPTION 'placement down'; END IF;
         RETURN NEW; END $$ LANGUAGE plpgsql`,
    )
    await h.db.query('CREATE TRIGGER tag_boom BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION tag_boom()')
    const at = Math.floor((h.clock.now().getTime() - DAY) / 1000)
    const messages = [100, 101, 102].map((n, i) => ({ id: 6000 + i, type: 'message', from: `U${n}`, from_id: `user${n}`, text: `сообщение ${i}`, date_unixtime: String(at + i), reactions: [{ type: 'emoji', count: 1, emoji: '👍' }] }))
    const started = await startImport(h.ctx, CHAT, ADMIN.id, Buffer.from(JSON.stringify({ id: 1234567890, messages })))
    if (!started.ok) throw new Error(started.error)
    await h.app.settle()
    expect(await h.db.query('SELECT status, error FROM import_jobs')).toEqual([{ status: 'done', error: null }])
    expect(logs).toContainEqual({ event: 'tag_placement_failed', fields: { chat_id: CHAT, job_id: started.jobId, error: expect.stringContaining('placement down') } })
    expect(tags()).toEqual([
      [CHAT, 100, '+1'],
      [CHAT, 101, '+1'],
      [CHAT, 102, '+1'],
    ])
  })
})

describe('karma_tag_template is checked by the schema', () => {
  const change = (value: unknown) => changeSetting(h.db, { chatId: CHAT, key: 'karma_tag_template', value, baseVersion: 0, actor: ADMIN.id, now: h.clock.now() })

  it('accepts {n} and a short wrapper, the result for a six-digit karma fits in 16', async () => {
    const { values } = await getSettingsWithVersions(h.db, CHAT)
    expect([values.karma_tag_enabled, values.karma_tag_template, values.karma_tag_min_interval_minutes]).toEqual([true, '{n}', 10])
    expect(await change('карма {n}')).toEqual({ version: 1 })
    expect(await changeSetting(h.db, { chatId: CHAT, key: 'karma_tag_template', value: 'кармочка {n}', baseVersion: 1, actor: ADMIN.id, now: h.clock.now() })).toEqual({ version: 2 })
  })

  for (const [name, value] of [
    ['without {n}', 'карма'],
    ['with an emoji', '🔥 {n}'],
    ['with a keycap emoji', '1️⃣ {n}'],
    ['too long for a six-digit karma', 'кармочки: {n}'],
    ['not a string', 5],
    ['null', null],
  ] as Array<[string, unknown]>) {
    it(`rejects a template ${name}`, async () => {
      await expect(change(value)).rejects.toBeInstanceOf(SettingsError)
      expect(await h.db.query(`SELECT 1 FROM chat_settings WHERE key = 'karma_tag_template'`)).toEqual([])
    })
  }

  it('the interval and the switch follow the general rules', async () => {
    const bad = (key: string, value: unknown) => expect(changeSetting(h.db, { chatId: CHAT, key, value, baseVersion: 0, actor: ADMIN.id, now: h.clock.now() })).rejects.toBeInstanceOf(SettingsError)
    await bad('karma_tag_min_interval_minutes', 0)
    await bad('karma_tag_min_interval_minutes', 1.5)
    await bad('karma_tag_min_interval_minutes', 366 * 24 * 60 + 1)
    await bad('karma_tag_enabled', 'yes')
  })

  it('the admin screen shows the new keys and rejects a bad template with a field error', async () => {
    h.tg.members.set(ADMIN.id, 'administrator')
    const web = await makeWeb(h)
    const read = await (await web.request('/api/admin/settings', { headers: { authorization: `tma ${VECTORS.admin_admin}` } })).json()
    const names = read.schema.keys.map((k: { name: string }) => k.name)
    expect(names).toEqual(expect.arrayContaining(['karma_tag_enabled', 'karma_tag_template', 'karma_tag_min_interval_minutes']))
    const invalid = await send(web, 'PUT', '/api/admin/settings/karma_tag_template', VECTORS.admin_admin, { value: '🔥 {n}', base_version: 0 })
    expect([invalid.status, (await invalid.json()).field]).toEqual([422, 'karma_tag_template'])
    const ok = await send(web, 'PUT', '/api/admin/settings/karma_tag_template', VECTORS.admin_admin, { value: 'карма {n}', base_version: 0 })
    expect(ok.status).toBe(200)
  })
})

describe('a tag set by a person is not overwritten: the member is read first', () => {
  const reads = () => h.tg.of('getChatMember').map((c) => c.args)

  it('the tag in Telegram already equals the text: no call, the text and time are stored', async () => {
    h.tg.tags.set(ALICE.id, '+1')
    await react(BOB)
    expect(reads()).toEqual([[CHAT, ALICE.id]])
    expect(tags()).toEqual([])
    expect(await tagState(ALICE)).toEqual({ tag_text: '+1', tag_set_at: new Date(T0), tag_exempt: null })
    expect(await tagOps()).toEqual([{ user_id: ALICE.id, status: 'completed', attempt_count: 1, last_error_code: null }])
    await later(MIN)
    await react(CAROL)
    await later(10 * MIN)
    expect(tags()).toEqual([[CHAT, ALICE.id, '+2']])
  })

  it('an empty tag, the last stored tag and a tag of the karma form are replaced', async () => {
    h.tg.tags.set(ALICE.id, '+7')
    await react(BOB)
    expect(tags()).toEqual([[CHAT, ALICE.id, '+1']])
    await set('karma_tag_template', 'карма {n}')
    h.tg.tags.set(ALICE.id, 'карма -3')
    await later(10 * MIN)
    await react(CAROL)
    expect(tags()).toEqual([
      [CHAT, ALICE.id, '+1'],
      [CHAT, ALICE.id, 'карма +2'],
    ])
    expect(await tagState(ALICE)).toEqual({ tag_text: 'карма +2', tag_set_at: new Date(Date.parse(T0) + 10 * MIN), tag_exempt: null })
  })

  it('a tag a person set: no call, the member is marked human_tag, a journal entry, no card', async () => {
    h.tg.tags.set(ALICE.id, 'модератор')
    await react(BOB)
    expect(tags()).toEqual([])
    expect(await tagOps()).toEqual([{ user_id: ALICE.id, status: 'failed', attempt_count: 1, last_error_code: 'human_tag' }])
    expect(await tagState(ALICE)).toEqual({ tag_text: null, tag_set_at: null, tag_exempt: 'human_tag' })
    expect(logs).toContainEqual({ event: 'operation_not_completed', fields: expect.objectContaining({ kind: 'set_tag', status: 'failed', code: 'human_tag' }) })
    expect(await h.db.query('SELECT kind FROM admin_cards')).toEqual([])
    await later(MIN)
    await react(CAROL)
    await later(30 * MIN)
    expect(await tagOps()).toHaveLength(1)
    expect(h.tg.tags.get(ALICE.id)).toBe('модератор')
  })

  it('an administrator or the owner in the same answer: no call, marked as before', async () => {
    h.tg.members.set(ALICE.id, 'creator')
    await react(BOB)
    expect(tags()).toEqual([])
    expect(await tagOps()).toEqual([{ user_id: ALICE.id, status: 'failed', attempt_count: 1, last_error_code: 'target_admin' }])
    expect(await tagState(ALICE)).toEqual({ tag_text: null, tag_set_at: null, tag_exempt: 'target_admin' })
  })

  it('a temporary read error is retried by the general rule, a permanent one ends like T-tag-denied', async () => {
    h.tg.fail('getChatMember', tgError.server())
    await react(BOB)
    expect(tags()).toEqual([])
    await later(2_000)
    expect(tags()).toEqual([[CHAT, ALICE.id, '+1']])
    h.tg.fail('getChatMember', tgError.bad('Bad Request: USER_NOT_PARTICIPANT'))
    await later(10 * MIN)
    await react(CAROL)
    await later(30 * MIN)
    expect(tags()).toHaveLength(1)
    expect((await tagOps())[1]).toEqual({ user_id: ALICE.id, status: 'failed', attempt_count: 1, last_error_code: 'member_gone' })
  })
})
