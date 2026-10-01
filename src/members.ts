import type { Message } from 'grammy/types'
import type { Q } from './db.js'
import { DAY_MS } from './ctx.js'
import type { SettingsView } from './settings/settings.js'

export interface TgUser {
  id: number
  first_name?: string
  last_name?: string
  username?: string
  is_bot?: boolean
}

export interface TgChat {
  id: number
  title?: string
  username?: string
  type?: string
}

const OBSERVATION_DAYS = 7

/** The account Telegram uses for posts auto-forwarded from the linked channel. */
const TELEGRAM_SERVICE_ID = 777000

/** Messages about the chat itself, not written by anybody: joins, pins, forum topics, video chats and the like. */
const SERVICE_KEYS = [
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo', 'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'channel_chat_created', 'message_auto_delete_timer_changed', 'migrate_to_chat_id', 'migrate_from_chat_id', 'pinned_message', 'forum_topic_created',
  'forum_topic_edited', 'forum_topic_closed', 'forum_topic_reopened', 'general_forum_topic_hidden', 'general_forum_topic_unhidden', 'video_chat_scheduled',
  'video_chat_started', 'video_chat_ended', 'video_chat_participants_invited', 'write_access_allowed', 'users_shared', 'chat_shared',
  'proximity_alert_triggered', 'boost_added', 'chat_background_set', 'giveaway_created', 'giveaway_completed', 'giveaway_winners',
]

function isServiceMessage(msg: Message): boolean {
  return SERVICE_KEYS.some((key) => key in msg)
}

/**
 * Spec 3.6.0: a message written by a person. Not a bot, not on behalf of a chat or a channel (sender_chat), not a post
 * auto-forwarded from the linked channel, not Telegram's service account, not a service message.
 */
function fromPerson(msg: Message): boolean {
  if (!msg.from || msg.from.is_bot || msg.from.id === TELEGRAM_SERVICE_ID) return false
  return !msg.sender_chat && !msg.is_automatic_forward && !isServiceMessage(msg)
}

/** The member who wrote a message: a person, or a channel writing in the group (section 3.6.4). */
export interface Author {
  id: number
  name: string
  username: string | null
  isChannel: boolean
}

/**
 * Section 3.6.4: a channel author is a `sender_chat` other than the group itself, without `is_automatic_forward`. A post
 * auto-forwarded from the linked channel and an anonymous admin (on behalf of the group) are nobody's, as before.
 */
function channelAuthor(msg: Message): Author | null {
  const chat = msg.sender_chat
  if (!chat || chat.id === msg.chat.id || msg.is_automatic_forward || isServiceMessage(msg)) return null
  const title = 'title' in chat ? chat.title : undefined
  return { id: chat.id, name: title || chat.username || String(chat.id), username: chat.username ?? null, isChannel: true }
}

export function authorOf(msg: Message): Author | null {
  if (fromPerson(msg)) return { id: msg.from!.id, name: displayName(msg.from!), username: msg.from!.username ?? null, isChannel: false }
  return channelAuthor(msg)
}

/** A channel member has the negative id of its chat; a person's id is positive (section 3.6.4). */
export function isChannelId(userId: number): boolean {
  return userId < 0
}

/**
 * The message this one answers. Spec 3.6.0: a reply to a service message - in a forum every topic message answers the
 * message that created the topic - is no reply.
 */
export function replyOf(msg: Message): Message | null {
  const reply = msg.reply_to_message as Message | undefined
  return reply && !isServiceMessage(reply) ? reply : null
}

export function displayName(user: TgUser): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return name || user.username || String(user.id)
}

/** Every chat object in an update carries the current username; its absence means the chat has none now (links, section 3.6.1). */
export async function ensureChat(q: Q, chat: TgChat, now: Date): Promise<boolean> {
  const rows = await q.query(
    `INSERT INTO chats (chat_id, title, username, observation_started_at, created_at) VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (chat_id) DO UPDATE SET title = COALESCE(EXCLUDED.title, chats.title), username = EXCLUDED.username
     RETURNING (xmax = 0) AS created`,
    [chat.id, chat.title ?? null, chat.username ?? null, now],
  )
  return rows[0].created as boolean
}

export async function upsertMember(q: Q, chatId: number, user: TgUser, now: Date): Promise<void> {
  await q.query(
    `INSERT INTO members (chat_id, user_id, display_name, username, is_bot, created_at) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (chat_id, user_id) DO UPDATE SET display_name = EXCLUDED.display_name, username = EXCLUDED.username`,
    [chatId, user.id, displayName(user), user.username ?? null, user.is_bot ?? false, now],
  )
}

/**
 * The author of a message as a member. Section 3.6.4: a channel has no join to see, so a channel first seen in a live message
 * of its own is marked as joined then (a newcomer); one known before, or from an imported history, is not. During the first
 * week after the bot came to the chat every channel it meets is taken for one that wrote there before: the bot cannot tell an
 * old channel from a new one until the history is loaded, and banning a regular is worse than missing a spammer.
 */
export async function upsertAuthor(q: Q, chatId: number, author: Author, at: { now: Date; live: boolean }): Promise<void> {
  const joined = author.isChannel && at.live ? at.now : null
  await q.query(
    `INSERT INTO members (chat_id, user_id, display_name, username, is_channel, joined_seen_at, created_at)
     VALUES ($1,$2,$3,$4,$5,
       CASE WHEN (SELECT observation_started_at FROM chats WHERE chat_id = $1) <= $6::timestamptz - make_interval(days => $8) THEN $6::timestamptz END,
       $7)
     ON CONFLICT (chat_id, user_id) DO UPDATE SET display_name = EXCLUDED.display_name, username = EXCLUDED.username`,
    [chatId, author.id, author.name, author.username, author.isChannel, joined, at.now, OBSERVATION_DAYS],
  )
}

/** Section 3.6.0: the bot saw this person join the chat; only such a member can be a newcomer. The first sighting stays. */
export async function markJoined(q: Q, chatId: number, user: TgUser, at: Date): Promise<void> {
  if (user.is_bot) return
  await upsertMember(q, chatId, user, at)
  await q.query('UPDATE members SET joined_seen_at = COALESCE(joined_seen_at, $3) WHERE chat_id = $1 AND user_id = $2', [chatId, user.id, at])
}

export async function observationEnd(q: Q, chatId: number, settings: SettingsView): Promise<Date | null> {
  const rows = await q.query<{ observation_started_at: Date }>('SELECT observation_started_at FROM chats WHERE chat_id = $1', [chatId])
  if (rows.length === 0) return null
  const base = new Date(rows[0].observation_started_at).getTime() + OBSERVATION_DAYS * DAY_MS
  const extended = settings.raw('observation_until') as string | null
  return new Date(Math.max(base, extended ? Date.parse(extended) : 0))
}

export async function isObserving(q: Q, chatId: number, settings: SettingsView, at: Date): Promise<boolean> {
  const end = await observationEnd(q, chatId, settings)
  return end !== null && at < end
}

export async function getKarma(q: Q, chatId: number, userId: number): Promise<number> {
  const rows = await q.query<{ karma: number }>('SELECT karma FROM members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  return rows[0]?.karma ?? 0
}
