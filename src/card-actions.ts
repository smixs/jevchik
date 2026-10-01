import { allowedActions, mediaWord, messageState, SPAM_KINDS, type CardAction, type CardRow, type MessageState } from './card-text.js'
import { submitCardEdits } from './cards.js'
import type { Ctx } from './ctx.js'
import type { Q } from './db.js'
import { createFlow, registerFlow, withReport, type Flow, type StepResult } from './flows.js'
import { execOp } from './ops.js'
import { adminBanRecord, banCall, checkTarget, deleteStep, dropJokes, jokePicks, liftStep, markDeleted, markFlow, STEAM_ACTION_STEPS, unbanRecord } from './sanctions.js'
import { getSettings } from './settings/settings.js'
import { fitGraphemes } from './text.js'

// Section 3.6.2: what each button of a card does, and the answer of the bot: a popup, and the line «Решение: ...» with the
// actions still allowed, on the card of every admin who got it.

const REASONS: Record<string, string> = {
  no_rights: 'нет прав',
  target_admin: 'участник - админ',
  denied: 'Telegram отказал',
  client_error: 'Telegram отказал',
  lost_response: 'ответ Telegram потерян',
  cancelled: 'действие отменено',
  expired: 'истёк срок',
}

const reason = (code: string | null): string => REASONS[code ?? ''] ?? 'Telegram не ответил'

interface Parts {
  done: string[]
  failed: string[]
}

type Ops = Map<string, { status: string; code: string | null }>

async function opsOf(ctx: Ctx, flow: Flow): Promise<Ops> {
  const rows = await ctx.db.query('SELECT idempotency_key, status, last_error_code FROM operations WHERE chat_id = $1 AND idempotency_key LIKE $2', [flow.chatId, `${flow.key}:%`])
  return new Map(rows.map((r) => [(r.idempotency_key as string).slice(flow.key.length + 1), { status: r.status as string, code: r.last_error_code as string | null }]))
}

/** One operation of the flow in words: done, not done with the reason, or nothing when it never started. */
function step(parts: Parts, op: { status: string; code: string | null } | undefined, words: [done: string, failed: string]): void {
  if (!op) return
  if (op.status === 'completed') parts.done.push(words[0])
  else if (op.status === 'failed' || op.status === 'outcome_unknown') parts.failed.push(`${words[1]}: ${reason(op.code)}`)
}

const HALTS: Record<string, string> = { target_admin: 'участник - админ, наказывать не стал', role_unknown: 'проверить роль участника не смог' }

function halted(parts: Parts, data: Flow['data']): void {
  if (typeof data.halt === 'string') parts.failed.push(HALTS[data.halt])
}

function steamParts(ops: Ops, data: Flow['data']): Parts {
  const parts: Parts = { done: [], failed: [] }
  halted(parts, data)
  step(parts, ops.get('delete'), ['сообщение удалено', 'сообщение удалить не смог'])
  step(parts, ops.get('restrict'), ['участник заглушён', 'заглушить участника не смог'])
  // Section 3.6.4: a channel is banned instead of being muted.
  step(parts, ops.get('ban'), ['участник забанен', 'забанить участника не смог'])
  return parts
}

function banParts(ops: Ops, data: Flow['data']): Parts {
  const parts: Parts = { done: [], failed: [] }
  halted(parts, data)
  step(parts, ops.get('delete'), ['сообщение удалено', 'сообщение удалить не смог'])
  step(parts, ops.get('ban'), ['участник забанен', 'забанить участника не смог'])
  return parts
}

/** Only a refusal of rights is a ban on writing; a 400 (the length, anything else) is Telegram's refusal. */
const PUBLISH_REASONS = new Set(['no_rights'])

