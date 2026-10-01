import type { Update } from 'grammy/types'
import {
  JevError,
  TelegramError,
  type ChatInfo,
  type ChatMemberInfo,
  type ChatPermissions,
  type Clock,
  type JevAnswer,
  type JevClient,
  type JevRequest,
  type JevResponse,
  type Rng,
  type SendOptions,
  type TelegramApi,
  type VisionClient,
  type VisionRequest,
} from '../../src/ports.js'

export class FakeClock implements Clock {
  constructor(private time: number) {}
  now(): Date {
    return new Date(this.time)
  }
  set(iso: string): void {
    this.time = Date.parse(iso)
  }
  advance(ms: number): void {
    this.time += ms
  }
  async sleep(ms: number): Promise<void> {
    this.time += ms
  }
}

export class SeqRng implements Rng {
  private i = 0
  constructor(private readonly values: number[] = [0]) {}
  next(): number {
    return this.values[this.i++ % this.values.length]
  }
}

export interface Call {
  method: string
  args: unknown[]
}

export const DEFAULT_PERMISSIONS: ChatPermissions = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
}

type Failure = { error: Error; times: number }

export class FakeTelegram implements TelegramApi {
  readonly calls: Call[] = []
  members = new Map<number, ChatMemberInfo['status']>()
  /** The status in one chat, by `chatId:userId`; wins over `members`. */
  statusIn = new Map<string, ChatMemberInfo['status']>()
  /** Users Telegram reports as bots. */
  bots = new Set<number>()
  /** Member tags as Telegram holds them. */
  tags = new Map<number, string>()
  admins: Array<{ user_id: number; is_bot: boolean }> = []
  chatInfo: ChatInfo = { permissions: DEFAULT_PERMISSIONS }
  bios = new Map<number, string>()
  files = new Map<string, { path: string; size: number }>()
  failures = new Map<string, Failure[]>()
  updates: Update[] = []
  private nextMessageId = 9000
  callbackAnswers: Array<{ id: string; text?: string }> = []

  fail(method: string, error: Error, times = 1): void {
    const list = this.failures.get(method) ?? []
    list.push({ error, times })
    this.failures.set(method, list)
  }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method)
  }

  count(method: string): number {
    return this.of(method).length
  }

  private enter(method: string, args: unknown[]): void {
    this.calls.push({ method, args })
    const list = this.failures.get(method)
    const failure = list?.[0]
    if (!failure) return
    failure.times--
    if (failure.times <= 0) list!.shift()
    throw failure.error
  }

  async getMe() {
    return { id: 777, username: 'jevchik_bot' }
  }
  async getUpdates(offset: number): Promise<Update[]> {
    this.enter('getUpdates', [offset])
    const batch = this.updates.filter((u) => u.update_id >= offset)
    return batch
  }
  async sendMessage(chatId: number, text: string, options?: SendOptions) {
    this.enter('sendMessage', options?.entities ? [chatId, text, options.buttons, options.entities] : [chatId, text, options?.buttons])
    return { message_id: this.nextMessageId++ }
  }
  async editMessageText(chatId: number, messageId: number, text: string, options?: SendOptions) {
    this.enter('editMessageText', [chatId, messageId, text, options?.buttons, options?.entities])
  }
  async deleteMessage(chatId: number, messageId: number) {
    this.enter('deleteMessage', [chatId, messageId])
  }
  async restrictChatMember(chatId: number, userId: number, permissions: ChatPermissions, untilDate?: number) {
    this.enter('restrictChatMember', [chatId, userId, permissions, untilDate])
  }
  async banChatMember(chatId: number, userId: number) {
    this.enter('banChatMember', [chatId, userId])
  }
  async unbanChatMember(chatId: number, userId: number) {
    this.enter('unbanChatMember', [chatId, userId])
  }
  async banChatSenderChat(chatId: number, senderChatId: number) {
    this.enter('banChatSenderChat', [chatId, senderChatId])
  }
  async unbanChatSenderChat(chatId: number, senderChatId: number) {
    this.enter('unbanChatSenderChat', [chatId, senderChatId])
  }
  async setMessageReaction(chatId: number, messageId: number, emoji: string) {
    this.enter('setMessageReaction', [chatId, messageId, emoji])
  }
  async setChatMemberTag(chatId: number, userId: number, tag: string) {
    this.enter('setChatMemberTag', [chatId, userId, tag])
    this.tags.set(userId, tag)
  }
  async getChatMember(chatId: number, userId: number): Promise<ChatMemberInfo> {
    this.enter('getChatMember', [chatId, userId])
    const tag = this.tags.get(userId)
    return { status: this.statusIn.get(`${chatId}:${userId}`) ?? this.members.get(userId) ?? 'member', ...(this.bots.has(userId) ? { is_bot: true } : {}), ...(tag !== undefined ? { tag } : {}) }
  }
  async getChatAdministrators(chatId: number) {
    this.enter('getChatAdministrators', [chatId])
    return this.admins
  }
  async getChat(chatId: number): Promise<ChatInfo> {
    this.enter('getChat', [chatId])
    const bio = this.bios.get(chatId)
    return bio !== undefined ? { ...this.chatInfo, bio } : this.chatInfo
  }
  async getFile(fileId: string) {
    this.enter('getFile', [fileId])
    const file = this.files.get(fileId)
    return file ? { file_path: file.path, file_size: file.size } : { file_path: `photos/${fileId}.jpg`, file_size: 1000 }
  }
  async downloadFile(path: string) {
    this.enter('downloadFile', [path])
    return new Uint8Array([1, 2, 3])
  }
  async answerCallbackQuery(id: string, text?: string) {
    this.enter('answerCallbackQuery', [id, text])
    this.callbackAnswers.push({ id, text })
  }
}

