import { formatWhen } from './card-actions.js'
import { createCard } from './cards.js'
import type { Ctx } from './ctx.js'
import { HOUR_MS } from './ctx.js'
import type { Q, Row } from './db.js'
import { registerFlow, startFlowNow, withReport, type Flow, type StepResult } from './flows.js'
import { isChannelId } from './members.js'
import { execOp, NO_PERMISSIONS } from './ops.js'
import { appealUrl, banCall, checkTarget, closeRequests, dropJokes, liftStep, loadJokes, unbanRecord } from './sanctions.js'
import { getSettings } from './settings/settings.js'

// Section 3.6.5: an administrator of the chat sanctions a member from the Mini App: the steam room for an hour, a day or a
// week, a ban, and the lifting of either. Karma is not touched; the chat gets a joke; the action goes to the journal.

export type ModAction = 'steam' | 'ban' | 'unban'

const STEAM_HOURS = [1, 24, 168]
const TERMS: Record<number, string> = { 1: 'на час', 24: 'на сутки', 168: 'на неделю' }

const pending = (status: string): boolean => status === 'pending' || status === 'running'

// ---------------------------------------------------------------- what the member is under now

export interface Sanction {
  state: 'steam' | 'banned'
  source: 'auto' | 'admin'
  until: string | null
  by: string | null
  /** The sanction in words, for the administrators. */
  text: string
  /** The same for the member under it. */
  own: string
  appeal_status: string
}

function sanctionText(ban: Row, when: string): string {
  const by = ban.by_admin_name ? `, ${ban.state === 'banned' ? 'забанил' : 'отправил'} ${ban.by_admin_name}` : ''
  if (ban.source === 'admin') return ban.state === 'banned' ? `забанен${by}` : `в парилке до ${when}${by}`
  return ban.state === 'banned' ? 'забанен за спам' : `в парилке за спам до ${when}, потом бан`
}

export async function sanctionOf(q: Q, chatId: number, userId: number): Promise<Sanction | null> {
  const ban = (await q.query('SELECT state, source, steam_until, by_admin_name, appeal_status FROM bans WHERE chat_id = $1 AND user_id = $2', [chatId, userId]))[0]
  if (!ban) return null
  const until = new Date(ban.steam_until)
  const when = formatWhen(until, (await getSettings(q, chatId)).str('timezone'))
  return { state: ban.state, source: ban.source, until: ban.state === 'steam' ? until.toISOString() : null, by: ban.by_admin_name ?? null, text: sanctionText(ban, when), own: ban.state === 'banned' ? 'забанены' : `в парилке до ${when}`, appeal_status: ban.appeal_status }
}

// ---------------------------------------------------------------- the steps

async function restrictStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const untilDate = Math.floor(new Date(flow.data.until).getTime() / 1000)
  const outcome = await execOp(ctx, { chatId: flow.chatId, key: `${flow.key}:restrict`, kind: 'restrict', payload: { userId: flow.data.userId, permissions: NO_PERMISSIONS, untilDate } })
  if (pending(outcome.status)) return 'wait'
  return outcome.status === 'completed' ? 'ok' : 'stop'
}

/** The record of an administrator replaces the one the bot made: its steam room ends by itself, the member may ask once. */
async function recordStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const d = flow.data
  await ctx.db.tx(async (q) => {
    const rows = await q.query(
      `INSERT INTO bans (chat_id, user_id, category, joke_idx, explanation_idx, image_idx, state, steam_until, created_at, source, by_admin_id, by_admin_name)
       VALUES ($1,$2,'admin',0,0,$3,$4,$5,$6,'admin',$7,$8)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET state = EXCLUDED.state, steam_until = EXCLUDED.steam_until, source = 'admin',
         by_admin_id = EXCLUDED.by_admin_id, by_admin_name = EXCLUDED.by_admin_name, appeal_status = 'none', appeal_claimed_at = NULL
       RETURNING (xmax = 0) AS created`,
      [flow.chatId, d.userId, d.imageIdx, d.action === 'ban' ? 'banned' : 'steam', new Date(d.until ?? flow.createdAt), flow.createdAt, d.adminId, d.adminName],
    )
    if (rows[0].created) await q.query('UPDATE members SET bans_count = bans_count + 1 WHERE chat_id = $1 AND user_id = $2', [flow.chatId, d.userId])
    await closeRequests(q, flow.chatId, d.userId)
  })
  return 'ok'
}

