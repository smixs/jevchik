import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../src/db.js'
import { ADMIN, CHAT, createHarness, message, pastObservation, type Harness, type User } from './support/harness.js'

// Section 3.6.0: a newcomer is somebody the bot saw joining the chat. Whoever was in the chat before the bot came is never
// judged by the text or by the profile, however few of their messages the bot knows (a chat connected without its history).

const SPAM = 'Заработай 500 долларов в день без вложений, пиши в личку!'
const OLD: User = { id: 41, first_name: 'Olga' }
const NEW: User = { id: 42, first_name: 'Nick' }
let h: Harness

beforeEach(async () => {
  h = await createHarness()
  h.tg.admins = [{ user_id: ADMIN.id, is_bot: false }]
  await pastObservation(h)
})
afterEach(async () => {
  await h.close()
})

const sanctions = (): string[] => h.tg.calls.filter((c) => ['deleteMessage', 'restrictChatMember', 'banChatMember'].includes(c.method)).map((c) => c.method)
const cards = async (): Promise<number> => (await h.db.query('SELECT count(*)::int AS n FROM admin_cards'))[0].n

describe('a member who was in the chat before the bot came', () => {
  it('first known message, spam 0.99 and a promotional profile: no deletion, no restriction, no card, no ban record', async () => {
    h.oldTimers.add(OLD.id)
    h.jev.script(SPAM, { spam_earnings_crypto: 0.99, profile_promo: 0.95 })
    await h.send(message({ id: 800, from: OLD, text: SPAM }))
    await h.app.settle()
    expect(sanctions()).toEqual([])
    expect(await cards()).toBe(0)
    expect(await h.db.query('SELECT 1 FROM bans')).toEqual([])
    expect((await h.db.query('SELECT joined_seen_at FROM members WHERE user_id = $1', [OLD.id]))[0].joined_seen_at).toBeNull()
  })

  it('the same message from somebody the bot saw joining is deleted and the author is restricted', async () => {
    h.jev.script(SPAM, { spam_earnings_crypto: 0.99 })
    await h.send(message({ id: 801, from: NEW, text: SPAM }))
    await h.app.settle()
    expect(sanctions()).toEqual(['deleteMessage', 'restrictChatMember'])
    expect(await h.db.query('SELECT state FROM bans WHERE user_id = $1', [NEW.id])).toEqual([{ state: 'steam' }])
  })

  it('a join seen as the service message of the chat makes a newcomer too', async () => {
    h.oldTimers.add(NEW.id)
    await h.send(message({ id: 802, from: NEW, extra: { new_chat_members: [NEW] } }))
    h.jev.script(SPAM, { spam_earnings_crypto: 0.99 })
    await h.send(message({ id: 803, from: NEW, text: SPAM }))
    await h.app.settle()
    expect(sanctions()).toEqual(['deleteMessage', 'restrictChatMember'])
  })
})

describe('migration 011: joins the bot saw before the column existed', () => {
  it('a member row made by a membership update after the chat was connected gets the mark; an old member does not', async () => {
    const connected = (await h.db.query('SELECT created_at FROM chats WHERE chat_id = $1', [CHAT]))[0].created_at as Date
    const later = new Date(new Date(connected).getTime() + 3_600_000)
    await h.db.query(
      `INSERT INTO members (chat_id, user_id, display_name, status, created_at) VALUES ($1,51,'Joined','member',$2),($1,52,'Was here',NULL,$2),($1,53,'Wrote before','member',$2)`,
      [CHAT, later],
    )
    await h.db.query(`INSERT INTO messages (chat_id, message_id, author_id, posted_at) VALUES ($1,10,53,$2)`, [CHAT, new Date(new Date(connected).getTime() - 86_400_000)])
    await h.db.query(`DELETE FROM schema_migrations WHERE name = '011_joined_seen.sql'`)
    await h.db.query('ALTER TABLE members DROP COLUMN joined_seen_at')
    await migrate(h.db)
    const rows = await h.db.query('SELECT user_id::int AS id, joined_seen_at IS NOT NULL AS joined FROM members WHERE user_id IN (51,52,53) ORDER BY user_id')
    expect(rows).toEqual([{ id: 51, joined: true }, { id: 52, joined: false }, { id: 53, joined: false }])
  })
})