function restoreParts(ops: Ops, data: Flow['data']): Parts {
  const parts: Parts = { done: [], failed: [] }
  const lift: [string, string] = data.liftKind === 'banned' ? ['бан снят', 'снять бан не смог'] : ['ограничение снято', 'снять ограничение не смог']
  step(parts, ops.get('lift'), lift)
  if (data.recordDropped === true) parts.done.push(data.probation === true ? 'запись в бане удалена, испытательный срок назначен' : 'запись в бане удалена')
  if (data.noText === true) parts.failed.push('вернуть не смог: текста уже нет')
  publishPart(parts, ops.get('publish'))
  return parts
}

/** Section 4, T-restore: the message could not be published; a refusal of Telegram means the chat does not let the bot write. */
function publishPart(parts: Parts, publish: { status: string; code: string | null } | undefined): void {
  if (publish?.status === 'completed') parts.done.push('сообщение возвращено в чат')
  else if (publish?.status === 'failed' || publish?.status === 'outcome_unknown') {
    parts.failed.push(`вернуть не смог: ${PUBLISH_REASONS.has(publish.code ?? '') ? 'чат не даёт боту писать' : reason(publish.code)}`)
  }
}

function joined(parts: Parts): string {
  const done = parts.done.join(', ')
  const failed = parts.failed.join('; ')
  if (!done && !failed) return 'ничего не сделано'
  return done && failed ? `${done}; ${failed}` : done || failed
}

/** The result of a flow in one phrase: what was done, then what was not, with the reason (section 3.6.2). */
export async function summarize(ctx: Ctx, flow: Flow): Promise<string> {
  const d = flow.data
  if (typeof d.note === 'string') return d.note
  const ops = await opsOf(ctx, flow)
  if (d.action === 'ban') return joined(banParts(ops, d))
  if (d.action === 'restore' || d.action === 'unban' || d.unsanction === true) return joined(restoreParts(ops, d))
  return joined(steamParts(ops, d))
}

