import { categoryTitle } from './categories.js'
import type { Q } from './db.js'
import { isChannelId } from './members.js'
import type { InlineButton, TextEntity } from './ports.js'
import { fitGraphemes, graphemeLength } from './text.js'

export type CardKind =
  | 'steamed'
  | 'spam_command'
  | 'review'
  | 'protected'
  | 'would_do'
  | 'media_unverified'
  | 'appeal_review'
  | 'target_admin'
  | 'no_rights'
  | 'delete_denied'
  | 'report'
  | 'edit_lowered'
  | 'op_failed'
  | 'punish_skipped'

export interface CardPayload {
  targetUserId?: number
  targetName?: string
  messageId?: number
  category?: string | null
  spam?: number | null
  /** What the bot did about the message, when the title alone does not say it. */
  done?: string
  reportId?: number
  privileged?: boolean
  probation?: boolean
  /** The only admin who gets the card (the private answer after /spam, section 3.6.2). */
  recipient?: number
  /** A card about a command message (its deletion failed): nothing to decide about it. */
  noActions?: boolean
}

export interface CardRow {
  card_id: number
  chat_id: number
  kind: CardKind
  payload: CardPayload
  status?: string
  /** The lines "Решение: ..." added after each press (section 3.6.2). */
  decision?: string | null
}

/** Section 3.6.3: every title is an ordinary phrase that says what the bot did or asks for a decision. */
const TITLES: Record<CardKind, string> = {
  steamed: 'Удалил спам и заглушил автора',
  spam_command: 'Удалил спам и заглушил автора',
  review: 'Похоже на спам, реши',
  protected: 'Похоже на спам от участника с высокой кармой, реши',
  would_do: 'Старая карточка, бот по ней ничего не сделал',
  media_unverified: 'Новичок прислал медиа без подписи, описать его не удалось, реши',
  appeal_review: 'Объяснение при разбане вызвало сомнение',
  target_admin: 'Участник - админ, наказывать не стал',
  no_rights: 'Не хватило прав, чтобы заглушить участника',
  delete_denied: 'Не смог удалить сообщение',
  report: 'Жалоба на сообщение',
  op_failed: 'Не смог выполнить действие в Telegram, подробности на экране админа',
  edit_lowered: 'Автор исправил сообщение, оно больше не похоже на спам; наказание осталось',
  punish_skipped: 'Наказание за низкую карму не применено: идёт неделя наблюдения',
}

/** Section 3.6.4: the message of a channel is deleted and the channel banned, by the bot or by /spam. */
const CHANNEL_BANNED = 'Удалил спам и забанил канал'
const CHANNEL_TITLED = new Set<CardKind>(['steamed', 'spam_command'])

function title(card: CardRow): string {
  const target = card.payload.targetUserId
  return target != null && isChannelId(target) && CHANNEL_TITLED.has(card.kind) ? CHANNEL_BANNED : TITLES[card.kind]
}

export const LEFT_IN_CHAT = 'ничего, сообщение осталось в чате'

/** What was done, for the kinds whose title does not say it and whose flow gives nothing more precise. */
const DONE: Partial<Record<CardKind, string>> = {
  report: `${LEFT_IN_CHAT} до решения админа`,
}

export type CardAction = 'spam' | 'notspam' | 'restore' | 'ban' | 'confirm' | 'return' | 'unban'

const LABELS: Record<CardAction, string> = {
  spam: 'Спам',
  notspam: 'Не спам',
  restore: 'Не спам, вернуть',
  ban: 'Забанить',
  confirm: 'Подтвердить',
  return: 'Вернуть',
  unban: 'Разбанить',
}

/**
 * The cards about a message whose buttons follow the state of the message and of the sanction (section 3.6.2), failures of an
 * automatic deletion included.
 */
export const SPAM_KINDS = new Set<CardKind>(['steamed', 'review', 'protected', 'media_unverified', 'edit_lowered', 'target_admin', 'delete_denied', 'no_rights', 'op_failed'])

export interface MessageState {
  inChat: boolean
  /** A bath record: the member is in the steam room or banned. */
  sanctioned: boolean
  banned: boolean
}

/** Failure cards are also about a member (a karma punishment); only those about a message get buttons. */
const FAILURE_KINDS = new Set<CardKind>(['delete_denied', 'no_rights', 'op_failed'])

