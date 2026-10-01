import { createServer, type IncomingMessage } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpVisionClient, VISION_PROMPT } from '../src/adapters/vision.js'
import { ADMIN, ALICE, BOB, CAROL, CHAT, createHarness, eventsOf, karmaOf, message, pastObservation, type Harness } from './support/harness.js'
import { tgError } from './support/fakes.js'

let h: Harness
beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const photo = (unique = 'pu1', sizes = [{ id: 'small', size: 1000 }, { id: 'big', size: 50_000 }]) => ({
  photo: sizes.map((s) => ({ file_id: s.id, file_unique_id: `${unique}-${s.id}`, width: 1, height: 1, file_size: s.size })),
})
const sticker = (unique = 'su1', emoji = '😂') => ({ sticker: { file_id: `st-${unique}`, file_unique_id: unique, emoji, is_animated: false, is_video: false, width: 1, height: 1, type: 'regular' } })
const gif = (unique = 'gu1') => ({ animation: { file_id: `gif-${unique}`, file_unique_id: unique, width: 1, height: 1, duration: 1, thumbnail: { file_id: `gth-${unique}`, file_unique_id: `${unique}-t`, width: 1, height: 1, file_size: 900 } } })

describe('F12: photo, sticker and gif are described and the description goes to Jev', () => {
  it('photo with a caption: the largest size is downloaded, the description is in media_description', async () => {
    await h.send(message({ id: 800, from: ALICE, extra: { ...photo(), caption: 'смотрите, что нашёл' } }))
    await h.app.settle()
    expect(h.vision.requests).toEqual([{ image: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }])
    expect(h.tg.of('getFile').map((c) => c.args)).toEqual([['big']])
    expect(h.jev.requests[0].state.message).toBe('смотрите, что нашёл')
    expect(h.jev.requests[0].state.media_description).toBe('photo: a cat photo')
  })

  it('sticker: the emoji from Telegram is part of the description', async () => {
    await h.send(message({ id: 801, from: ALICE, extra: sticker() }))
    await h.app.settle()
    expect(h.jev.requests[0].state.media_description).toBe('sticker (😂): a cat photo')
    expect(h.jev.requests[0].state.message).toBe('')
  })

  it('gif: described by its thumbnail', async () => {
    await h.send(message({ id: 802, from: ALICE, extra: gif() }))
    await h.app.settle()
    expect(h.tg.of('getFile').map((c) => c.args)).toEqual([['gth-gu1']])
    expect(h.jev.requests[0].state.media_description).toBe('gif: a cat photo')
  })

  it('the same file_unique_id is described once', async () => {
    await h.send(message({ id: 803, from: ALICE, extra: sticker('same') }))
    await h.send(message({ id: 804, from: BOB, extra: sticker('same') }))
    await h.app.settle()
    expect(h.vision.requests).toHaveLength(1)
    expect(h.jev.requests).toHaveLength(2)
    expect(h.jev.requests[1].state.media_description).toBe('sticker (😂): a cat photo')
    expect(await h.db.query('SELECT file_unique_id FROM media_descriptions')).toEqual([{ file_unique_id: 'same' }])
  })

  it('T-vision-race: two identical files at once cost one model call', async () => {
    h.vision.delayMs = 60
    await Promise.all([h.send(message({ id: 805, from: ALICE, extra: sticker('race') })), h.send(message({ id: 806, from: BOB, extra: sticker('race') }))])
    await h.app.settle()
    expect(h.vision.requests).toHaveLength(1)
    expect(h.jev.requests.map((r) => r.state.media_description)).toEqual(['sticker (😂): a cat photo', 'sticker (😂): a cat photo'])
  })
})

