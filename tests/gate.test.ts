import { createHmac } from 'node:crypto'
import type { Update } from 'grammy/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KINDS, shapes, sprite } from '../src/gate-sprites.js'
import { buildReport, renderReport } from '../src/monitor.js'
import { changeSetting } from '../src/settings/settings.js'
import { tgError } from './support/fakes.js'
import { ADMIN, CHAT, chatOf, createHarness, pastObservation, type Harness } from './support/harness.js'
import { BOT_TOKEN } from './support/vectors.js'
import { get, makeWeb, send, type Web } from './support/web.js'

// Section 3.6.8 (decision of the owner 24.11): the frog on the door. Model: specs/tla/Gate.tla.

const DORA = { id: 501, is_bot: false, first_name: 'Dora' }
const EVE = { id: 502, is_bot: false, first_name: 'Eve' }
let h: Harness
let web: Web
let nextUpdate = 90_000

function joinRequest(options: { from?: typeof DORA; query?: string | null; userChatId?: number } = {}): Update {
  const from = options.from ?? DORA
  return {
    update_id: nextUpdate++,
    chat_join_request: {
      chat: { ...chatOf(CHAT), title: 'Agents chat' },
      from,
      user_chat_id: options.userChatId ?? from.id,
      date: Math.floor(h.clock.now().getTime() / 1000),
      ...(options.query === null ? {} : { query_id: options.query ?? `q-${from.id}-${nextUpdate}` }),
    },
  } as unknown as Update
}

function joined(user: typeof DORA): Update {
  return {
    update_id: nextUpdate++,
    chat_member: {
      chat: chatOf(CHAT),
      from: ADMIN,
      date: Math.floor(h.clock.now().getTime() / 1000),
      old_chat_member: { status: 'left', user },
      new_chat_member: { status: 'member', user },
      via_join_request: true,
    },
  } as unknown as Update
}

/** initData of a Mini App, signed with the test bot token the way Telegram signs it. */
function initData(user: { id: number; first_name: string }, extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(h.clock.now().getTime() / 1000)), user: JSON.stringify(user), ...extra }
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString()
}

function guardInit(user: typeof DORA, query: string): string {
  return initData(user, { chat: JSON.stringify({ id: CHAT, type: 'supergroup', title: 'Agents chat' }), chat_join_request_query_id: query })
}

async function door(user: typeof DORA = DORA, purpose = 'join') {
  return (await h.db.query(`SELECT * FROM gate_checks WHERE user_id = $1 AND purpose = $2 ORDER BY check_id DESC LIMIT 1`, [user.id, purpose]))[0]
}

const slotsOf = (check: Record<string, unknown>): string[] => (check.puzzle as { slots: string[] }).slots
const frogAt = (check: Record<string, unknown>) => slotsOf(check).indexOf('frog')
const missAt = (check: Record<string, unknown>) => slotsOf(check).findIndex((k) => k !== 'frog')

async function gateOn(minutes?: number): Promise<void> {
  await changeSetting(h.db, { chatId: CHAT, key: 'join_gate', value: true, baseVersion: 0, actor: ADMIN.id, now: h.clock.now() })
  if (minutes !== undefined) await changeSetting(h.db, { chatId: CHAT, key: 'join_gate_minutes', value: minutes, baseVersion: 0, actor: ADMIN.id, now: h.clock.now() })
}

/** A tap on the slot `index` of the layout `round` (0 the first, 1 after a miss). */
async function tap(init: string, index: number, token?: string, round = 0): Promise<Record<string, unknown>> {
  const response = await web.request('/api/door', {
    method: 'POST',
    headers: { authorization: `tma ${init}`, 'content-type': 'application/json', ...(token ? { 'x-door-token': token } : {}) },
    body: JSON.stringify({ pick: index, round }),
  })
  return (await response.json()) as Record<string, unknown>
}

async function look(init: string, token?: string): Promise<Record<string, unknown>> {
  const response = await web.request('/api/door', { headers: { authorization: `tma ${init}`, ...(token ? { 'x-door-token': token } : {}) } })
  return (await response.json()) as Record<string, unknown>
}

