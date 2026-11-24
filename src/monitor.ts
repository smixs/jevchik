import type { Q } from './db.js'
import { categoryTitle } from './categories.js'
import { getSettings } from './settings/settings.js'
import { hasSpamPhrase, namesStopWord } from './stop-phrases.js'

// Daily watch over the groups (section 3.13): what the bot did by itself, what admins still had to do by hand, what they took back
// as a false alarm, and what would have let the bot do the hand work itself. It only reads the database.

const DAY_MS = 24 * 3600 * 1000
const LOOKBACK_DAYS = 14
const TZ = 'Asia/Tashkent'
const TEXT_LIMIT = 200
/** Cases shown per list: the message has to fit one Telegram message; the counts stay whole. */
const LIST_LIMIT = 8

export interface Case {
  chatId: number
  userId: number
  name: string
  messageId: number | null
  spam: number | null
  category: string | null
  admin: string | null
  actions: string[]
  text: string | null
  at: Date
}

export interface ChatReport {
  chatId: number
  title: string
  auto: { steam: number; spamDelete: number; ban: number }
  manual: Case[]
  falseAlarms: Case[]
  openReview: Case[]
  cannotAct: { kind: string; code: string; count: number }[]
  autoThreshold: number
  reviewThreshold: number
  /** Section 3.6.8: the door, when it is on in the chat or decided anything in the window. */
  gate?: GateCounts
}

interface GateCounts {
  passed: number
  missed: number
  timeout: number
  limit: number
  admins: number
  noWindow: number
  sendFailed: number
}

export interface MonitorReport {
  from: Date
  to: Date
  chats: ChatReport[]
  stuckEvaluations: number
  proposals: string[]
  color: '🔴' | '🟡' | '🟢'
}

const MANUAL_FLOWS = ['card_spam', 'card_ban', 'spam_command', 'admin_ban']
const ACTION_WORDS: Record<string, string> = {
  card_spam: '«Спам» на карточке',
  card_ban: '«Забанить» на карточке',
  spam_command: '/spam',
  admin_ban: 'бан админом',
  card_note: '«Не спам» на карточке',
  card_restore: '«Не спам, вернуть»',
  card_unban: 'разбан с карточки',
  unban: 'сам разбанился кнопкой',
  mod_steam: 'парилка из мини-приложения',
  mod_ban: 'бан из мини-приложения',
  mod_unban: 'разбан из мини-приложения',
}
const SETTLING_FLOWS = [...MANUAL_FLOWS, 'card_note', 'card_restore', 'steam', 'spam_delete']
/** Operations whose failure leaves spam in the chat: the bot has no rights or Telegram refused. */
const REMOVING_OPS = ['delete_message', 'restrict', 'ban']

interface FlowRow {
  chat_id: number
  kind: string
  data: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  created_at: Date
}

function caseOf(row: FlowRow): Omit<Case, 'text'> {
  const d = row.data
  const target = d.target ?? d
  return {
    chatId: row.chat_id,
    userId: Number(target.userId),
    name: target.name ?? '',
    messageId: target.messageId ?? null,
    spam: typeof d.spam === 'number' ? d.spam : null,
    category: d.category ?? null,
    admin: d.adminName ?? d.senderName ?? null,
    actions: [ACTION_WORDS[row.kind] ?? row.kind],
    at: row.created_at,
  }
}

/** One case per member and chat: a press of «Спам» and then «Забанить» is one piece of hand work. */
function merge(cases: Omit<Case, 'text'>[]): Omit<Case, 'text'>[] {
  const byMember = new Map<string, Omit<Case, 'text'>>()
  for (const c of cases) {
    const key = `${c.chatId}:${c.userId}`
    const seen = byMember.get(key)
    if (!seen) {
      byMember.set(key, { ...c, actions: [...c.actions] })
      continue
    }
    for (const a of c.actions) if (!seen.actions.includes(a)) seen.actions.push(a)
    seen.messageId ??= c.messageId
    seen.spam ??= c.spam
    seen.category ??= c.category
    seen.admin ??= c.admin
    if (!seen.name) seen.name = c.name
  }
  return [...byMember.values()]
}

async function withTexts(q: Q, cases: Omit<Case, 'text'>[]): Promise<Case[]> {
  const out: Case[] = []
  for (const c of cases) {
    let text: string | null = null
    if (c.messageId !== null) {
      const rows = await q.query<{ text: string | null }>(
        `SELECT COALESCE(
           (SELECT text FROM held_texts WHERE chat_id = $1 AND message_id = $2),
           (SELECT excerpt FROM messages WHERE chat_id = $1 AND message_id = $2)) AS text`,
        [c.chatId, c.messageId],
      )
      text = rows[0]?.text ?? null
    }
    if (!c.name) {
      const m = await q.query<{ display_name: string }>(`SELECT display_name FROM members WHERE chat_id = $1 AND user_id = $2`, [c.chatId, c.userId])
      c.name = m[0]?.display_name ?? String(c.userId)
    }
    out.push({ ...c, text })
  }
  return out
}

