import { Api, GrammyError, HttpError } from 'grammy'
import type { Update } from 'grammy/types'
import {
  TelegramError,
  type ChatInfo,
  type ChatMemberInfo,
  type ChatPermissions,
  type SendOptions,
  type TelegramApi,
} from '../ports.js'

export const ALLOWED_UPDATES = ['message', 'edited_message', 'message_reaction', 'message_reaction_count', 'chat_member', 'my_chat_member', 'callback_query'] as const

const SAFE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

function mapGrammy(error: GrammyError): TelegramError {
  const code = error.error_code
  if (code === 429) return new TelegramError('rate_limit', error.description, code, error.parameters?.retry_after ?? 1)
  return new TelegramError(code >= 500 ? 'server' : 'client', error.description, code)
}

function mapHttp(error: HttpError): TelegramError {
  const cause = error.error as { code?: string; cause?: { code?: string } } | undefined
  const code = cause?.code ?? cause?.cause?.code ?? ''
  return new TelegramError(SAFE_NETWORK_CODES.has(code) ? 'network' : 'unknown_outcome', error.message)
}

export function mapError(error: unknown): TelegramError {
  if (error instanceof GrammyError) return mapGrammy(error)
  if (error instanceof HttpError) return mapHttp(error)
  return new TelegramError('network', String(error))
}

/** No parse_mode: the member's text never becomes markup; the quote is an entity (section 3.6.3). */
function messageOptions(options?: SendOptions): { reply_markup?: never; entities?: never; link_preview_options: { is_disabled: true } } {
  return {
    reply_markup: options?.buttons ? ({ inline_keyboard: options.buttons } as never) : undefined,
    entities: options?.entities as never,
    link_preview_options: { is_disabled: true },
  }
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw mapError(error)
  }
}

export class GrammyTelegram implements TelegramApi {
  private readonly api: Api

  constructor(private readonly token: string, apiRoot?: string) {
    this.api = new Api(token, apiRoot ? { apiRoot } : undefined)
  }

  getMe() {
    return call(async () => {
      const me = await this.api.getMe()
      return { id: me.id, username: me.username }
    })
  }

  getUpdates(offset: number, timeoutSec: number): Promise<Update[]> {
    return call(() => this.api.getUpdates({ offset, timeout: timeoutSec, allowed_updates: [...ALLOWED_UPDATES] }))
  }

  sendMessage(chatId: number, text: string, options?: SendOptions) {
    return call(async () => {
      const sent = await this.api.sendMessage(chatId, text, messageOptions(options))
      return { message_id: sent.message_id }
    })
  }

  editMessageText(chatId: number, messageId: number, text: string, options?: SendOptions): Promise<void> {
    return call(async () => void (await this.api.editMessageText(chatId, messageId, text, messageOptions(options))))
  }

  deleteMessage(chatId: number, messageId: number): Promise<void> {
    return call(async () => void (await this.api.deleteMessage(chatId, messageId)))
  }

  restrictChatMember(chatId: number, userId: number, permissions: ChatPermissions, untilDate?: number): Promise<void> {
    return call(async () => void (await this.api.restrictChatMember(chatId, userId, permissions, { until_date: untilDate, use_independent_chat_permissions: true })))
  }

  banChatMember(chatId: number, userId: number): Promise<void> {
    return call(async () => void (await this.api.banChatMember(chatId, userId)))
  }

  unbanChatMember(chatId: number, userId: number): Promise<void> {
    return call(async () => void (await this.api.unbanChatMember(chatId, userId, { only_if_banned: true })))
  }

  setMessageReaction(chatId: number, messageId: number, emoji: string): Promise<void> {
    return call(async () => void (await this.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji: emoji as never }])))
  }

  setChatMemberTag(chatId: number, userId: number, tag: string): Promise<void> {
    return call(async () => void (await this.api.setChatMemberTag(chatId, userId, tag)))
  }

  getChatMember(chatId: number, userId: number): Promise<ChatMemberInfo> {
    return call(async () => {
      const member = await this.api.getChatMember(chatId, userId)
      return { status: member.status, is_bot: member.user.is_bot, tag: 'tag' in member ? member.tag : undefined }
    })
  }

  getChatAdministrators(chatId: number) {
    return call(async () => (await this.api.getChatAdministrators(chatId)).map((m) => ({ user_id: m.user.id, is_bot: m.user.is_bot })))
  }

  getChat(chatId: number): Promise<ChatInfo> {
    return call(async () => {
      const chat = (await this.api.getChat(chatId)) as { title?: string; username?: string; bio?: string; permissions?: ChatPermissions }
      return { title: chat.title, username: chat.username, bio: chat.bio, permissions: chat.permissions }
    })
  }

  getFile(fileId: string) {
    return call(async () => {
      const file = await this.api.getFile(fileId)
      return { file_path: file.file_path, file_size: file.file_size }
    })
  }

  downloadFile(filePath: string): Promise<Uint8Array> {
    return call(async () => {
      const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new GrammyError(`download ${response.status}`, { ok: false, error_code: response.status, description: 'download failed' }, 'getFile', {})
      return new Uint8Array(await response.arrayBuffer())
    })
  }

  answerCallbackQuery(callbackId: string, text?: string): Promise<void> {
    return call(async () => void (await this.api.answerCallbackQuery(callbackId, { text })))
  }
}