beforeEach(async () => {
  h = await createHarness()
  web = await makeWeb(h)
  await pastObservation(h)
  await h.db.query(`UPDATE chats SET title = 'Agents chat' WHERE chat_id = $1`, [CHAT])
  h.tg.calls.length = 0
})
afterEach(async () => {
  await h.close()
})

describe('F36: the door is off by default', () => {
  it('a guard query goes to the admins at once, a plain request is not touched, no check is written', async () => {
    await h.send(joinRequest({ query: 'q-off' }))
    await h.send(joinRequest({ from: EVE, query: null }))
    expect(h.tg.calls.map((c) => [c.method, ...c.args])).toEqual([['answerChatJoinRequestQuery', 'q-off', 'queue']])
    expect(await h.db.query('SELECT 1 FROM gate_checks')).toEqual([])
  })
})

describe('F36: the window', () => {
  beforeEach(async () => {
    await gateOn()
  })

  it('the guard shows the window within the update: one check, the window address carries no token', async () => {
    await h.send(joinRequest({ query: 'q-1' }))
    expect(h.tg.calls.map((c) => [c.method, ...c.args])).toEqual([['sendChatJoinRequestWebApp', 'q-1', 'https://jevchik.com/?door=guard']])
    const check = await door()
    expect({ status: check.status, via: check.via, query: check.query_id, send: check.send }).toEqual({ status: 'pending', via: 'guard', query: 'q-1', send: 'none' })
    expect([...check.puzzle.slots].sort()).toEqual([...KINDS].sort())
  })

  it('without the guard the private message gets a Mini App button with the token', async () => {
    await h.send(joinRequest({ query: null, userChatId: 7001 }))
    const check = await door()
    expect(h.tg.calls.map((c) => [c.method, ...c.args])).toEqual([
      [
        'sendMessage',
        7001,
        'Это Жевчик, охраняю дверь в «Agents chat». Спамеров тут хватает, поэтому один вопрос: тыкни в лягушонка, и я тебя пущу. На всё про всё есть несколько минут.',
        [[{ text: 'Открыть дверь 🐸', web_app: { url: `https://jevchik.com/?door=${check.token}` } }]],
      ],
    ])
    expect(check.via).toBe('dm')
    expect(check.token).toMatch(/^[0-9a-f]{32}$/)
  })

  it('a refused window falls back to the private message', async () => {
    h.tg.fail('sendChatJoinRequestWebApp', tgError.bad('QUERY_ID_INVALID'))
    await h.send(joinRequest({ query: 'q-2' }))
    expect(h.tg.calls.map((c) => c.method)).toEqual(['sendChatJoinRequestWebApp', 'sendMessage'])
    expect((await door()).via).toBe('dm')
  })

  it('neither window nor message: the request is left to the admins and the check is closed', async () => {
    h.tg.fail('sendChatJoinRequestWebApp', tgError.server())
    h.tg.fail('sendMessage', tgError.bad('Forbidden: bot can not initiate conversation', 403))
    await h.send(joinRequest({ query: 'q-3' }))
    expect(h.tg.calls.map((c) => [c.method, c.args[0], c.args[1]])).toEqual([
      ['sendChatJoinRequestWebApp', 'q-3', 'https://jevchik.com/?door=guard'],
      ['sendMessage', DORA.id, expect.any(String)],
      ['answerChatJoinRequestQuery', 'q-3', 'queue'],
    ])
    const check = await door()
    expect([check.status, check.reason, check.send]).toEqual(['gone', 'door_failed', 'none'])
  })

  it('the API gives cells and colours only: no name of an animal leaves the server', async () => {
    await h.send(joinRequest({ query: 'q-4' }))
    const view = await look(guardInit(DORA, 'q-4'))
    expect(view.state).toBe('open')
    expect(view.title).toBe('Agents chat')
    expect((view.puzzle as unknown[]).length).toBe(6)
    const text = JSON.stringify(view)
    for (const kind of KINDS) expect(text).not.toContain(kind)
  })

  it('every animal is 16x16 and paints only with its palette', () => {
    for (const kind of KINDS) {
      const rows = shapes()[kind]
      expect(rows.length).toBe(16)
      for (const row of rows) expect(row.length).toBe(16)
      const palette = Object.keys(sprite(kind, false, 0).palette)
      for (const letter of new Set(rows.join('').replaceAll('.', ''))) expect(palette).toContain(letter)
      expect(sprite(kind, true, 1).rows[3]).toBe([...rows[3]].reverse().join(''))
    }
  })
})

