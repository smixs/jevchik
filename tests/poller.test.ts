import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALLOWED_UPDATES, GrammyTelegram, mapError } from '../src/adapters/telegram.js'
import { runPoller, pollOnce } from '../src/poller.js'
import { TelegramError } from '../src/ports.js'
import type { App } from '../src/app.js'
import { tgError } from './support/fakes.js'
import { fakeServer, reply } from './support/http.js'
import { ALICE, CHAT, createHarness, karmaOf, message, reaction, type Harness } from './support/harness.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
})
afterEach(async () => {
  await h.close()
})

describe('T-poll and T-dup-update', () => {
  it('network, 5xx and 409 errors are retried with a growing pause; the offset moves only after the database write', async () => {
    const u1 = message({ id: 1, text: 'первое' })
    const u2 = message({ id: 2, text: 'второе' })
    h.tg.updates = [u1, u2]
    h.tg.fail('getUpdates', tgError.network())
    h.tg.fail('getUpdates', tgError.server())
    h.tg.fail('getUpdates', tgError.bad('Conflict: terminated by other getUpdates request', 409))
    const abort = new AbortController()
    const seen: number[] = []
    const app: App = {
      ...h.app,
      handle: async (update) => {
        await h.app.handle(update)
        seen.push(update.update_id)
        if (seen.length === 2) abort.abort()
      },
    }
    const start = h.clock.now().getTime()
    await runPoller(h.ctx, app, abort.signal)
    expect(h.clock.now().getTime() - start).toBe(1000 + 2000 + 5000)
    expect(seen).toEqual([u1.update_id, u2.update_id])
    expect((await h.db.query(`SELECT value FROM kv WHERE key = 'poll_offset'`))[0].value).toBe(u2.update_id + 1)
    expect(await h.db.query('SELECT message_id FROM messages ORDER BY message_id')).toEqual([{ message_id: 1 }, { message_id: 2 }])
  })

  it('a failing write stops the batch: the failed update is not acknowledged and is delivered again', async () => {
    const u1 = message({ id: 1, text: 'первое' })
    const u2 = message({ id: 2, text: 'второе' })
    const u3 = message({ id: 3, text: 'третье' })
    h.tg.updates = [u1, u2, u3]
    let failing = true
    const app: App = {
      ...h.app,
      handle: async (update) => {
        if (failing && update.update_id === u2.update_id) throw new Error('db down')
        await h.app.handle(update)
      },
    }
    const first = await pollOnce(h.ctx, app, u1.update_id)
    expect(first).toEqual({ offset: u2.update_id, ok: false })
    failing = false
    const second = await pollOnce(h.ctx, app, first.offset)
    expect(second).toEqual({ offset: u3.update_id + 1, ok: true })
    expect((await h.db.query('SELECT message_id FROM messages ORDER BY message_id')).map((r) => r.message_id)).toEqual([1, 2, 3])
  })

  it('a re-delivered batch is harmless', async () => {
    const updates = [message({ id: 1, text: 'привет' }), message({ id: 2, from: { id: 2, first_name: 'Bob' }, text: 'ответ' })]
    h.tg.updates = updates
    await pollOnce(h.ctx, h.app, 0)
    await pollOnce(h.ctx, h.app, 0)
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(2)
    expect(await h.db.query('SELECT 1 FROM evaluations')).toHaveLength(2)
  })

  it('T-dup-update: the same reaction update twice changes karma once', async () => {
    await h.send(message({ id: 1000, from: ALICE, text: 'полезное сообщение' }))
    await h.app.settle()
    const update = reaction({ message_id: 1000, new: ['👍'] })
    await h.send(update)
    await h.send(update)
    expect(await karmaOf(h, ALICE.id)).toBeCloseTo(1.05, 4)
    expect(CHAT).toBeLessThan(0)
  })
})