function withBan(state: MessageState, first: CardAction): CardAction[] {
  return state.banned ? [first] : [first, 'ban']
}

/**
 * Section 3.6.2, the sanction first: sanctioned and still in the chat - «Не спам» (lifts it) and «Забанить»; deleted -
 * «Не спам, вернуть» and «Забанить»; in the chat without a sanction - «Спам», «Не спам». «Забанить» disappears once banned.
 */
function spamActions(state: MessageState): CardAction[] {
  if (state.sanctioned) return withBan(state, state.inChat ? 'notspam' : 'restore')
  return state.inChat ? ['spam', 'notspam'] : ['restore', 'ban']
}

export function allowedActions(card: CardRow, state: MessageState): CardAction[] {
  if ((card.status ?? 'open') !== 'open' || card.payload.noActions === true) return []
  if (card.kind === 'spam_command') return ['restore']
  if (card.kind === 'report') return ['confirm', 'return']
  if (card.kind === 'appeal_review') return ['unban', 'ban']
  if (!SPAM_KINDS.has(card.kind) || (FAILURE_KINDS.has(card.kind) && card.payload.messageId == null)) return []
  return spamActions(state)
}

const MEDIA_WORDS: Record<string, string> = {
  photo: 'фото',
  sticker: 'стикер',
  animation: 'гифка',
  video: 'видео',
  video_note: 'видеосообщение',
  voice: 'голосовое сообщение',
  audio: 'аудио',
  document: 'файл',
}

export function mediaWord(kind: string): string {
  return MEDIA_WORDS[kind] ?? 'вложение'
}

/** Telegram's limit on the text of one message, in UTF-16 code units. */
const MESSAGE_LIMIT = 4096
const QUOTE_LIMIT = 500
const UNAVAILABLE = 'Текст недоступен, откройте сообщение по ссылке.'

/** Section 3.6.1: `t.me/<username>/<id>` for a chat with a username, `t.me/c/<id without -100>/<id>` otherwise. */
function messageLink(chatId: number, chatUsername: string | null, messageId: number): string {
  if (chatUsername) return `https://t.me/${chatUsername}/${messageId}`
  const id = String(chatId)
  return `https://t.me/c/${id.startsWith('-100') ? id.slice(4) : id.replace(/^-/, '')}/${messageId}`
}

interface Held {
  text: string
  media_kind: string | null
}

interface Known {
  username: string | null
  link: string | null
  held: Held | null
  state: MessageState
}

export async function messageState(q: Q, card: CardRow): Promise<MessageState> {
  const p = card.payload
  const msg = p.messageId == null ? [] : await q.query('SELECT deleted FROM messages WHERE chat_id = $1 AND message_id = $2', [card.chat_id, p.messageId])
  const ban = p.targetUserId == null ? [] : await q.query('SELECT state FROM bans WHERE chat_id = $1 AND user_id = $2', [card.chat_id, p.targetUserId])
  return { inChat: msg.length > 0 && msg[0].deleted === false, sanctioned: ban.length > 0, banned: ban[0]?.state === 'banned' }
}

async function lookUp(q: Q, card: CardRow, now: Date): Promise<Known> {
  const p = card.payload
  const member = p.targetUserId == null ? [] : await q.query('SELECT username FROM members WHERE chat_id = $1 AND user_id = $2', [card.chat_id, p.targetUserId])
  const username = (member[0]?.username as string | undefined) ?? null
  const state = await messageState(q, card)
  if (p.messageId == null) return { username, link: null, held: null, state }
  const chat = await q.query('SELECT username FROM chats WHERE chat_id = $1', [card.chat_id])
  const held = await q.query<Held>('SELECT text, media_kind FROM held_texts WHERE chat_id = $1 AND message_id = $2 AND expires_at > $3', [card.chat_id, p.messageId, now])
  return { username, link: messageLink(card.chat_id, chat[0]?.username ?? null, p.messageId), held: held[0] ?? null, state }
}

function doneLine(card: CardRow): string[] {
  const done = card.payload.done ?? DONE[card.kind]
  return done ? [`Сделал: ${done}`] : []
}

function member(p: CardPayload, username: string | null): string[] {
  if (!p.targetName) return []
  return [`Участник: ${p.targetName}${username ? ` (@${username})` : ''}`]
}