describe('F36: the frog decides', () => {
  beforeEach(async () => {
    await gateOn()
    await h.send(joinRequest({ query: 'q-10' }))
    h.tg.calls.length = 0
  })

  it('the frog: approved through the guard query at once, the send is closed', async () => {
    const view = await tap(guardInit(DORA, 'q-10'), frogAt(await door()))
    expect(view).toEqual({ state: 'passed', title: 'Agents chat' })
    expect(h.tg.calls.map((c) => [c.method, ...c.args])).toEqual([['answerChatJoinRequestQuery', 'q-10', 'approve']])
    expect(((await door()) as { send: string }).send).toBe('done')
    await h.app.settle()
    expect(h.tg.calls.length).toBe(1)
  })

  it('a miss reshuffles once, the second miss declines', async () => {
    const first = await tap(guardInit(DORA, 'q-10'), missAt(await door()))
    expect(first.state).toBe('open')
    expect(first.missed).toBe(true)
    expect(first.round).toBe(1)
    expect(h.tg.calls).toEqual([])
    const second = await tap(guardInit(DORA, 'q-10'), missAt(await door()), undefined, 1)
    expect(second).toEqual({ state: 'failed', title: 'Agents chat' })
    expect(h.tg.calls.map((c) => [c.method, ...c.args])).toEqual([['answerChatJoinRequestQuery', 'q-10', 'decline']])
    expect((await door()).reason).toBe('missed')
  })

  it('a tap made on the old layout after a miss (a second screen) spends nothing and shows the current layout', async () => {
    const before = await door()
    await tap(guardInit(DORA, 'q-10'), missAt(before))
    const shuffled = await door()
    const oldFrog = frogAt(before)
    // The second screen still shows the first layout; on the new one that slot may hold another animal.
    const view = await tap(guardInit(DORA, 'q-10'), oldFrog, undefined, 0)
    expect([view.state, view.round, view.missed]).toEqual(['open', 1, true])
    const after = await door()
    expect([after.status, after.misses, JSON.stringify(after.puzzle)]).toEqual(['pending', 1, JSON.stringify(shuffled.puzzle)])
    expect(h.tg.calls).toEqual([])
    expect((await tap(guardInit(DORA, 'q-10'), frogAt(after), undefined, 1)).state).toBe('passed')
  })

  it('two taps on the frog at once: one decision, one answer to Telegram', async () => {
    const at = frogAt(await door())
    await Promise.all([tap(guardInit(DORA, 'q-10'), at), tap(guardInit(DORA, 'q-10'), at)])
    expect(h.tg.of('answerChatJoinRequestQuery').map((c) => c.args)).toEqual([['q-10', 'approve']])
  })

  it('the guard query expired: the request itself is approved', async () => {
    h.tg.fail('answerChatJoinRequestQuery', tgError.bad('QUERY_ID_INVALID'))
    await tap(guardInit(DORA, 'q-10'), frogAt(await door()))
    expect(h.tg.calls.map((c) => [c.method, ...c.args])).toEqual([
      ['answerChatJoinRequestQuery', 'q-10', 'approve'],
      ['approveChatJoinRequest', CHAT, DORA.id],
    ])
    expect((await door()).send).toBe('done')
  })

  it('Telegram fails with 5xx: the window waits («letting», not «Пустил»), the bot repeats after the pause', async () => {
    h.tg.fail('answerChatJoinRequestQuery', tgError.server())
    expect((await tap(guardInit(DORA, 'q-10'), frogAt(await door()))).state).toBe('letting')
    expect((await door()).send).toBe('todo')
    const early = await buildReport(h.db, new Date(h.clock.now().getTime() + 1000))
    expect(early.chats.find((c) => c.chatId === CHAT)!.gate!.passed).toBe(0)
    await h.app.tick()
    expect(h.tg.count('answerChatJoinRequestQuery')).toBe(1)
    h.clock.advance(2_000)
    await h.app.tick()
    expect(h.tg.of('answerChatJoinRequestQuery').map((c) => c.args)).toEqual([
      ['q-10', 'approve'],
      ['q-10', 'approve'],
    ])
    expect((await door()).send).toBe('done')
    expect((await look(guardInit(DORA, 'q-10'))).state).toBe('passed')
  })

  it('Telegram refuses the approval for good: the window says so, the monitor does not count it as let in', async () => {
    h.tg.fail('answerChatJoinRequestQuery', tgError.bad('QUERY_ID_INVALID'))
    h.tg.fail('approveChatJoinRequest', tgError.bad('Bad Request: CHAT_ADMIN_REQUIRED'))
    expect((await tap(guardInit(DORA, 'q-10'), frogAt(await door()))).state).toBe('stuck')
    const report = await buildReport(h.db, new Date(h.clock.now().getTime() + 1000))
    const gate = report.chats.find((c) => c.chatId === CHAT)!.gate!
    expect([gate.passed, gate.sendFailed]).toEqual([0, 1])
  })

  it('the request is gone in Telegram: the send is closed without repeats', async () => {
    h.tg.fail('answerChatJoinRequestQuery', tgError.bad('QUERY_ID_INVALID'))
    h.tg.fail('approveChatJoinRequest', tgError.bad('Bad Request: HIDE_REQUESTER_MISSING'))
    await tap(guardInit(DORA, 'q-10'), frogAt(await door()))
    const check = await door()
    expect([check.send, check.send_note]).toEqual(['done', 'Bad Request: HIDE_REQUESTER_MISSING'])
    h.clock.advance(60_000)
    await h.app.settle()
    expect(h.tg.count('approveChatJoinRequest')).toBe(1)
  })

  it('a lease that ran out is taken over by the bot and closed once', async () => {
    await h.db.query(`UPDATE gate_checks SET status = 'passed', send = 'sending', send_until = $1, send_tries = 1, decided_at = $1`, [h.clock.now()])
    h.clock.advance(31_000)
    await h.app.tick()
    expect(h.tg.of('answerChatJoinRequestQuery').map((c) => c.args)).toEqual([['q-10', 'approve']])
    expect((await door()).send).toBe('done')
  })

  it('another user with the same query sees nothing', async () => {
    expect(await look(guardInit(EVE, 'q-10'))).toEqual({ state: 'unknown' })
    expect(await tap(guardInit(EVE, 'q-10'), 0)).toEqual({ state: 'unknown' })
    expect((await door()).status).toBe('pending')
  })

  it('a request without a signature is refused', async () => {
    const response = await get(web, '/api/door')
    expect(response.status).toBe(401)
    const forged = guardInit(DORA, 'q-10').replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64))
    expect((await send(web, 'POST', '/api/door', forged, { pick: 0, round: 0 })).status).toBe(401)
  })

  it('a slot outside the six or a tap without its layout is refused and spends nothing', async () => {
    expect((await send(web, 'POST', '/api/door', guardInit(DORA, 'q-10'), { pick: 6, round: 0 })).status).toBe(422)
    expect((await send(web, 'POST', '/api/door', guardInit(DORA, 'q-10'), { pick: '1', round: 0 })).status).toBe(422)
    expect((await send(web, 'POST', '/api/door', guardInit(DORA, 'q-10'), { pick: 1 })).status).toBe(422)
    expect((await send(web, 'POST', '/api/door', guardInit(DORA, 'q-10'), { pick: 1, round: 2 })).status).toBe(422)
    expect((await door()).misses).toBe(0)
  })
})