/** Day, month, year and time in the chat time zone: 09.09.2026 17:00. */
export function formatWhen(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`
}

export async function decisionLine(ctx: Ctx, chatId: number, summary: string, adminName: string): Promise<string> {
  const settings = await getSettings(ctx.db, chatId)
  return `Решение: ${summary}. ${adminName}, ${formatWhen(ctx.clock.now(), settings.str('timezone'))}`
}

/** Actions after which nothing is left to decide. «Забанить» on a spam card still allows «Не спам, вернуть». */
function closes(card: CardRow, action: CardAction): boolean {
  if (action === 'spam') return false
  return !(action === 'ban' && SPAM_KINDS.has(card.kind))
}

/** The last step of every card flow: the decision is written once, the card is closed if nothing is left, the cards are edited. */
async function decide(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const d = flow.data
  const summary = await summarize(ctx, flow)
  const line = await decisionLine(ctx, flow.chatId, summary, d.adminName)
  await ctx.db.tx(async (q) => {
    const first = await q.query(`UPDATE flows SET data = data || $2 WHERE flow_id = $1 AND NOT data ? 'summary' RETURNING 1`, [flow.flowId, JSON.stringify({ summary })])
    if (first.length === 0) return
    const rows = await q.query<CardRow>('SELECT * FROM admin_cards WHERE card_id = $1', [d.cardId])
    const close = closes(rows[0], d.action)
    const updated = await q.query<CardRow>(
      `UPDATE admin_cards SET decision = CASE WHEN decision IS NULL THEN $2 ELSE decision || E'\\n' || $2 END,
         status = CASE WHEN $3 THEN 'resolved' ELSE status END, resolution = CASE WHEN $3 THEN $4 ELSE resolution END
       WHERE card_id = $1 RETURNING *`,
      [d.cardId, line, close, d.action],
    )
    await submitCardEdits(q, updated[0], ctx.clock.now(), d.action)
  })
  flow.data.summary = summary
  return 'ok'
}

// ---------------------------------------------------------------- the steps of the buttons

async function deleteIfInChat(ctx: Ctx, flow: Flow): Promise<StepResult> {
  return flow.data.inChat === true ? deleteStep(ctx, flow) : 'ok'
}

/** «Не спам, вернуть»: a restriction or a ban is lifted when there is one; nothing to lift is not a failure. */
async function liftSanction(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const rows = await ctx.db.query('SELECT state FROM bans WHERE chat_id = $1 AND user_id = $2', [flow.chatId, flow.data.userId])
  if (!rows[0] && flow.data.liftKind === undefined) return 'ok'
  if (flow.data.liftKind === undefined) await markFlow(ctx, flow, { liftKind: rows[0].state })
  return liftStep(ctx, flow)
}

/** «Разбанить» on a request to an administrator lifts silently, like the button in the Mini App (section 3.6.5). */
async function requestJokes(ctx: Ctx, flow: Flow): Promise<StepResult> {
  return flow.data.request === true ? dropJokes(ctx, flow) : 'ok'
}

async function dropRecord(ctx: Ctx, flow: Flow): Promise<StepResult> {
  if (flow.data.liftKind === undefined) return 'ok'
  await unbanRecord(ctx, flow)
  await markFlow(ctx, flow, { recordDropped: true })
  return 'ok'
}

interface HeldRow {
  author_name: string
  text: string
  media_kind: string | null
}

/** Telegram's limit on the text of one message, in UTF-16 code units. */
const MESSAGE_LIMIT = 4096
const CUT_MARK = ' (обрезано)'

/**
 * Section 3.6.2: `<имя автора>: <текст>`; an attachment gives its caption and a mark of the attachment. The whole stays within
 * the message limit, cut by grapheme clusters with a mark.
 */
function restoredText(held: HeldRow): string {
  const body = held.media_kind ? `[${mediaWord(held.media_kind)}]${held.text ? ` ${held.text}` : ''}` : held.text
  const prefix = `${held.author_name}: `
  if (prefix.length + body.length <= MESSAGE_LIMIT) return prefix + body
  return prefix + fitGraphemes(body, Number.MAX_SAFE_INTEGER, MESSAGE_LIMIT - prefix.length - CUT_MARK.length).text + CUT_MARK
}

async function publishText(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const d = flow.data
  const rows = await ctx.db.query<HeldRow>('SELECT author_name, text, media_kind FROM held_texts WHERE chat_id = $1 AND message_id = $2 AND expires_at > $3', [flow.chatId, d.messageId, ctx.clock.now()])
  if (!rows[0] || (!rows[0].text && !rows[0].media_kind)) {
    await markFlow(ctx, flow, { noText: true })
    return 'ok'
  }
  const outcome = await execOp(ctx, { chatId: flow.chatId, key: `${flow.key}:publish`, kind: 'send_message', payload: { text: restoredText(rows[0]), memberText: true } })
  // The kept text stays until its term: the card goes on quoting the message it was about.
  return outcome.status === 'pending' || outcome.status === 'running' ? 'wait' : 'ok'
}

export function registerCardActionFlows(): void {
  registerFlow('card_spam', withReport([checkTarget, ...STEAM_ACTION_STEPS], decide))
  // the role of the target is checked before the message is touched; an admin, the owner or an unknown role stops it.
  registerFlow('card_ban', withReport([checkTarget, deleteIfInChat, markDeleted, banCall, adminBanRecord], decide))
  registerFlow('card_restore', withReport([liftSanction, dropRecord, publishText], decide))
  registerFlow('card_unban', withReport([liftSanction, requestJokes, dropRecord], decide))
  registerFlow('card_unsanction', withReport([liftSanction, dropRecord], decide))
  registerFlow('card_note', [decide])
}

// ---------------------------------------------------------------- starting an action

const FLOW_KINDS: Record<CardAction, string> = {
  spam: 'card_spam',
  ban: 'card_ban',
  restore: 'card_restore',
  unban: 'card_unban',
  notspam: 'card_note',
  confirm: 'card_note',
  return: 'card_note',
  keep: 'card_note',
}

/**
 * The buttons shown, and «Забанить» on a message still in the chat: section 3.6.2 has it delete the message first
 * (a card sent before the new buttons still carries it).
 */
function acceptedActions(card: CardRow, state: MessageState): CardAction[] {
  const shown = allowedActions(card, state)
  return SPAM_KINDS.has(card.kind) && state.inChat && shown.length > 0 && !shown.includes('ban') && !state.banned ? [...shown, 'ban'] : shown
}

/** Buttons of cards sent before section 3.6.2: «Разбанить» and «Это не спам» on a deleted message mean «Не спам, вернуть». */
function normalize(card: CardRow, action: string, state: MessageState): string {
  if (!SPAM_KINDS.has(card.kind)) return action
  if (action === 'unban' || (action === 'notspam' && !state.inChat)) return 'restore'
  return action
}

export interface Admin {
  id: number
  name: string
}

export type Started = { key: string } | { refused: 'stale' | 'busy' }

/** A report button does its work in the transaction; the flow only reports it. */
export type NoteAction = (q: Q, card: CardRow, action: CardAction) => Promise<string>

async function flowData(q: Q, card: CardRow, action: CardAction, state: MessageState): Promise<Record<string, unknown>> {
  const p = card.payload
  const msg = p.messageId == null ? [] : await q.query('SELECT posted_at FROM messages WHERE chat_id = $1 AND message_id = $2', [card.chat_id, p.messageId])
  return {
    cardId: card.card_id,
    action,
    userId: p.targetUserId,
    messageId: p.messageId,
    name: p.targetName,
    category: p.category ?? 'admin',
    spam: p.spam ?? null,
    sentAt: msg[0] ? new Date(msg[0].posted_at).toISOString() : undefined,
    inChat: state.inChat,
    // Probation follows an appeal the bot doubted, not a request to an administrator (section 3.6.5).
    probation: action === 'unban' && card.kind === 'appeal_review',
    request: card.kind === 'unban_request',
    quiet: true,
  }
}

async function busy(q: Q, card: CardRow): Promise<boolean> {
  const rows = await q.query(`SELECT 1 FROM flows WHERE chat_id = $1 AND idempotency_key LIKE $2 AND status = 'running'`, [card.chat_id, `cardaction:${card.card_id}:%`])
  return rows.length > 0
}

/** Checks the button against the actions still allowed for the card and starts its flow, all under the lock of the card. */
export async function startAction(ctx: Ctx, q: Q, pressed: { cardId: number; action: string; admin: Admin }, note: NoteAction): Promise<Started> {
  const rows = await q.query<CardRow>('SELECT * FROM admin_cards WHERE card_id = $1 FOR UPDATE', [pressed.cardId])
  const card = rows[0]
  if (!card) return { refused: 'stale' }
  const state = await messageState(q, card)
  const action = normalize(card, pressed.action, state) as CardAction
  if (!acceptedActions(card, state).includes(action)) return { refused: 'stale' }
  if (await busy(q, card)) return { refused: 'busy' }
  const key = `cardaction:${card.card_id}:${action}`
  const data: Record<string, unknown> = { ...(await flowData(q, card, action, state)), adminName: pressed.admin.name, ...jokePicks(ctx.rng) }
  // «Не спам» on a message still in the chat whose author was sanctioned lifts the sanction, publishes nothing.
  const kind = action === 'notspam' && state.sanctioned ? 'card_unsanction' : FLOW_KINDS[action]
  if (kind === 'card_unsanction') data.unsanction = true
  if (kind === 'card_note') data.note = await note(q, card, action)
  if (action === 'ban') await q.query(`UPDATE bans SET appeal_status = 'rejected' WHERE chat_id = $1 AND user_id = $2`, [card.chat_id, card.payload.targetUserId])
  const created = await createFlow(q, { chatId: card.chat_id, kind, key, data, now: ctx.clock.now() })
  return created ? { key } : { refused: 'stale' }
}
