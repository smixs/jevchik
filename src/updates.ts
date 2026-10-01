import type { Message, Update } from 'grammy/types'
import { handleCallback } from './callbacks.js'
import type { Ctx } from './ctx.js'
import type { Q } from './db.js'
import { enqueueEvaluation } from './evaluation.js'
import { senderHistory } from './jev/history.js'
import type { JevState } from './jev/state.js'
import type { MediaRef } from './media.js'
import { displayName, ensureChat, fromPerson, markJoined, replyOf, upsertMember } from './members.js'
import type { EvalMeta } from './pipeline.js'
import { handleReaction, handleReactionCount } from './reactions.js'
import { isReportCommand, startReport } from './report.js'
import { getSettings, type SettingsView } from './settings/settings.js'
import { isSpamCommand, startSpamCommand } from './spam-command.js'
import { contentHash, makeExcerpt, truncateGraphemes } from './text.js'

type Post = () => Promise<void>

const GROUP_TYPES = new Set(['group', 'supergroup'])
const LINK = /https?:\/\/|t\.me\/|www\./i

function textOf(msg: Message): string {
  return msg.text ?? msg.caption ?? ''
}

function hasLinks(msg: Message): boolean {
  const entities = [...(msg.entities ?? []), ...(msg.caption_entities ?? [])]
  return entities.some((e) => e.type === 'url' || e.type === 'text_link') || LINK.test(textOf(msg))
}

function mediaOf(msg: Message): MediaRef | null {
  if (msg.photo?.length) {
    const sizes = [...msg.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))
    return {
      kind: 'photo',
      uniqueId: sizes[0].file_unique_id,
      candidates: sizes.map((s) => ({ fileId: s.file_id, size: s.file_size })),
    }
  }
  if (msg.sticker) {
    const s = msg.sticker
    const candidates = []
    if (!s.is_animated && !s.is_video) candidates.push({ fileId: s.file_id, size: s.file_size })
    if (s.thumbnail) candidates.push({ fileId: s.thumbnail.file_id, size: s.thumbnail.file_size })
    return { kind: 'sticker', uniqueId: s.file_unique_id, emoji: s.emoji ?? null, candidates }
  }
  if (msg.animation) {
    const thumb = msg.animation.thumbnail
    return { kind: 'animation', uniqueId: msg.animation.file_unique_id, candidates: thumb ? [{ fileId: thumb.file_id, size: thumb.file_size }] : [] }
  }
  return null
}

function hashOf(msg: Message): Buffer {
  const media = mediaOf(msg)
  return contentHash({ text: msg.text ?? '', caption: msg.caption ?? '', attachment: media ? `${media.kind}:${media.uniqueId}` : null })
}

function line(name: string, text: string): string {
  return `${name}: ${text}`
}

async function previousLines(q: Q, chatId: number, messageId: number, count: number): Promise<string[]> {
  if (count <= 0) return []
  const rows = await q.query(
    `SELECT m.excerpt, mem.display_name FROM messages m JOIN members mem ON mem.chat_id = m.chat_id AND mem.user_id = m.author_id
     WHERE m.chat_id = $1 AND m.message_id < $2 AND m.excerpt IS NOT NULL
     ORDER BY m.message_id DESC LIMIT $3`,
    [chatId, messageId, count],
  )
  return rows.reverse().map((r) => line(r.display_name, r.excerpt))
}

interface Arrival {
  runK: number
  isFirst: boolean
  probation: boolean
}

async function insertMessage(q: Q, msg: Message, runK: number): Promise<boolean> {
  const reply = replyOf(msg)
  const rows = await q.query(
    `INSERT INTO messages (chat_id, message_id, author_id, posted_at, reply_to_message_id, reply_to_author_id, has_quote, media_kind, run_k, excerpt, content_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (chat_id, message_id) DO NOTHING RETURNING message_id`,
    [
      msg.chat.id,
      msg.message_id,
      msg.from!.id,
      new Date(msg.date * 1000),
      reply?.message_id ?? null,
      reply && fromPerson(reply as Message) ? reply.from!.id : null,
      Boolean(msg.quote),
      mediaOf(msg)?.kind ?? null,
      runK,
      textOf(msg) ? makeExcerpt(textOf(msg)) : null,
      hashOf(msg),
    ],
  )
  return rows.length > 0
}

async function claimFirst(q: Q, chatId: number, userId: number, messageId: number): Promise<boolean> {
  const rows = await q.query('UPDATE members SET first_message_id = $3 WHERE chat_id = $1 AND user_id = $2 AND first_message_id IS NULL RETURNING 1', [chatId, userId, messageId])
  return rows.length > 0
}