describe('F36: the private message path', () => {
  it('the token opens the door only for its own user', async () => {
    await gateOn()
    await h.send(joinRequest({ query: null }))
    const check = await door()
    expect(await look(initData(EVE), check.token)).toEqual({ state: 'unknown' })
    expect((await look(initData(DORA), check.token)).state).toBe('open')
    h.tg.calls.length = 0
    expect((await tap(initData(DORA), frogAt(check), check.token)).state).toBe('passed')
    expect(h.tg.calls.map((c) => [c.method, ...c.args])).toEqual([['approveChatJoinRequest', CHAT, DORA.id]])
  })
})

describe('F36: time, the daily limit and the admins', () => {
  it('silence for join_gate_minutes declines; one minute earlier nothing happens', async () => {
    await gateOn(5)
    await h.send(joinRequest({ query: 'q-20' }))
    h.tg.calls.length = 0
    h.clock.advance(4 * 60_000)
    await h.app.tick({ scheduled: true })
    expect((await door()).status).toBe('pending')
    h.clock.advance(61_000)
    await h.app.tick({ scheduled: true })
    expect((await door()).status).toBe('timeout')
    expect(h.tg.calls.map((c) => [c.method, ...c.args])).toEqual([['answerChatJoinRequestQuery', 'q-20', 'decline']])
    expect((await look(guardInit(DORA, 'q-20'))).state).toBe('timeout')
  })

  it('the time limit holds at the tap too: past it the frog does not let in, even before the tick', async () => {
    await gateOn(2)
    await h.send(joinRequest({ query: 'q-21' }))
    h.tg.calls.length = 0
    h.clock.advance(2 * 60_000 + 1000)
    expect((await tap(guardInit(DORA, 'q-21'), frogAt(await door()))).state).toBe('timeout')
    expect(h.tg.of('answerChatJoinRequestQuery')).toEqual([])
    await h.app.tick()
    expect(h.tg.of('answerChatJoinRequestQuery').map((c) => c.args)).toEqual([['q-21', 'decline']])
  })

  it('the fourth request in a day is declined without a window', async () => {
    await gateOn()
    for (const q of ['a', 'b', 'c']) {
      await h.send(joinRequest({ query: q }))
      await tap(guardInit(DORA, q), missAt(await door()))
      await tap(guardInit(DORA, q), missAt(await door()), undefined, 1)
    }
    h.tg.calls.length = 0
    await h.send(joinRequest({ query: 'd' }))
    // The guard gets the refusal within the update itself: its query lives 10 seconds, the tick may be later.
    expect(h.tg.calls.map((c) => [c.method, ...c.args])).toEqual([['answerChatJoinRequestQuery', 'd', 'decline']])
    expect([(await door()).status, (await door()).reason]).toEqual(['failed', 'daily_limit'])
    h.clock.advance(24 * 3600_000 + 1000)
    h.tg.calls.length = 0
    await h.send(joinRequest({ query: 'e' }))
    expect(h.tg.calls.map((c) => c.method)).toEqual(['sendChatJoinRequestWebApp'])
  })

  it('refusals of the limit do not prolong it: a day after the three windows the door opens again', async () => {
    await gateOn()
    for (const q of ['a', 'b', 'c']) {
      await h.send(joinRequest({ query: q }))
      await tap(guardInit(DORA, q), missAt(await door()))
      await tap(guardInit(DORA, q), missAt(await door()), undefined, 1)
    }
    for (const q of ['d', 'e', 'f']) {
      h.clock.advance(7 * 3600_000)
      await h.send(joinRequest({ query: q }))
      expect((await door()).reason).toBe('daily_limit')
    }
    h.clock.advance(3 * 3600_000 + 1000)
    h.tg.calls.length = 0
    await h.send(joinRequest({ query: 'g' }))
    expect(h.tg.calls.map((c) => c.method)).toEqual(['sendChatJoinRequestWebApp'])
  })

  it('an admin let the person in by hand: the check closes, the time limit sends nothing', async () => {
    await gateOn()
    await h.send(joinRequest({ query: 'q-30' }))
    await h.send(joined(DORA))
    expect([(await door()).status, (await door()).reason]).toEqual(['gone', 'joined'])
    h.tg.calls.length = 0
    h.clock.advance(11 * 60_000)
    await h.app.settle()
    expect(h.tg.of('answerChatJoinRequestQuery')).toEqual([])
    expect((await look(guardInit(DORA, 'q-30'))).state).toBe('gone')
  })

  it('a person let in stays a newcomer: the join is marked as seen', async () => {
    await gateOn()
    await h.send(joinRequest({ query: 'q-31' }))
    await tap(guardInit(DORA, 'q-31'), frogAt(await door()))
    await h.send(joined(DORA))
    expect((await h.db.query('SELECT joined_seen_at FROM members WHERE user_id = $1', [DORA.id]))[0].joined_seen_at).not.toBeNull()
    expect((await door()).status).toBe('passed')
  })
})

