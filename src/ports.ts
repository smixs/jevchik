import type { Update } from 'grammy/types'

export interface Clock {
  now(): Date
  sleep(ms: number): Promise<void>
}

export interface Rng {
  next(): number
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

export const systemRng: Rng = { next: () => Math.random() }

export type TelegramErrorKind = 'rate_limit' | 'server' | 'network' | 'client' | 'unknown_outcome'

export class TelegramError extends Error {
  constructor(
    public readonly kind: TelegramErrorKind,
    message: string,
    public readonly code?: number,
    public readonly retryAfter?: number,
  ) {
    super(message)
    this.name = 'TelegramError'
  }
}

export interface ChatPermissions {
  can_send_messages: boolean
  can_send_audios: boolean
  can_send_documents: boolean
  can_send_photos: boolean
  can_send_videos: boolean
  can_send_video_notes: boolean
  can_send_voice_notes: boolean
  can_send_polls: boolean
  can_send_other_messages: boolean
  can_add_web_page_previews: boolean
}

export interface InlineButton {
  text: string
  url?: string
  callback_data?: string
}

/** Section 3.6.3: the quote of a card is a Telegram blockquote; offset and length are in UTF-16 code units. */
export interface TextEntity {
  type: 'blockquote'
  offset: number
  length: number
}

export interface SendOptions {
  buttons?: InlineButton[][]
  entities?: TextEntity[]
}

export interface ChatMemberInfo {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked'
  is_bot?: boolean
  /** The member tag, for members and restricted members. */
  tag?: string
}

export interface ChatInfo {
  title?: string
  username?: string
  bio?: string
  permissions?: ChatPermissions
}

interface FileInfo {
  file_path?: string
  file_size?: number
}

export interface TelegramApi {
  getMe(): Promise<{ id: number; username: string }>
  getUpdates(offset: number, timeoutSec: number): Promise<Update[]>
  sendMessage(chatId: number, text: string, options?: SendOptions): Promise<{ message_id: number }>
  deleteMessage(chatId: number, messageId: number): Promise<void>
  restrictChatMember(chatId: number, userId: number, permissions: ChatPermissions, untilDate?: number): Promise<void>
  banChatMember(chatId: number, userId: number): Promise<void>
  unbanChatMember(chatId: number, userId: number): Promise<void>
  /** Section 3.6.4: a channel that writes in the group is banned there as a sender chat. */
  banChatSenderChat(chatId: number, senderChatId: number): Promise<void>
  unbanChatSenderChat(chatId: number, senderChatId: number): Promise<void>
  setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<void>
  setChatMemberTag(chatId: number, userId: number, tag: string): Promise<void>
  getChatMember(chatId: number, userId: number): Promise<ChatMemberInfo>
  getChatAdministrators(chatId: number): Promise<Array<{ user_id: number; is_bot: boolean }>>
  getChat(chatId: number): Promise<ChatInfo>
  getFile(fileId: string): Promise<FileInfo>
  downloadFile(filePath: string): Promise<Uint8Array>
  answerCallbackQuery(callbackId: string, text?: string): Promise<void>
  editMessageText(chatId: number, messageId: number, text: string, options?: SendOptions): Promise<void>
}

export interface JevAnswer {
  type: 'noul' | 'score' | 'choice'
  noul?: number
  score?: number
  choice?: string
  confidence?: number
  probabilities?: Record<string, number>
}

export interface JevRequest {
  state: Record<string, unknown>
  model: string
  questions: Record<string, unknown>
}

export interface JevResponse {
  answers: Record<string, JevAnswer>
  usage?: { input_tokens?: number }
}

export type JevErrorKind = 'transient' | 'rate_limit' | 'reject' | 'garbage'

export class JevError extends Error {
  public readonly status?: number
  public readonly retryAfter?: number
  public readonly body?: string

  constructor(
    public readonly kind: JevErrorKind,
    message: string,
    details: { status?: number; retryAfter?: number; body?: string } = {},
  ) {
    super(message)
    this.name = 'JevError'
    this.status = details.status
    this.retryAfter = details.retryAfter
    this.body = details.body
  }
}

export interface JevClient {
  evaluate(request: JevRequest): Promise<JevResponse>
}

export interface VisionRequest {
  image: Uint8Array
  mime: string
}

export interface VisionClient {
  describe(request: VisionRequest): Promise<string>
}

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
}

export const consoleLogger: Logger = {
  info: (event, fields) => console.log(JSON.stringify({ level: 'info', event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: 'warn', event, ...fields })),
  error: (event, fields) => console.error(JSON.stringify({ level: 'error', event, ...fields })),
}