async function manualCases(q: Q, from: Date, to: Date): Promise<Omit<Case, 'text'>[]> {
  const flows = await q.query<FlowRow>(
    `SELECT chat_id, kind, data, created_at FROM flows WHERE kind = ANY($1) AND created_at >= $2 AND created_at < $3 ORDER BY flow_id`,
    [MANUAL_FLOWS, from, to],
  )
  const mod = await q.query<FlowRow>(
    `SELECT chat_id, 'mod_' || action AS kind, jsonb_build_object('userId', target_user_id, 'name', target_name, 'adminName', admin_name) AS data, created_at
     FROM mod_actions WHERE ok AND action IN ('steam', 'ban') AND created_at >= $1 AND created_at < $2 ORDER BY action_id`,
    [from, to],
  )
  return merge([...flows, ...mod].map(caseOf))
}

async function falseAlarmCases(q: Q, from: Date, to: Date): Promise<Omit<Case, 'text'>[]> {
  const flows = await q.query<FlowRow>(
    `SELECT chat_id, kind, data, created_at FROM flows
     WHERE created_at >= $1 AND created_at < $2
       AND (kind IN ('card_restore', 'card_unban', 'unban') OR (kind = 'card_note' AND data->>'action' = 'notspam'))
     ORDER BY flow_id`,
    [from, to],
  )
  const mod = await q.query<FlowRow>(
    `SELECT chat_id, 'mod_unban' AS kind, jsonb_build_object('userId', target_user_id, 'name', target_name, 'adminName', admin_name) AS data, created_at
     FROM mod_actions WHERE ok AND action = 'unban' AND created_at >= $1 AND created_at < $2 ORDER BY action_id`,
    [from, to],
  )
  return merge([...flows, ...mod].map(caseOf))
}

/**
 * Review cards of the window nobody pressed: the message is still in the chat and Jev was not sure. A member's flag and a card
 * «реши» about the same member are two cards; a decision on either, or the bot's own sanction, settles both.
 */
async function openReview(q: Q, chatId: number, from: Date, to: Date): Promise<Omit<Case, 'text'>[]> {
  const rows = await q.query<{ payload: Record<string, any>; created_at: Date }>( // eslint-disable-line @typescript-eslint/no-explicit-any
    `SELECT c.payload, c.created_at FROM admin_cards c WHERE c.chat_id = $1 AND c.kind IN ('review', 'flagged') AND c.status = 'open'
       AND c.decision IS NULL AND c.created_at >= $2 AND c.created_at < $3
       AND NOT EXISTS (SELECT 1 FROM flows f WHERE f.chat_id = c.chat_id AND f.created_at >= c.created_at AND f.kind = ANY($4)
         AND COALESCE(f.data->>'userId', f.data->'target'->>'userId') = c.payload->>'targetUserId')
     ORDER BY c.card_id`,
    [chatId, from, to, SETTLING_FLOWS],
  )
  const cases = rows.map((r) => ({
    chatId,
    userId: Number(r.payload.targetUserId),
    name: r.payload.targetName ?? '',
    messageId: r.payload.messageId ?? null,
    spam: typeof r.payload.spam === 'number' ? r.payload.spam : null,
    category: r.payload.category ?? null,
    admin: null,
    actions: [r.payload.flagger ? 'флаг участника' : 'карточка «реши»'],
    at: r.created_at,
  }))
  return merge(cases)
}

/**
 * The lowest threshold at which the bot would have removed the hand-deleted messages by itself, while every message admins
 * called «не спам» stays below it. Null when it catches fewer than two or would go under the review threshold.
 */
export function thresholdProposal(manual: number[], falseAlarms: number[], current: number, review: number): { at: number; caught: number; missed: number } | null {
  const below = manual.filter((s) => s < current)
  if (below.length === 0) return null
  const ceiling = Math.max(-1, ...falseAlarms.filter((s) => s < current))
  const candidates = below.filter((s) => s > ceiling && s >= review).sort((a, b) => a - b)
  if (candidates.length === 0) return null
  const at = candidates[0]
  const caught = below.filter((s) => s >= at).length
  if (caught < 2) return null
  return { at, caught, missed: below.length - caught }
}

const pct = (v: number | null): string => (v === null ? 'нет оценки' : `${Math.round(v * 100)}%`)

