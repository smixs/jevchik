import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startImport } from '../src/import.js'
import { ADMIN, ALICE, BOB, CAROL, CHAT, DAY, OTHER_CHAT, botJoined, createHarness, edited, karmaOf, message, pastObservation, type Harness } from './support/harness.js'

// Section 3.6: an edit is only an edited_message whose content changed (text, caption or attachment).
// Telegram also sends edited_message when the bot sets a member tag; that update changes nothing.

const MILD = 'Посмотрите мой курс по промптам со скидкой'
const TAG = { sender_tag: '+12' }
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  h.jev.defaultScript = { usefulness: { score: 3, confidence: 0.9 } }
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

interface Snapshot {
  requests: number
  cards: number
  evaluations: number
  events: number
  karma: number
  excerpt: string | null
}

async function snapshot(messageId: number, author: number, chat = CHAT): Promise<Snapshot> {
  const count = async (sql: string): Promise<number> => (await h.db.query(sql))[0].n
  return {
    requests: h.jev.requests.length,
    cards: h.tg.of('sendMessage').filter((c) => c.args[0] === ADMIN.id).length,
    evaluations: await count('SELECT count(*)::int AS n FROM evaluations'),
    events: await count('SELECT count(*)::int AS n FROM karma_events'),
    karma: await karmaOf(h, author, chat),
    excerpt: (await h.db.query('SELECT excerpt FROM messages WHERE chat_id = $1 AND message_id = $2', [chat, messageId]))[0].excerpt,
  }
}

async function hashOf(messageId: number): Promise<Buffer | null> {
  return (await h.db.query('SELECT content_hash FROM messages WHERE chat_id = $1 AND message_id = $2', [CHAT, messageId]))[0].content_hash
}

async function processed(update: { update_id: number }): Promise<boolean> {
  return (await h.db.query('SELECT 1 FROM processed_updates WHERE update_id = $1', [update.update_id])).length === 1
}

const later = (minutes: number): string => new Date(h.clock.now().getTime() + minutes * 60_000).toISOString()