/**
 * Section 3.6.3: the score as a percentage. A card about a message without a score says so (section 3.6.1); a decision of an
 * admin (/spam) and a card about a member have no score to show.
 */
function confidence(p: CardPayload, aboutMessage: boolean): string[] {
  if (p.spam != null) return [`Уверенность: ${Math.round(p.spam * 100)}%`]
  return aboutMessage && p.category !== 'admin' ? ['Уверенность: нет данных'] : []
}

function decisions(card: CardRow): string[] {
  return card.decision ? card.decision.split('\n') : []
}

/** The lines above the quote, in the order of section 3.6.3: title, member, category, confidence. */
function topLines(card: CardRow, username: string | null, aboutMessage: boolean): string[] {
  const p = card.payload
  const category = aboutMessage ? [`Категория: ${p.category ? categoryTitle(p.category) : 'не определена'}`] : p.category ? [`Категория: ${categoryTitle(p.category)}`] : []
  return [title(card), ...doneLine(card), ...member(p, username), ...category, ...confidence(p, aboutMessage)]
}

interface QuoteBlock {
  before: string[]
  quote: string | null
  after: string[]
}

/**
 * The member's text is data: no markup is applied; it is cut to 500 clusters and to what is left of the message limit, with
 * a mark. `units` is the limit minus the other lines joined; the quote adds itself, «…», the note and three line breaks.
 */
function quoteBlock(held: Held | null, units: number): QuoteBlock {
  if (!held) return { before: [UNAVAILABLE], quote: null, after: [] }
  const media = held.media_kind ? `Вложение: ${mediaWord(held.media_kind)}` : null
  if (!held.text) return { before: [media ? `${media}, без подписи` : UNAVAILABLE], quote: null, after: [] }
  const before = media ? [`${media}, подпись:`] : []
  const total = graphemeLength(held.text)
  const note = (shown: number): string => `(первые ${shown} из ${total} знаков)`
  const reserve = (before.length > 0 ? before.join('\n').length + 1 : 0) + note(Math.min(QUOTE_LIMIT, total)).length + 3
  const fitted = fitGraphemes(held.text, QUOTE_LIMIT, units - reserve)
  const cut = fitted.count < total
  return { before, quote: cut ? `${fitted.text}…` : fitted.text, after: cut ? [note(fitted.count)] : [] }
}

/** The quote is a blockquote entity whose offset and length are in UTF-16 code units (JavaScript string indices). */
function assemble(top: string[], block: QuoteBlock, bottom: string[]): { text: string; entities: TextEntity[] } {
  const lines = [...top, ...block.before]
  if (block.quote === null) return { text: [...lines, ...block.after, ...bottom].join('\n'), entities: [] }
  const prefix = `${lines.join('\n')}\n`
  const text = [prefix + block.quote, ...block.after, ...bottom].join('\n')
  return { text, entities: [{ type: 'blockquote', offset: prefix.length, length: block.quote.length }] }
}

function buttons(card: CardRow, link: string | null, state: MessageState): InlineButton[][] {
  const actions = allowedActions(card, state).map((action) => ({ text: LABELS[action], callback_data: `c:${card.card_id}:${action}` }))
  return [...(link ? [[{ text: 'Открыть сообщение', url: link }]] : []), ...(actions.length > 0 ? [actions] : [])]
}

export interface RenderedCard {
  text: string
  entities: TextEntity[]
  link: string | null
  buttons: InlineButton[][]
  state: MessageState
}

/** The card as admins get it: text, quote entity, the link for «Открыть сообщение» (null without a message) and the buttons. */
export async function renderCard(q: Q, card: CardRow, now: Date): Promise<RenderedCard> {
  const known = await lookUp(q, card, now)
  const extra = { buttons: buttons(card, known.link, known.state), state: known.state }
  if (known.link === null) {
    const text = [...topLines(card, known.username, false), ...decisions(card)].join('\n')
    return { text, entities: [], link: null, ...extra }
  }
  const top = topLines(card, known.username, true)
  const bottom = [`Ссылка: ${known.link}`, ...decisions(card)]
  const used = [...top, ...bottom].join('\n').length
  return { ...assemble(top, quoteBlock(known.held, MESSAGE_LIMIT - used), bottom), link: known.link, ...extra }
}