async function proposalsFor(q: Q, chat: ChatReport, to: Date): Promise<string[]> {
  const from = new Date(to.getTime() - LOOKBACK_DAYS * DAY_MS)
  const scores = (cases: Omit<Case, 'text'>[]) => cases.filter((c) => c.chatId === chat.chatId && c.spam !== null).map((c) => c.spam as number)
  const manual = scores(await manualCases(q, from, to))
  const alarms = scores(await falseAlarmCases(q, from, to))
  const out: string[] = []
  const t = thresholdProposal(manual, alarms, chat.autoThreshold, chat.reviewThreshold)
  if (t) {
    out.push(
      `${chat.title}: порог автоудаления ${pct(chat.autoThreshold)} → ${pct(t.at)}. За ${LOOKBACK_DAYS} дней бот сам убрал бы ещё ${t.caught} из ` +
        `${t.caught + t.missed} сообщений, удалённых руками; ни одно сообщение, названное админами «не спам», под порог не попадает.`,
    )
  }
  const missed = chat.manual.filter((c) => c.text && !hasSpamPhrase(c.text) && !namesStopWord(c.text, []))
  if (missed.length > 0) out.push(`${chat.title}: фразы не узнали удалённые руками тексты (${missed.length}) - кандидаты в новые фразы, тексты выше.`)
  for (const c of chat.falseAlarms) {
    if (c.text && hasSpamPhrase(c.text)) out.push(`${chat.title}: фраза сработала ложно на «${c.text.slice(0, 120)}» (${c.name}) - сузить выражение.`)
  }
  return out
}

/** Section 3.6.8: what the door decided in the window, by the time of the decision. */
async function gateCounts(q: Q, chatId: number, from: Date, to: Date): Promise<GateCounts> {
  const rows = await q.query<GateCounts>(
    `SELECT count(*) FILTER (WHERE status = 'passed' AND send = 'done')::int AS passed,
            count(*) FILTER (WHERE status = 'failed' AND reason = 'missed')::int AS missed,
            count(*) FILTER (WHERE status = 'timeout')::int AS timeout,
            count(*) FILTER (WHERE status = 'failed' AND reason = 'daily_limit')::int AS "limit",
            count(*) FILTER (WHERE status = 'gone' AND reason = 'joined')::int AS admins,
            count(*) FILTER (WHERE status = 'gone' AND reason = 'door_failed')::int AS "noWindow",
            count(*) FILTER (WHERE send = 'failed')::int AS "sendFailed"
     FROM gate_checks WHERE chat_id = $1 AND purpose = 'join' AND decided_at >= $2 AND decided_at < $3`,
    [chatId, from, to],
  )
  return rows[0]
}