describe('media failures', () => {
  it('T-vision-down: a failing model gives null and a captionless newbie message goes to admins as a card, no sanction', async () => {
    h.vision.failure = new Error('502')
    await h.send(message({ id: 810, from: CAROL, extra: photo('down') }))
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(0)
    for (const method of ['deleteMessage', 'restrictChatMember', 'banChatMember']) expect(h.tg.count(method)).toBe(0)
    const card = h.tg.of('sendMessage').find((c) => c.args[0] === ADMIN.id)!
    expect(card.args[1]).toContain('Новичок прислал медиа без подписи')
    expect(await h.db.query('SELECT 1 FROM media_descriptions')).toEqual([])
  })

  it('T-vision-down: with a caption the message is still evaluated, description null', async () => {
    h.vision.failure = new Error('timeout')
    await h.send(message({ id: 811, from: CAROL, extra: { ...photo('down2'), caption: 'вот' } }))
    await h.app.settle()
    expect(h.jev.requests[0].state.media_description).toBeNull()
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id)).toHaveLength(0)
  })

  it('without a vision key media is not described and everything else works', async () => {
    await h.close()
    h = await createHarness({ vision: false })
    h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
    await pastObservation(h)
    await h.send(message({ id: 812, from: ALICE, text: 'обычный текст' }))
    await h.send(message({ id: 813, from: CAROL, extra: sticker('nokey') }))
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(1)
    expect(h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id)).toHaveLength(1)
  })

  it('T-vision-big: a file over the limit falls back to the thumbnail, otherwise null', async () => {
    const huge = 9 * 1024 * 1024
    await h.send(message({ id: 820, from: ALICE, extra: { photo: [{ file_id: 'thumb', file_unique_id: 'b-thumb', width: 1, height: 1, file_size: 2000 }, { file_id: 'huge', file_unique_id: 'b-huge', width: 1, height: 1, file_size: huge }] } }))
    await h.app.settle()
    expect(h.tg.of('getFile').map((c) => c.args)).toEqual([['thumb']])
    expect(h.jev.requests[0].state.media_description).toBe('photo: a cat photo')
    h.tg.calls.length = 0
    await h.send(message({ id: 821, from: ALICE, extra: { photo: [{ file_id: 'huge2', file_unique_id: 'c-huge', width: 1, height: 1, file_size: huge }] } }))
    await h.app.settle()
    expect(h.vision.requests).toHaveLength(1)
    expect(h.tg.count('getFile')).toBe(0)
  })

  it('T-vision-big: the size reported by getFile is checked too', async () => {
    h.tg.files.set('big', { path: 'photos/big.jpg', size: 12 * 1024 * 1024 })
    h.tg.files.set('small', { path: 'photos/small.jpg', size: 12 * 1024 * 1024 })
    await h.send(message({ id: 822, from: ALICE, extra: photo('gf') }))
    await h.app.settle()
    expect(h.vision.requests).toHaveLength(0)
  })

  it('T-file-down: network and 5xx errors are retried three times, then null', async () => {
    h.tg.fail('getFile', tgError.network(), 10)
    await h.send(message({ id: 830, from: ALICE, extra: { ...photo('fd'), caption: 'подпись' } }))
    await h.app.settle()
    expect(h.tg.count('getFile')).toBe(3)
    expect(h.jev.requests[0].state.media_description).toBeNull()
  })

  it('T-file-down: 429 waits for retry_after, 400 and 403 are not repeated', async () => {
    h.tg.fail('getFile', tgError.rate(7), 1)
    const before = h.clock.now().getTime()
    await h.send(message({ id: 831, from: ALICE, extra: { ...photo('fd2'), caption: 'подпись' } }))
    await h.app.settle()
    expect(h.tg.count('getFile')).toBe(2)
    expect(h.clock.now().getTime() - before).toBeGreaterThanOrEqual(7000)
    h.tg.calls.length = 0
    h.tg.fail('getFile', tgError.bad('Bad Request: wrong file_id', 400), 5)
    await h.send(message({ id: 832, from: ALICE, extra: { ...photo('fd3'), caption: 'подпись' } }))
    await h.app.settle()
    expect(h.tg.count('getFile')).toBe(1)
  })

  it('a media reply from a participant keeps karma rules intact', async () => {
    await h.send(message({ id: 840, from: ALICE, text: 'вопрос' }))
    await h.app.settle()
    expect(await karmaOf(h, ALICE.id)).toBe(0)
    expect(await eventsOf(h, ALICE.id)).toEqual([])
    expect(CHAT).toBeLessThan(0)
  })
})

describe('the model description wire request', () => {
  it('sends an OpenAI-compatible request and reads the first choice', async () => {
    const seen: Array<{ url?: string; auth?: string; body: unknown }> = []
    const server = createServer((req: IncomingMessage, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: 'Кот на клавиатуре. Тон: шутка.' } }] }))
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as { port: number }
    const client = new HttpVisionClient(`http://127.0.0.1:${port}/v1/`, 'vision-x', 'key-1')
    const text = await client.describe({ image: new Uint8Array([1, 2, 3]), mime: 'image/png' })
    server.close()
    expect(text).toBe('Кот на клавиатуре. Тон: шутка.')
    expect(seen).toEqual([
      {
        url: '/v1/chat/completions',
        auth: 'Bearer key-1',
        body: {
          model: 'vision-x',
          max_tokens: 300,
          messages: [{ role: 'user', content: [{ type: 'text', text: VISION_PROMPT }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } }] }],
        },
      },
    ])
  })

  it('errors and garbage are exceptions (the caller turns them into null)', async () => {
    for (const reply of [{ status: 500, body: 'x' }, { status: 401, body: '{}' }, { status: 200, body: '{"choices":[]}' }, { status: 200, body: 'not json' }]) {
      const server = createServer((_req, res) => {
        res.statusCode = reply.status
        res.end(reply.body)
      })
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      const { port } = server.address() as { port: number }
      await expect(new HttpVisionClient(`http://127.0.0.1:${port}`, 'm', 'k').describe({ image: new Uint8Array([1]), mime: 'image/png' })).rejects.toThrow()
      server.close()
    }
  })
})