describe('the Telegram adapter on the wire', () => {
  it('asks for exactly the allowed updates of section 3.2', () => {
    expect([...ALLOWED_UPDATES]).toEqual(['message', 'edited_message', 'message_reaction', 'message_reaction_count', 'chat_member', 'my_chat_member', 'callback_query'])
  })

  it('sends getUpdates with long polling and allowed_updates, restrict with independent permissions, reactions as emoji', async () => {
    const server = await fakeServer((seen, _i, res) => reply(res, 200, { ok: true, result: seen.url?.endsWith('/getUpdates') ? [] : true }))
    const api = new GrammyTelegram('TOKEN', server.url)
    await api.getUpdates(42, 30)
    await api.restrictChatMember(-100, 5, { can_send_messages: true, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false }, 1800000000)
    await api.setMessageReaction(-100, 7, '🔥')
    await api.unbanChatMember(-100, 5)
    await api.sendMessage(-100, 'привет', { buttons: [[{ text: 'Открыть', url: 'https://t.me/x?startapp=lb_-100' }]] })
    await server.close()
    const calls = server.seen.map((s) => [s.url, JSON.parse(s.body)])
    expect(calls[0]).toEqual(['/botTOKEN/getUpdates', { offset: 42, timeout: 30, allowed_updates: [...ALLOWED_UPDATES] }])
    expect(calls[1]).toEqual([
      '/botTOKEN/restrictChatMember',
      {
        chat_id: -100, user_id: 5, until_date: 1800000000, use_independent_chat_permissions: true,
        permissions: { can_send_messages: true, can_send_audios: false, can_send_documents: false, can_send_photos: false, can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false, can_add_web_page_previews: false },
      },
    ])
    expect(calls[2]).toEqual(['/botTOKEN/setMessageReaction', { chat_id: -100, message_id: 7, reaction: [{ type: 'emoji', emoji: '🔥' }] }])
    expect(calls[3]).toEqual(['/botTOKEN/unbanChatMember', { chat_id: -100, user_id: 5, only_if_banned: true }])
    expect(calls[4]).toEqual([
      '/botTOKEN/sendMessage',
      { chat_id: -100, text: 'привет', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'Открыть', url: 'https://t.me/x?startapp=lb_-100' }]] } },
    ])
  })

  it('maps HTTP errors to the kinds the retry rules use', async () => {
    const answers = [
      { code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } },
      { code: 502, description: 'Bad Gateway' },
      { code: 400, description: 'Bad Request: message to delete not found' },
      { code: 403, description: 'Forbidden: bot was kicked' },
      { code: 409, description: 'Conflict: terminated by other getUpdates request' },
    ]
    const server = await fakeServer((_s, i, res) => reply(res, answers[i].code, { ok: false, error_code: answers[i].code, description: answers[i].description, parameters: answers[i].parameters }))
    const api = new GrammyTelegram('TOKEN', server.url)
    const errors: TelegramError[] = []
    for (let i = 0; i < answers.length; i++) errors.push(await api.deleteMessage(-1, 1).then(() => { throw new Error('should fail') }, (e) => e))
    await server.close()
    expect(errors.map((e) => [e.kind, e.code, e.retryAfter])).toEqual([['rate_limit', 429, 7], ['server', 502, undefined], ['client', 400, undefined], ['client', 403, undefined], ['client', 409, undefined]])
  })

  it('a refused connection is a safe network error; other transport failures may have been received by Telegram', async () => {
    const dead = new GrammyTelegram('TOKEN', 'http://127.0.0.1:1')
    const refused = await dead.sendMessage(-1, 'x').then(() => null, (e) => e as TelegramError)
    expect(refused?.kind).toBe('network')
    const server = await fakeServer((_s, _i, res) => res.destroy())
    const cut = await new GrammyTelegram('TOKEN', server.url).sendMessage(-1, 'x').then(() => null, (e) => e as TelegramError)
    await server.close()
    expect(cut?.kind).toBe('unknown_outcome')
    expect(mapError(new Error('weird')).kind).toBe('network')
  })

  it('reads chat members, administrators, files and callbacks', async () => {
    const results: Record<string, unknown> = {
      getChatMember: { status: 'administrator', user: { id: 5, is_bot: false } },
      getChatAdministrators: [{ status: 'creator', user: { id: 5, is_bot: false } }, { status: 'administrator', user: { id: 777, is_bot: true } }],
      getChat: { id: -1, title: 'T', bio: 'hello', permissions: { can_send_messages: true } },
      getFile: { file_id: 'f', file_path: 'photos/f.jpg', file_size: 12 },
      getMe: { id: 777, is_bot: true, first_name: 'J', username: 'jevchik_bot' },
      answerCallbackQuery: true,
    }
    const server = await fakeServer((seen, _i, res) => reply(res, 200, { ok: true, result: results[seen.url!.split('/').pop()!] }))
    const api = new GrammyTelegram('TOKEN', server.url)
    expect(await api.getChatMember(-1, 5)).toEqual({ status: 'administrator', is_bot: false })
    expect(await api.getChatAdministrators(-1)).toEqual([{ user_id: 5, is_bot: false }, { user_id: 777, is_bot: true }])
    expect(await api.getChat(5)).toEqual({ title: 'T', username: undefined, bio: 'hello', permissions: { can_send_messages: true } })
    expect(await api.getFile('f')).toEqual({ file_path: 'photos/f.jpg', file_size: 12 })
    expect(await api.getMe()).toEqual({ id: 777, username: 'jevchik_bot' })
    await api.answerCallbackQuery('cb', 'Готово')
    await server.close()
    expect(JSON.parse(server.seen.at(-1)!.body)).toEqual({ callback_query_id: 'cb', text: 'Готово' })
  })
})