describe('F36: an old answer never reaches a newer request of the same person', () => {
  beforeEach(async () => {
    await gateOn()
    h.tg.fail('declineChatJoinRequest', tgError.server())
    await h.send(joinRequest({ query: null }))
    await tap(initData(DORA), missAt(await door()), (await door()).token)
    await tap(initData(DORA), missAt(await door()), (await door()).token, 1)
  })

  it('an unsent refusal is dropped when the person sends a new request', async () => {
    const old = await door()
    expect([old.status, old.send]).toEqual(['failed', 'todo'])
    await h.send(joinRequest({ query: null }))
    const fresh = await door()
    expect(fresh.status).toBe('pending')
    expect((await h.db.query('SELECT send, send_note FROM gate_checks WHERE check_id = $1', [old.check_id]))[0]).toEqual({ send: 'skipped', send_note: 'superseded' })
    h.clock.advance(10 * 60_000)
    await h.app.tick()
    expect(h.tg.count('declineChatJoinRequest')).toBe(1)
    expect((await door()).status).toBe('pending')
  })

  it('a refusal whose lease ran out is not sent by the pair once a newer request is there', async () => {
    const old = await door()
    await h.db.query(`UPDATE gate_checks SET send = 'sending', send_until = $2 WHERE check_id = $1`, [old.check_id, h.clock.now()])
    await h.send(joinRequest({ query: null }))
    h.clock.advance(31_000)
    await h.app.tick()
    expect(h.tg.count('declineChatJoinRequest')).toBe(1)
    expect((await h.db.query('SELECT send FROM gate_checks WHERE check_id = $1', [old.check_id]))[0].send).toBe('skipped')
  })
})

