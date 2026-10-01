import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADMIN, CHAT, OTHER_CHAT, createHarness, seedMember, type Harness } from './support/harness.js'
import { TelegramError } from '../src/ports.js'
import { VECTORS } from './support/vectors.js'
import { makeWeb, seedWorld, type Web } from './support/web.js'

// Section 3.8: the Mini App opened without start_param (the "Open App" button of the bot profile) lists
// the chats of the member and works with the chat the client names; the signed start_param keeps priority.

let h: Harness
let web: Web

beforeEach(async () => {
  h = await createHarness()
  await seedWorld(h)
  web = await makeWeb(h)
})
afterEach(async () => {
  await h.close()
})

async function call(path: string, initData: string, chat?: number): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: `tma ${initData}` }
  if (chat !== undefined) headers['x-chat-id'] = String(chat)
  const response = await web.request(path, { headers })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

describe('GET /api/chats: the chats of the member, by the signed initData alone', () => {
  it('one chat', async () => {
    expect(await call('/api/chats', VECTORS.no_ctx)).toEqual({ status: 200, body: { chats: [{ chat_id: CHAT, title: 'Agents chat' }] } })
  })

  it('several chats, by title', async () => {
    expect(await call('/api/chats', VECTORS.alice_no_ctx)).toEqual({
      status: 200,
      body: { chats: [{ chat_id: CHAT, title: 'Agents chat' }, { chat_id: OTHER_CHAT, title: 'Other chat' }] },
    })
  })

  it('no chat at all', async () => {
    expect(await call('/api/chats', VECTORS.outsider_no_ctx)).toEqual({ status: 200, body: { chats: [] } })
  })

  it('needs a valid signature, not a chat context: a start_param of an unknown chat is no obstacle', async () => {
    expect((await call('/api/chats', VECTORS.outsider_unknown)).status).toBe(200)
    expect((await call('/api/chats', VECTORS.no_ctx.replace('Bob', 'Rob'))).status).toBe(401)
    expect((await web.request('/api/chats')).status).toBe(401)
  })
})

describe('a chat named by the client', () => {
  it('is accepted for a member of that chat', async () => {
    const { status, body } = await call('/api/leaderboard?period=all', VECTORS.alice_no_ctx, OTHER_CHAT)
    expect(status).toBe(200)
    expect((body.rows as Array<{ name: string }>).map((r) => r.name)).toEqual(['Alice', 'Erin'])
    expect((await call('/api/context', VECTORS.alice_no_ctx, OTHER_CHAT)).body).toMatchObject({ screen: 'lb', chat: { title: 'Other chat' } })
  })

  it('is refused with 403 for somebody who is not a member of it, or for a chat nobody knows', async () => {
    expect(await call('/api/leaderboard', VECTORS.no_ctx, OTHER_CHAT)).toEqual({ status: 403, body: { error: 'not_member' } })
    expect(await call('/api/leaderboard', VECTORS.no_ctx, -1005555555555)).toEqual({ status: 403, body: { error: 'not_member' } })
    expect(await call('/api/leaderboard', VECTORS.no_ctx, Number.NaN)).toEqual({ status: 403, body: { error: 'not_member' } })
  })

  it('is checked on every request: gone from the database and from the chat means 403', async () => {
    expect((await call('/api/me', VECTORS.no_ctx, CHAT)).status).toBe(200)
    await h.db.query('DELETE FROM members WHERE chat_id = $1 AND user_id = 2', [CHAT])
    h.tg.statusIn.set(`${CHAT}:2`, 'left')
    expect((await call('/api/me', VECTORS.no_ctx, CHAT)).status).toBe(403)
  })

  it('somebody who is in the chat by Telegram but never wrote (an owner posting as the channel, a reader) gets the chat', async () => {
    await h.db.query('DELETE FROM members WHERE chat_id = $1 AND user_id = 2', [CHAT])
    h.tg.statusIn.set(`${CHAT}:2`, 'creator')
    expect(await call('/api/chats', VECTORS.no_ctx)).toEqual({ status: 200, body: { chats: [{ chat_id: CHAT, title: 'Agents chat' }] } })
    expect((await call('/api/leaderboard', VECTORS.no_ctx, CHAT)).status).toBe(200)
    expect((await call('/api/context', VECTORS.no_ctx, CHAT)).body).toMatchObject({ screen: 'lb', viewer: { public_id: null, has_ban: false } })
  })

  it('kicked or left by Telegram and unknown to the database: no chat; a failing Telegram gives no access', async () => {
    await h.db.query('DELETE FROM members WHERE chat_id = $1 AND user_id = 2', [CHAT])
    h.tg.statusIn.set(`${CHAT}:2`, 'kicked')
    expect(await call('/api/chats', VECTORS.no_ctx)).toEqual({ status: 200, body: { chats: [] } })
    h.tg.statusIn.delete(`${CHAT}:2`)
    h.tg.fail('getChatMember', new TelegramError('server', 'down', 502), 5)
    expect((await call('/api/leaderboard', VECTORS.no_ctx, CHAT)).status).toBe(403)
  })

  it('without start_param and without a named chat: 400 no_context as before', async () => {
    expect(await call('/api/leaderboard', VECTORS.no_ctx)).toEqual({ status: 400, body: { error: 'no_context' } })
  })

  it('a named chat is taken only when initData has no start_param; an unknown or malformed one is refused', async () => {
    expect(await call('/api/leaderboard', VECTORS.bob_unknown_ctx, CHAT)).toEqual({ status: 404, body: { error: 'unknown_chat' } })
    expect(await call('/api/leaderboard', VECTORS.bob_bad_ctx, CHAT)).toEqual({ status: 400, body: { error: 'bad_context' } })
    expect((await call('/api/leaderboard', VECTORS.no_ctx, CHAT)).status).toBe(200)
  })

  it('the signed start_param keeps priority over the named chat', async () => {
    const { status, body } = await call('/api/context', VECTORS.bob_lb, OTHER_CHAT)
    expect(status).toBe(200)
    expect(body).toMatchObject({ chat: { title: 'Agents chat' } })
  })

  it('the admin screen with a named chat still needs a fresh administrator role, asked every time', async () => {
    await seedMember(h, ADMIN, 0, CHAT)
    h.tg.members.set(ADMIN.id, 'administrator')
    expect((await call('/api/admin/settings', VECTORS.admin_no_ctx, CHAT)).status).toBe(200)
    h.tg.members.set(ADMIN.id, 'member')
    expect(await call('/api/admin/settings', VECTORS.admin_no_ctx, CHAT)).toEqual({ status: 403, body: { error: 'forbidden' } })
    expect(h.tg.of('getChatMember').map((c) => c.args)).toEqual([[CHAT, ADMIN.id], [CHAT, ADMIN.id]])
  })
})