describe('an edited_message with unchanged content is not an edit', () => {
  it('a new sender tag on a live message: no Jev request, no card, karma and excerpt stay', async () => {
    h.jev.script(MILD, { spam_other_offer: 0.35, usefulness: { score: 3, confidence: 0.9 } })
    await h.send(message({ id: 700, from: CAROL, text: MILD }))
    await h.app.settle()
    await h.db.query('UPDATE messages SET excerpt = NULL WHERE message_id = 700') // the excerpt was already cleared by retention
    const before = await snapshot(700, CAROL.id)
    expect(before).toMatchObject({ requests: 1, cards: 1, evaluations: 1, events: 1 })
    const update = edited({ id: 700, from: CAROL, text: MILD, edit_date: later(1), extra: TAG })
    await h.send(update)
    await h.app.settle()
    expect(await snapshot(700, CAROL.id)).toEqual(before)
    expect(await processed(update)).toBe(true)
  })

  it('in observation a new sender tag sends no second "would do" card', async () => {
    await h.send(botJoined(OTHER_CHAT))
    h.jev.script(MILD, { spam_other_offer: 0.6 })
    await h.send(message({ id: 701, chat: OTHER_CHAT, from: CAROL, text: MILD }))
    await h.app.settle()
    const before = await snapshot(701, CAROL.id, OTHER_CHAT)
    expect(before.cards).toBe(1)
    await h.send(edited({ id: 701, chat: OTHER_CHAT, from: CAROL, text: MILD, edit_date: later(1), extra: TAG }))
    await h.app.settle()
    expect(await snapshot(701, CAROL.id, OTHER_CHAT)).toEqual(before)
  })

  it('a new sender tag on an imported message: no Jev request, no card, karma and excerpt stay', async () => {
    const exported = {
      id: 1234567890,
      messages: [{ id: 5, type: 'message', from: 'Alice', from_id: 'user1', text: ['старый ', { type: 'bold', text: 'полезный' }, ' ответ'], date_unixtime: String(Math.floor((h.clock.now().getTime() - 3 * DAY) / 1000)) }],
    }
    expect((await startImport(h.ctx, CHAT, ADMIN.id, Buffer.from(JSON.stringify(exported)))).ok).toBe(true)
    await h.app.settle()
    expect((await h.db.query('SELECT status FROM import_jobs'))[0].status).toBe('done')
    expect(await hashOf(5)).not.toBeNull()
    const before = await snapshot(5, ALICE.id)
    expect(before.requests).toBe(1)
    const update = edited({ id: 5, from: ALICE, text: 'старый полезный ответ', date: new Date(h.clock.now().getTime() - 3 * DAY).toISOString(), edit_date: later(1), extra: TAG })
    await h.send(update)
    await h.app.settle()
    expect(await snapshot(5, ALICE.id)).toEqual(before)
    expect(await processed(update)).toBe(true)
  })

  it('an imported message with media keeps no hash: its first edited_message only stores one', async () => {
    const exported = {
      id: 1234567890,
      messages: [{ id: 6, type: 'message', from: 'Alice', from_id: 'user1', text: 'фото с подписью', photo: 'photos/photo_1.jpg', date_unixtime: String(Math.floor((h.clock.now().getTime() - 3 * DAY) / 1000)) }],
    }
    expect((await startImport(h.ctx, CHAT, ADMIN.id, Buffer.from(JSON.stringify(exported)))).ok).toBe(true)
    await h.app.settle()
    expect(await hashOf(6)).toBeNull()
    const before = await snapshot(6, ALICE.id)
    const photo = { photo: [{ file_id: 'p6', file_unique_id: 'pu6', width: 1, height: 1, file_size: 10 }], caption: 'фото с подписью', ...TAG }
    await h.send(edited({ id: 6, from: ALICE, edit_date: later(1), extra: photo }))
    await h.app.settle()
    expect(await snapshot(6, ALICE.id)).toEqual(before)
    expect(await hashOf(6)).not.toBeNull()
  })

  it('a row without a hash: the first edited_message stores the hash only, the next changed text is evaluated', async () => {
    await h.send(message({ id: 710, from: BOB, text: 'до миграции' }))
    await h.app.settle()
    await h.db.query('UPDATE messages SET content_hash = NULL WHERE message_id = 710') // written before migration 005
    const before = await snapshot(710, BOB.id)
    await h.send(edited({ id: 710, from: BOB, text: 'до миграции', edit_date: later(1), extra: TAG }))
    await h.app.settle()
    expect(await snapshot(710, BOB.id)).toEqual(before)
    const stored = await hashOf(710)
    expect(stored).not.toBeNull()
    await h.send(edited({ id: 710, from: BOB, text: 'после миграции, исправлено', edit_date: later(2), extra: TAG }))
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(before.requests + 1)
    expect(h.jev.requests.at(-1)!.state.message).toBe('после миграции, исправлено')
    expect(await hashOf(710)).not.toEqual(stored)
    expect((await snapshot(710, BOB.id)).excerpt).toBe('после миграции, исправлено')
  })

  it('a real edit works as before and a later tag change of the edited text does nothing', async () => {
    await h.send(message({ id: 720, from: BOB, text: 'первая версия' }))
    await h.app.settle()
    const first = await hashOf(720)
    h.jev.script('вторая версия', { usefulness: { score: 4, confidence: 0.9 } })
    const editDate = later(5)
    await h.send(edited({ id: 720, from: BOB, text: 'вторая версия', edit_date: editDate }))
    await h.app.settle()
    expect(h.jev.requests.map((r) => r.state.message)).toEqual(['первая версия', 'вторая версия'])
    const gen = Math.floor(Date.parse(editDate) / 1000)
    expect((await h.db.query('SELECT evaluation_id FROM evaluations WHERE message_id = 720 ORDER BY created_at, evaluation_id')).map((r) => r.evaluation_id)).toEqual([
      `msg:${CHAT}:720:0`,
      `msg:${CHAT}:720:${gen}`,
    ])
    expect((await h.db.query('SELECT reason FROM karma_events WHERE message_id = 720 ORDER BY event_id')).map((r) => r.reason)).toEqual(['jev_usefulness', 'jev_undo', 'jev_usefulness'])
    expect(await hashOf(720)).not.toEqual(first)
    const before = await snapshot(720, BOB.id)
    expect(before.excerpt).toBe('вторая версия')
    await h.send(edited({ id: 720, from: BOB, text: 'вторая версия', edit_date: editDate, extra: TAG }))
    await h.app.settle()
    expect(await snapshot(720, BOB.id)).toEqual(before)
  })

  it('media: a new caption or a new photo is an edit, the same photo and caption is not', async () => {
    const photo = (unique: string) => [{ file_id: `small-${unique}`, file_unique_id: `${unique}-s`, width: 1, height: 1, file_size: 100 }, { file_id: `big-${unique}`, file_unique_id: `${unique}-b`, width: 1, height: 1, file_size: 5000 }]
    await h.send(message({ id: 730, from: ALICE, extra: { photo: photo('a'), caption: 'старая подпись' } }))
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(1)
    await h.send(edited({ id: 730, from: ALICE, edit_date: later(1), extra: { photo: photo('a'), caption: 'новая подпись' } }))
    await h.app.settle()
    expect(h.jev.requests.map((r) => r.state.message)).toEqual(['старая подпись', 'новая подпись'])
    const before = await snapshot(730, ALICE.id)
    await h.send(edited({ id: 730, from: ALICE, edit_date: later(2), extra: { photo: photo('a'), caption: 'новая подпись', ...TAG } }))
    await h.app.settle()
    expect(await snapshot(730, ALICE.id)).toEqual(before)
    await h.send(edited({ id: 730, from: ALICE, edit_date: later(3), extra: { photo: photo('b'), caption: 'новая подпись' } }))
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(3)
  })

  it('the replied-to message gets its hash from the reply, so a tag change on it is not an edit', async () => {
    await h.send(message({ id: 741, from: BOB, text: 'согласен', reply_to: { message_id: 740, from: ALICE, text: 'старое сообщение' } }))
    await h.app.settle()
    expect(await hashOf(740)).not.toBeNull()
    const before = await snapshot(740, ALICE.id)
    await h.send(edited({ id: 740, from: ALICE, text: 'старое сообщение', edit_date: later(1), extra: TAG }))
    await h.app.settle()
    expect(await snapshot(740, ALICE.id)).toEqual(before)
    await h.send(edited({ id: 740, from: ALICE, text: 'старое сообщение, дополнено', edit_date: later(2) }))
    await h.app.settle()
    expect(h.jev.requests.at(-1)!.state.message).toBe('старое сообщение, дополнено')
  })

  it('an edited_message for an unknown message changes nothing, as before', async () => {
    const before = h.jev.requests.length
    await h.send(edited({ id: 750, from: ALICE, text: 'неизвестное', edit_date: later(1), extra: TAG }))
    await h.app.settle()
    expect(h.jev.requests).toHaveLength(before)
    expect(await h.db.query('SELECT 1 FROM messages WHERE message_id = 750')).toEqual([])
  })
})