export const tgError = {
  network: () => new TelegramError('network', 'ECONNRESET'),
  server: () => new TelegramError('server', 'Bad Gateway', 502),
  rate: (seconds = 1) => new TelegramError('rate_limit', 'Too Many Requests', 429, seconds),
  lost: () => new TelegramError('unknown_outcome', 'timeout after send'),
  bad: (text = 'Bad Request', code = 400) => new TelegramError('client', text, code),
}

export type Scripted = Record<string, number | { score: number; confidence?: number } | { choice: string }>

export function buildAnswers(request: JevRequest, script: Scripted): Record<string, JevAnswer> {
  const answers: Record<string, JevAnswer> = {}
  for (const [name, question] of Object.entries(request.questions as Record<string, { type: string }>)) {
    const value = script[name]
    if (question.type === 'noul') answers[name] = { type: 'noul', noul: typeof value === 'number' ? value : 0.05 }
    else if (question.type === 'score') {
      const v = (value ?? { score: 1, confidence: 0.6 }) as { score: number; confidence?: number }
      answers[name] = { type: 'score', score: v.score, confidence: v.confidence ?? 0.8 }
    } else {
      const v = (value ?? { choice: 'serious' }) as { choice: string }
      answers[name] = { type: 'choice', choice: v.choice, confidence: 0.9 }
    }
  }
  return answers
}

export class FakeJev implements JevClient {
  readonly requests: JevRequest[] = []
  /** Answers by message text; missing text means a benign default. */
  scripts = new Map<string, Scripted>()
  defaultScript: Scripted = {}
  failures: Array<Error> = []
  raw: ((request: JevRequest) => JevResponse) | null = null

  script(text: string, script: Scripted): void {
    this.scripts.set(text, script)
  }

  async evaluate(request: JevRequest): Promise<JevResponse> {
    this.requests.push(JSON.parse(JSON.stringify(request)))
    const failure = this.failures.shift()
    if (failure) throw failure
    if (this.raw) return this.raw(request)
    const text = String(request.state.message)
    return { answers: buildAnswers(request, this.scripts.get(text) ?? this.defaultScript) }
  }
}

export const jevDown = () => new JevError('transient', 'network')

export class FakeVision implements VisionClient {
  readonly requests: VisionRequest[] = []
  text = 'a cat photo'
  failure: Error | null = null
  delayMs = 0
  async describe(request: VisionRequest): Promise<string> {
    this.requests.push(request)
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    if (this.failure) throw this.failure
    return this.text
  }
}
