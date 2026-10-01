import type { Ctx } from './ctx.js'
import { createCard } from './cards.js'
import { fitRequest } from './jev/state.js'
import { runFlows } from './flows.js'
import { JevError } from './ports.js'
import { startUnban } from './sanctions.js'
import { getSettings } from './settings/settings.js'
import { graphemeLength } from './text.js'
import { extractAppeal } from './appeal-answer.js'
import { isChannelId } from './members.js'
import { sanctionOf } from './moderation.js'

const APPEAL_MAX_CHARS = 500
const CLAIM_TIMEOUT_MS = 2 * 60_000

export type AppealResult =
  | { status: 'invalid'; reason: 'empty' | 'too_long' }
  | { status: 'no_ban' }
  | { status: 'not_allowed' }
  | { status: 'pending' }
  | { status: 'accepted'; lifted: boolean }
  | { status: 'rejected' }
  | { status: 'review' }
  | { status: 'try_later' }

interface BanRow {
  ban_id: string
  source: string
  state: string
  appeal_status: string
  bans_count: number
  display_name: string
}

async function loadBan(ctx: Ctx, chatId: number, userId: number): Promise<BanRow | null> {
  const rows = await ctx.db.query<BanRow>(
    `SELECT b.ban_id, b.source, b.state, b.appeal_status, m.bans_count, m.display_name FROM bans b
     JOIN members m ON m.chat_id = b.chat_id AND m.user_id = b.user_id WHERE b.chat_id = $1 AND b.user_id = $2`,
    [chatId, userId],
  )
  return rows[0] ?? null
}

async function claim(ctx: Ctx, ban: BanRow): Promise<boolean> {
  const now = ctx.clock.now()
  const stale = new Date(now.getTime() - CLAIM_TIMEOUT_MS)
  const rows = await ctx.db.query(
    `UPDATE bans SET appeal_status = 'evaluating', appeal_claimed_at = $2
     WHERE ban_id = $1 AND (appeal_status = 'none' OR (appeal_status = 'evaluating' AND appeal_claimed_at < $3)) RETURNING 1`,
    [ban.ban_id, now, stale],
  )
  return rows.length > 0
}

async function ask(ctx: Ctx, chatId: number, text: string): Promise<number | null> {
  const settings = await getSettings(ctx.db, chatId)
  const question = settings.questions().appeal_genuine
  if (!question) return null
  const fitted = fitRequest(
    { message: text, replied_to: null, previous_messages: [], sender_history: null, media_description: null, sender_profile: null },
    { appeal_genuine: question },
  )
  if (!fitted) return null
  try {
    return extractAppeal(await ctx.jev.evaluate(fitted.request))
  } catch (error) {
    if (!(error instanceof JevError)) throw error
    ctx.log.warn('appeal_jev_failed', { kind: error.kind, status: error.status })
    return null
  }
}

async function resumeAccepted(ctx: Ctx, chatId: number, userId: number, ban: BanRow): Promise<AppealResult> {
  const now = ctx.clock.now()
  const flows = await ctx.db.query(`SELECT status FROM flows WHERE chat_id = $1 AND idempotency_key LIKE $2`, [chatId, `appeal:${ban.ban_id}:%`])
  if (!flows.some((f) => f.status === 'running')) {
    await startUnban(ctx.db, { chatId, userId, probation: true }, `appeal:${ban.ban_id}:${flows.length + 1}`, now)
  }
  await runFlows(ctx)
  const left = await loadBan(ctx, chatId, userId)
  return left ? { status: 'accepted', lifted: false } : { status: 'accepted', lifted: true }
}

/** The verdict is written only to the automatic record that was being judged; `false` when an administrator took it over. */
async function settle(ctx: Ctx, ban: BanRow, status: string): Promise<boolean> {
  const rows = await ctx.db.query(`UPDATE bans SET appeal_status = $2 WHERE ban_id = $1 AND source = 'auto' AND appeal_status = 'evaluating' RETURNING 1`, [ban.ban_id, status])
  return rows.length > 0
}

async function verdict(ctx: Ctx, who: { chatId: number; userId: number; ban: BanRow }, score: number): Promise<AppealResult> {
  const { chatId, userId, ban } = who
  const settings = await getSettings(ctx.db, chatId)
  const now = ctx.clock.now()
  const status = score >= settings.num('appeal_accept') ? 'accepted' : score < settings.num('appeal_reject') ? 'rejected' : 'review'
  if (!(await settle(ctx, ban, status))) return { status: 'not_allowed' }
  if (status === 'accepted') return resumeAccepted(ctx, chatId, userId, ban)
  if (status === 'review') await createCard(ctx.db, { chatId, key: `appeal:${ban.ban_id}`, kind: 'appeal_review', payload: { targetUserId: userId, targetName: ban.display_name, probation: true }, now })
  return { status }
}

/**
 * One appeal per member, after the first bath only; a channel has no appeal in the Mini App (section 3.6.4). A sanction of an
 * administrator is not judged by the model: the member asks the administrators (section 3.6.5).
 */
function appealAllowed(ban: BanRow, userId: number): boolean {
  return ban.source === 'auto' && ban.bans_count <= 1 && !isChannelId(userId)
}

async function release(ctx: Ctx, ban: BanRow): Promise<void> {
  await ctx.db.query(`UPDATE bans SET appeal_status = 'none' WHERE ban_id = $1 AND appeal_status = 'evaluating'`, [ban.ban_id])
}

export async function submitAppeal(ctx: Ctx, chatId: number, userId: number, rawText: string): Promise<AppealResult> {
  const text = rawText.trim()
  const length = graphemeLength(text)
  if (length === 0) return { status: 'invalid', reason: 'empty' }
  if (length > APPEAL_MAX_CHARS) return { status: 'invalid', reason: 'too_long' }
  const ban = await loadBan(ctx, chatId, userId)
  if (!ban) return { status: 'no_ban' }
  if (!appealAllowed(ban, userId)) return { status: 'not_allowed' }
  if (ban.appeal_status === 'accepted') return resumeAccepted(ctx, chatId, userId, ban)
  if (ban.appeal_status === 'rejected') return { status: 'rejected' }
  if (ban.appeal_status === 'review') return { status: 'review' }
  if (!(await claim(ctx, ban))) return { status: 'pending' }
  const score = await ask(ctx, chatId, text)
  if (score === null) {
    await release(ctx, ban)
    return { status: 'try_later' }
  }
  return verdict(ctx, { chatId, userId, ban }, score)
}

export async function appealState(ctx: Ctx, chatId: number, userId: number): Promise<{ status: string; allowed: boolean; source?: string; sanction?: string }> {
  const ban = await loadBan(ctx, chatId, userId)
  if (!ban) return { status: 'no_ban', allowed: false }
  if (ban.source === 'admin') return { status: ban.appeal_status, allowed: ban.appeal_status === 'none', source: 'admin', sanction: (await sanctionOf(ctx.db, chatId, userId))?.own }
  return { status: ban.appeal_status, allowed: appealAllowed(ban, userId) && ban.appeal_status === 'none' }
}