async function takeProbation(q: Q, chatId: number, userId: number): Promise<boolean> {
  const rows = await q.query('SELECT probation_left FROM members WHERE chat_id = $1 AND user_id = $2 FOR UPDATE', [chatId, userId])
  if (rows[0].probation_left <= 0) return false
  await q.query('UPDATE members SET probation_left = probation_left - 1 WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  return true
}

async function registerArrival(q: Q, msg: Message): Promise<Arrival | null> {
  const chatId = msg.chat.id
  const userId = msg.from!.id
  const chat = await q.query('SELECT last_author_id, run_length FROM chats WHERE chat_id = $1 FOR UPDATE', [chatId])
  const runK = chat[0].last_author_id === userId ? chat[0].run_length + 1 : 1
  if (!(await insertMessage(q, msg, runK))) return null
  await q.query('UPDATE chats SET last_author_id = $2, run_length = $3 WHERE chat_id = $1', [chatId, userId, runK])
  const isFirst = await claimFirst(q, chatId, userId, msg.message_id)
  return { runK, isFirst, probation: await takeProbation(q, chatId, userId) }
}

async function registerReply(q: Q, msg: Message, now: Date): Promise<void> {
  const reply = replyOf(msg)
  if (!reply || !fromPerson(reply as Message)) return
  await upsertMember(q, msg.chat.id, reply.from!, now)
  await q.query(
    `INSERT INTO messages (chat_id, message_id, author_id, posted_at, content_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (chat_id, message_id) DO NOTHING`,
    [msg.chat.id, reply.message_id, reply.from!.id, new Date(reply.date * 1000), hashOf(reply as Message)],
  )
  await q.query('UPDATE messages SET reply_count = reply_count + 1 WHERE chat_id = $1 AND message_id = $2', [msg.chat.id, reply.message_id])
}

function repliedTo(msg: Message): string | null {
  const reply = replyOf(msg)
  if (!reply) return null
  const name = reply.sender_chat?.title ?? (reply.from ? displayName(reply.from) : 'chat')
  return line(name, truncateGraphemes(textOf(reply as Message) || '[media]', 500))
}

interface Enqueue {
  msg: Message
  settings: SettingsView
  isEdit: boolean
  isFirst: boolean
  probation: boolean
  now: Date
}

function metaFor(e: Enqueue, gen: number): EvalMeta {
  const { msg } = e
  const from = msg.from!
  const media = mediaOf(msg)
  return {
    authorId: from.id,
    authorName: displayName(from),
    postedAt: new Date(msg.date * 1000).toISOString(),
    gen,
    isEdit: e.isEdit,
    mediaKind: media?.kind ?? null,
    mediaOnly: Boolean(media) && !textOf(msg),
    hasLinks: hasLinks(msg),
    probation: e.probation,
    fetchBio: e.isFirst && !e.isEdit,
    mode: 'live',
  }
}

async function enqueue(q: Q, e: Enqueue): Promise<void> {
  const { msg, settings } = e
  const media = mediaOf(msg)
  const text = textOf(msg)
  if (!text && !media) return
  const from = msg.from!
  const state: JevState = {
    message: text,
    replied_to: repliedTo(msg),
    previous_messages: await previousLines(q, msg.chat.id, msg.message_id, settings.num('previous_messages_count')),
    sender_history: await senderHistory(q, { chatId: msg.chat.id, userId: from.id, messageId: msg.message_id }, new Date(msg.date * 1000)),
    media_description: null,
    sender_profile: e.isFirst ? { name: displayName(from), username: from.username ?? null, bio: null } : null,
  }
  const gen = e.isEdit ? (msg.edit_date ?? msg.date) : 0
  await enqueueEvaluation(q, { chatId: msg.chat.id, messageId: msg.message_id, gen, state, questions: settings.questions(), meta: metaFor(e, gen), media, now: e.now })
}

/** Section 3.6: only a new text, caption or attachment is an edit. A row without a hash (written before migration 005) only gets one. */
async function contentChanged(q: Q, msg: Message, stored: Buffer | null): Promise<boolean> {
  const hash = hashOf(msg)
  if (stored?.equals(hash)) return false
  await q.query('UPDATE messages SET content_hash = $3 WHERE chat_id = $1 AND message_id = $2', [msg.chat.id, msg.message_id, hash])
  return stored !== null
}

async function handleEdit(ctx: Ctx, q: Q, msg: Message): Promise<void> {
  const now = ctx.clock.now()
  const known = await q.query('SELECT author_id, content_hash FROM messages WHERE chat_id = $1 AND message_id = $2', [msg.chat.id, msg.message_id])
  if (known.length === 0 || known[0].author_id !== msg.from?.id) return
  if (!(await contentChanged(q, msg, known[0].content_hash))) return
  const member = await q.query('SELECT first_message_id FROM members WHERE chat_id = $1 AND user_id = $2', [msg.chat.id, msg.from!.id])
  const settings = await getSettings(q, msg.chat.id)
  await q.query('UPDATE messages SET excerpt = CASE WHEN deleted THEN NULL ELSE $3 END WHERE chat_id = $1 AND message_id = $2', [
    msg.chat.id,
    msg.message_id,
    textOf(msg) ? makeExcerpt(textOf(msg)) : null,
  ])
  const isFirst = member[0]?.first_message_id === msg.message_id
  await enqueue(q, { msg, settings, isEdit: true, isFirst, probation: false, now })
}

async function handleNewMessage(ctx: Ctx, q: Q, msg: Message): Promise<void> {
  const now = ctx.clock.now()
  const arrival = await registerArrival(q, msg)
  if (!arrival) return
  await registerReply(q, msg, now)
  const settings = await getSettings(q, msg.chat.id)
  if (isReportCommand(msg)) {
    await startReport(ctx, q, msg, settings)
    return
  }
  if (isSpamCommand(msg, ctx.env.botUsername)) {
    await startSpamCommand(ctx, q, msg)
    return
  }
  await enqueue(q, { msg, settings, isEdit: false, isFirst: arrival.isFirst, probation: arrival.probation, now })
}

function handlePrivate(ctx: Ctx, msg: Message, mode: { isEdit: boolean; posts: Post[] }): void {
  if (mode.isEdit || !msg.text?.startsWith('/start')) return
  mode.posts.push(async () => {
    await ctx.tg.sendMessage(msg.chat.id, 'Готов присылать сюда карточки для админов. Лидерборд и настройки - в Mini App группы.').catch(() => {})
  })
}

async function handleGroupMessage(ctx: Ctx, q: Q, msg: Message, isEdit: boolean): Promise<void> {
  const now = ctx.clock.now()
  await ensureChat(q, msg.chat, now)
  if (!isEdit && msg.sender_chat && msg.from && isSpamCommand(msg, ctx.env.botUsername)) return startSpamCommand(ctx, q, msg)
  for (const user of msg.new_chat_members ?? []) await markJoined(q, msg.chat.id, user, now)
  // Spec 3.6.0: what is not written by a person is not judged and counts nowhere.
  if (!msg.from || !fromPerson(msg)) return
  await upsertMember(q, msg.chat.id, msg.from, now)
  if (isEdit) await handleEdit(ctx, q, msg)
  else await handleNewMessage(ctx, q, msg)
}

async function handleMessage(ctx: Ctx, q: Q, msg: Message, mode: { isEdit: boolean; posts: Post[] }): Promise<void> {
  if (msg.chat.type === 'private') return handlePrivate(ctx, msg, mode)
  if (GROUP_TYPES.has(msg.chat.type)) await handleGroupMessage(ctx, q, msg, mode.isEdit)
}

const OUTSIDE = new Set(['left', 'kicked'])
const INSIDE = new Set(['member', 'restricted'])

async function handleMembership(ctx: Ctx, q: Q, update: Update): Promise<void> {
  const now = ctx.clock.now()
  const mine = update.my_chat_member
  if (mine && GROUP_TYPES.has(mine.chat.type)) {
    await ensureChat(q, mine.chat, now)
    return
  }
  const change = update.chat_member
  if (!change || !GROUP_TYPES.has(change.chat.type)) return
  await ensureChat(q, change.chat, now)
  const user = change.new_chat_member.user
  if (user.is_bot) return
  await upsertMember(q, change.chat.id, user, now)
  if (OUTSIDE.has(change.old_chat_member.status) && INSIDE.has(change.new_chat_member.status)) await markJoined(q, change.chat.id, user, now)
  // A new role lifts the "not subject to a tag" mark set for an administrator (section 3.12); a tag a person set stays theirs.
  const liftAdmin = `CASE WHEN tag_exempt = 'target_admin' AND $3 NOT IN ('administrator', 'creator') THEN NULL ELSE tag_exempt END`
  await q.query(`UPDATE members SET status = $3, tag_exempt = ${liftAdmin} WHERE chat_id = $1 AND user_id = $2`, [
    change.chat.id,
    user.id,
    change.new_chat_member.status,
  ])
}

async function route(ctx: Ctx, q: Q, update: Update, posts: Post[]): Promise<void> {
  const now = ctx.clock.now()
  if (update.message) await handleMessage(ctx, q, update.message, { isEdit: false, posts })
  else if (update.edited_message) await handleMessage(ctx, q, update.edited_message, { isEdit: true, posts })
  else if (update.message_reaction) {
    const r = update.message_reaction
    if (!GROUP_TYPES.has(r.chat.type)) return
    await ensureChat(q, r.chat, now)
    await handleReaction(q, await getSettings(q, r.chat.id), r, now)
  } else if (update.message_reaction_count) {
    const r = update.message_reaction_count
    await handleReactionCount(q, await getSettings(q, r.chat.id), r, now)
  } else if (update.chat_member || update.my_chat_member) await handleMembership(ctx, q, update)
  else if (update.callback_query) {
    const callback = update.callback_query
    posts.push(() => handleCallback(ctx, callback))
  }
}

/** Records the update and its database effects in one transaction, then runs what needs Telegram. Duplicates do nothing. */
export async function ingestUpdate(ctx: Ctx, update: Update): Promise<void> {
  const posts: Post[] = []
  await ctx.db.tx(async (q) => {
    const fresh = await q.query('INSERT INTO processed_updates (update_id, received_at) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [
      update.update_id,
      ctx.clock.now(),
    ])
    if (fresh.length === 0) return
    await route(ctx, q, update, posts)
  })
  for (const post of posts) await post()
}