/** The joke with the way to ask for mercy; a channel cannot open the Mini App, so it gets none. */
async function jokeStep(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const d = flow.data
  if (isChannelId(d.userId)) return 'ok'
  const set = d.action === 'ban' ? loadJokes().admin_ban : loadJokes().admin_steam
  const text = set[d.jokeIdx % set.length].replaceAll('{name}', d.name).replaceAll('{term}', TERMS[d.hours] ?? '')
  const outcome = await execOp(ctx, { chatId: flow.chatId, key: `${flow.key}:send`, kind: 'send_message', payload: { text, buttons: [[{ text: 'Попросить разбан', url: appealUrl(ctx, flow.chatId) }]] } })
  return pending(outcome.status) ? 'wait' : 'ok'
}

// ---------------------------------------------------------------- the result in words

const REASONS: Record<string, string> = {
  no_rights: 'у бота нет права банить участников',
  target_admin: 'это админ чата',
  role_unknown: 'Telegram не ответил, кто этот участник',
}

const MAIN_OP: Record<ModAction, string> = { steam: 'restrict', ban: 'ban', unban: 'lift' }

async function done(ctx: Ctx, flow: Flow): Promise<string> {
  const d = flow.data
  if (d.action === 'ban') return `${d.name} забанен`
  if (d.action === 'unban') return d.was === 'banned' ? `${d.name} разбанен` : `${d.name} выпущен из парилки`
  return `${d.name} в парилке до ${formatWhen(new Date(d.until), (await getSettings(ctx.db, flow.chatId)).str('timezone'))}`
}

async function outcomeOf(ctx: Ctx, flow: Flow): Promise<{ ok: boolean; summary: string }> {
  const d = flow.data
  const op = (await ctx.db.query('SELECT status, last_error_code FROM operations WHERE chat_id = $1 AND idempotency_key = $2', [flow.chatId, `${flow.key}:${MAIN_OP[d.action as ModAction]}`]))[0]
  if (op?.status === 'completed') return { ok: true, summary: await done(ctx, flow) }
  const code = typeof d.halt === 'string' ? d.halt : (op?.last_error_code ?? '')
  return { ok: false, summary: `Не вышло: ${REASONS[code] ?? 'Telegram отказал'}` }
}

/** The last step of every flow here, also after a stop: the journal of the administrators (section 3.6.5). */
async function journal(ctx: Ctx, flow: Flow): Promise<StepResult> {
  const d = flow.data
  const { ok, summary } = await outcomeOf(ctx, flow)
  await ctx.db.query(
    `INSERT INTO mod_actions (chat_id, flow_key, admin_id, admin_name, target_user_id, target_name, action, hours, ok, summary, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (chat_id, flow_key) DO NOTHING`,
    [flow.chatId, flow.key, d.adminId, d.adminName, d.userId, d.name, d.action, d.hours ?? null, ok, summary, ctx.clock.now()],
  )
  return 'ok'
}

export function registerModerationFlows(): void {
  registerFlow('app_steam', withReport([checkTarget, restrictStep, recordStep, jokeStep], journal))
  registerFlow('app_ban', withReport([checkTarget, banCall, recordStep, jokeStep], journal))
  registerFlow('app_unban', withReport([liftStep, dropJokes, unbanRecord], journal))
}

// ---------------------------------------------------------------- the action of an administrator

export interface ModRequest {
  chatId: number
  admin: { id: number; name: string }
  target: { userId: number; name: string; isChannel: boolean }
  action: ModAction
  hours?: number
}

export interface ModResult {
  ok: boolean
  text: string
}

const refuse = (text: string): ModResult => ({ ok: false, text })

/** What cannot be done at all, before anything is sent to Telegram. */
function refusal(req: ModRequest, ban: Row | undefined): string | null {
  if (req.target.userId === req.admin.id) return 'Себя наказать нельзя.'
  if (req.action === 'unban') return ban ? null : 'Наказания уже нет.'
  if (ban?.state === 'banned') return 'Уже забанен. Сначала разбаньте.'
  if (req.action === 'steam' && req.target.isChannel) return 'Канал в парилку не отправить, его можно только забанить.'
  if (req.action === 'steam' && !STEAM_HOURS.includes(req.hours ?? 0)) return 'Срок парилки: час, сутки или неделя.'
  return null
}

/** Every flow that changes the sanction of a member: while one runs, an administrator waits. */
const SANCTION_FLOWS = ['app_steam', 'app_ban', 'app_unban', 'steam', 'ban', 'unban', 'admin_ban', 'card_spam', 'card_ban', 'card_restore', 'card_unban', 'card_unsanction']