describe('F36: a window nobody opened', () => {
  beforeEach(async () => {
    await gateOn()
    await h.send(joinRequest({ query: 'q-40', userChatId: 7001 }))
    // The process stopped after the commit of the request and before the call: the window was never opened.
    await h.db.query(`UPDATE gate_checks SET door = 'todo'`)
    h.tg.calls.length = 0
  })

  it('the tick opens it in the private chat while the bot may still write first', async () => {
    h.clock.advance(16_000)
    await h.app.tick()
    expect(h.tg.calls.map((c) => [c.method, c.args[0]])).toEqual([['sendMessage', 7001]])
    expect([(await door()).door, (await door()).via]).toEqual(['open', 'dm'])
  })

  it('too late for the private chat: the request is left to the admins, nobody declines it', async () => {
    h.clock.advance(6 * 60_000)
    await h.app.tick()
    const check = await door()
    expect([check.status, check.reason, check.door, check.send]).toEqual(['gone', 'door_failed', 'lost', 'none'])
    h.clock.advance(20 * 60_000)
    await h.app.settle()
    expect(h.tg.calls).toEqual([])
  })

  it('an opening cut off in the middle: the silence of the window is not declined', async () => {
    await h.db.query(`UPDATE gate_checks SET door = 'opening'`)
    h.clock.advance(11 * 60_000)
    await h.app.tick({ scheduled: true })
    expect([(await door()).status, (await door()).door]).toEqual(['gone', 'lost'])
    await h.app.settle()
    expect(h.tg.calls).toEqual([])
  })
})

describe('F36: the monitor line', () => {
  it('counts what the door decided in the day', async () => {
    await gateOn()
    await h.send(joinRequest({ query: 'm1' }))
    await tap(guardInit(DORA, 'm1'), frogAt(await door()))
    await h.send(joinRequest({ from: EVE, query: 'm2' }))
    await tap(guardInit(EVE, 'm2'), missAt(await door(EVE)))
    await tap(guardInit(EVE, 'm2'), missAt(await door(EVE)), undefined, 1)
    const report = await buildReport(h.db, new Date(h.clock.now().getTime() + 1000))
    const chat = report.chats.find((c) => c.chatId === CHAT)!
    expect(chat.gate).toEqual({ passed: 1, missed: 1, timeout: 0, limit: 0, admins: 0, noWindow: 0, sendFailed: 0 })
    expect(renderReport(report)).toContain('Вход: пустил 1, отказ 1 (промах 1, молчал 0, лимит 0).')
  })

  it('a chat with the door off and nothing decided has no line', async () => {
    const report = await buildReport(h.db, h.clock.now())
    expect(report.chats.find((c) => c.chatId === CHAT)!.gate).toBeUndefined()
    expect(renderReport(report)).not.toContain('Вход:')
  })
})