export async function buildReport(q: Q, to: Date, from = new Date(to.getTime() - DAY_MS)): Promise<MonitorReport> {
  const chats = await q.query<{ chat_id: number; title: string | null }>(`SELECT chat_id, title FROM chats ORDER BY chat_id`)
  const manual = await withTexts(q, await manualCases(q, from, to))
  const alarms = await withTexts(q, await falseAlarmCases(q, from, to))
  const reports: ChatReport[] = []
  for (const c of chats) {
    const settings = await getSettings(q, c.chat_id)
    const auto = await q.query<{ kind: string; n: number }>(
      `SELECT kind, count(*)::int AS n FROM flows WHERE chat_id = $1 AND kind IN ('steam', 'spam_delete', 'ban') AND created_at >= $2 AND created_at < $3 GROUP BY kind`,
      [c.chat_id, from, to],
    )
    const n = (kind: string) => auto.find((r) => r.kind === kind)?.n ?? 0
    const cannotAct = await q.query<{ kind: string; code: string; count: number }>(
      `SELECT operation_kind AS kind, COALESCE(last_error_code, '') AS code, count(*)::int AS count FROM operations
       WHERE chat_id = $1 AND status = 'failed' AND operation_kind = ANY($2) AND created_at >= $3 AND created_at < $4
       GROUP BY 1, 2 ORDER BY 3 DESC`,
      [c.chat_id, REMOVING_OPS, from, to],
    )
    const gate = await gateCounts(q, c.chat_id, from, to)
    const gateShown = settings.bool('join_gate') || Object.values(gate).some((v) => v > 0)
    reports.push({
      ...(gateShown ? { gate } : {}),
      chatId: c.chat_id,
      title: c.title ?? String(c.chat_id),
      auto: { steam: n('steam'), spamDelete: n('spam_delete'), ban: n('ban') },
      manual: manual.filter((m) => m.chatId === c.chat_id),
      falseAlarms: alarms.filter((m) => m.chatId === c.chat_id),
      openReview: await withTexts(q, await openReview(q, c.chat_id, from, to)),
      cannotAct,
      autoThreshold: settings.num('spam_auto_threshold'),
      reviewThreshold: settings.num('spam_review_threshold'),
    })
  }
  const stuck = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM evaluations WHERE status IN ('pending', 'running') AND created_at < $1 AND created_at >= $2`,
    [new Date(to.getTime() - 3600 * 1000), from],
  )
  const proposals: string[] = []
  for (const r of reports) proposals.push(...(await proposalsFor(q, r, to)))
  const stuckEvaluations = stuck[0]?.n ?? 0
  const red = stuckEvaluations > 0 || reports.some((r) => r.cannotAct.length > 0 || (r.gate?.sendFailed ?? 0) > 0)
  const yellow =
    reports.some((r) => r.manual.length + r.falseAlarms.length + r.openReview.length > 0 || (r.gate?.noWindow ?? 0) > 0) || proposals.length > 0
  return { from, to, chats: reports, stuckEvaluations, proposals, color: red ? '🔴' : yellow ? '🟡' : '🟢' }
}

const when = (d: Date): string =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(',', '')

function caseLine(c: Case): string {
  const head = [c.name, pct(c.spam), c.category ? categoryTitle(c.category) : null, c.actions.join(' + '), c.admin, when(c.at)].filter(Boolean).join(' · ')
  const text = c.text ? `\n    «${c.text.replace(/\s+/g, ' ').slice(0, TEXT_LIMIT)}»` : ''
  return `  - ${head}${text}`
}

function list(cases: Case[]): string[] {
  const shown = cases.slice(0, LIST_LIMIT).map(caseLine)
  return cases.length > LIST_LIMIT ? [...shown, `  - и ещё ${cases.length - LIST_LIMIT}`] : shown
}

const OP_WORDS: Record<string, string> = { delete_message: 'удалить сообщение', restrict: 'заглушить', ban: 'забанить' }

function gateLine(g: GateCounts): string {
  const refused = g.missed + g.timeout + g.limit
  const extra = [g.admins > 0 && `админы пустили сами ${g.admins}`, g.noWindow > 0 && `окно не открылось ${g.noWindow}`, g.sendFailed > 0 && `Telegram не принял ответ ${g.sendFailed}`]
  const tail = extra.filter(Boolean).join(', ')
  return `Вход: пустил ${g.passed}, отказ ${refused} (промах ${g.missed}, молчал ${g.timeout}, лимит ${g.limit})${tail ? `; ${tail}` : ''}.`
}

export function renderReport(r: MonitorReport): string {
  const manual = r.chats.reduce((s, c) => s + c.manual.length, 0)
  const alarms = r.chats.reduce((s, c) => s + c.falseAlarms.length, 0)
  const cannot = r.chats.filter((c) => c.cannotAct.length > 0)
  const first =
    r.color === '🔴'
      ? `🔴 Жевчик не может убрать спам: ${[...cannot.map((c) => c.title), r.stuckEvaluations ? 'Jev не оценивает сообщения' : null].filter(Boolean).join('; ')}. Нужно решение: выдать права или чинить.`
      : r.color === '🟡'
        ? `🟡 Жевчик за сутки: руками ${manual}, ложных ${alarms}. Нужно решение по улучшениям ниже.`
        : '🟢 Жевчик за сутки справился сам: ручной работы и ложных нет.'
  const lines = [first, `Окно: ${when(r.from)} - ${when(r.to)} (Ташкент).`, '']
  for (const c of r.chats) {
    lines.push(`## ${c.title}`)
    lines.push(`Сам: парилка ${c.auto.steam}, удалено без парилки ${c.auto.spamDelete}, бан после парилки ${c.auto.ban}. Порог автоудаления ${pct(c.autoThreshold)}, карточки от ${pct(c.reviewThreshold)}.`)
    if (c.gate) lines.push(gateLine(c.gate))
    if (c.cannotAct.length > 0) lines.push(`Не смог: ${c.cannotAct.map((o) => `${OP_WORDS[o.kind] ?? o.kind} - ${o.count} (${o.code || 'ошибка'})`).join(', ')}.`)
    if (c.manual.length > 0) lines.push(`Руками (${c.manual.length}):`, ...list(c.manual))
    if (c.falseAlarms.length > 0) lines.push(`Ложные (${c.falseAlarms.length}):`, ...list(c.falseAlarms))
    if (c.openReview.length > 0) lines.push(`Висят без решения (${c.openReview.length}):`, ...list(c.openReview))
    lines.push('')
  }
  if (r.stuckEvaluations > 0) lines.push(`Оценки Jev висят больше часа: ${r.stuckEvaluations}.`, '')
  lines.push('## Предложения')
  lines.push(...(r.proposals.length > 0 ? r.proposals.map((p) => `- ${p}`) : ['- нет: по данным за сутки улучшать нечего.']))
  return lines.join('\n')
}