async function busy(q: Q, chatId: number, userId: number): Promise<boolean> {
  const rows = await q.query(`SELECT 1 FROM flows WHERE chat_id = $1 AND kind = ANY($3) AND status = 'running' AND data->>'userId' = $2`, [chatId, String(userId), SANCTION_FLOWS])
  return rows.length > 0
}

function flowData(ctx: Ctx, req: ModRequest, ban: Row | undefined, now: Date): Record<string, unknown> {
  const { target, action } = req
  const jokes = loadJokes()
  const pick = (n: number): number => Math.min(n - 1, Math.floor(ctx.rng.next() * n))
  return {
    action,
    userId: target.userId,
    name: target.name,
    adminId: req.admin.id,
    adminName: req.admin.name,
    hours: action === 'steam' ? req.hours : undefined,
    until: action === 'steam' ? new Date(now.getTime() + req.hours! * HOUR_MS).toISOString() : undefined,
    jokeIdx: pick(action === 'ban' ? jokes.admin_ban.length : jokes.admin_steam.length),
    imageIdx: pick(jokes.images.length),
    was: ban?.state,
    since: ban ? new Date(ban.created_at).toISOString() : undefined,
    quiet: true,
  }
}

/**
 * Starts the action, runs it at once and answers with what happened; a slow Telegram leaves the answer to the journal. Two
 * administrators acting on one member at once are put in a line by a lock: the second one is told to wait.
 */
export async function moderate(ctx: Ctx, req: ModRequest): Promise<ModResult> {
  const { chatId, target, action } = req
  const now = ctx.clock.now()
  const key = `mod:${action}:${target.userId}:${now.getTime()}`
  const started = await ctx.db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mod:${chatId}:${target.userId}`])
    const ban = (await q.query('SELECT state, created_at FROM bans WHERE chat_id = $1 AND user_id = $2', [chatId, target.userId]))[0]
    const no = refusal(req, ban) ?? ((await busy(q, chatId, target.userId)) ? 'Уже выполняю предыдущее действие.' : null)
    if (no) return no
    return startFlowNow(ctx, q, { chatId, kind: `app_${action}`, key, data: flowData(ctx, req, ban, now), now })
  })
  if (typeof started === 'string') return refuse(started)
  await started()
  const logged = (await ctx.db.query('SELECT ok, summary FROM mod_actions WHERE chat_id = $1 AND flow_key = $2', [chatId, key]))[0]
  return logged ? { ok: logged.ok, text: logged.summary } : { ok: true, text: 'Принято, выполняю. Итог появится в журнале.' }
}

export async function modLog(ctx: Ctx, chatId: number): Promise<unknown[]> {
  const rows = await ctx.db.query('SELECT admin_name, summary, ok, created_at FROM mod_actions WHERE chat_id = $1 ORDER BY action_id DESC LIMIT 50', [chatId])
  return rows.map((r) => ({ admin: r.admin_name, summary: r.summary, ok: r.ok, date: new Date(r.created_at).toISOString() }))
}

// ---------------------------------------------------------------- the member asks an administrator

export type UnbanRequest = { status: 'no_ban' | 'not_allowed' | 'review' | 'rejected' | 'accepted' }

/** One request per sanction of an administrator: the administrators get a card with «Разбанить» and «Оставить». */
export async function requestUnban(ctx: Ctx, chatId: number, userId: number): Promise<UnbanRequest> {
  const now = ctx.clock.now()
  return ctx.db.tx(async (q) => {
    const ban = (await q.query('SELECT ban_id, source, appeal_status FROM bans WHERE chat_id = $1 AND user_id = $2 FOR UPDATE', [chatId, userId]))[0]
    if (!ban) return { status: 'no_ban' }
    if (ban.source !== 'admin') return { status: 'not_allowed' }
    if (ban.appeal_status !== 'none') return { status: ban.appeal_status }
    await q.query(`UPDATE bans SET appeal_status = 'review' WHERE ban_id = $1`, [ban.ban_id])
    const member = (await q.query('SELECT display_name FROM members WHERE chat_id = $1 AND user_id = $2', [chatId, userId]))[0]
    const sanction = await sanctionOf(q, chatId, userId)
    await createCard(q, { chatId, key: `unbanreq:${ban.ban_id}:${now.getTime()}`, kind: 'unban_request', payload: { targetUserId: userId, targetName: member?.display_name, note: sanction?.text }, now })
    return { status: 'review' }
  })
}
