import type { Ctx } from './ctx.js'
import { runFlows } from './flows.js'
import { isChannelId } from './members.js'
import { sanctionOf } from './moderation.js'
import { startUnban } from './sanctions.js'

export type AppealResult = { status: 'no_ban' } | { status: 'not_allowed' } | { status: 'rejected' } | { status: 'accepted'; lifted: boolean }

interface BanRow {
  ban_id: string
  source: string
  state: string
  appeal_status: string
  bans_count: number
}

async function loadBan(ctx: Ctx, chatId: number, userId: number): Promise<BanRow | null> {
  const rows = await ctx.db.query<BanRow>(
    `SELECT b.ban_id, b.source, b.state, b.appeal_status, m.bans_count FROM bans b
     JOIN members m ON m.chat_id = b.chat_id AND m.user_id = b.user_id WHERE b.chat_id = $1 AND b.user_id = $2`,
    [chatId, userId],
  )
  return rows[0] ?? null
}

/** The button is pressed once: only the automatic record still without an answer turns into an accepted one (model Appeal). */
async function accept(ctx: Ctx, ban: BanRow): Promise<boolean> {
  const rows = await ctx.db.query(`UPDATE bans SET appeal_status = 'accepted' WHERE ban_id = $1 AND source = 'auto' AND appeal_status = 'none' RETURNING 1`, [ban.ban_id])
  return rows.length > 0
}

async function resumeAccepted(ctx: Ctx, chatId: number, userId: number, ban: BanRow): Promise<AppealResult> {
  const now = ctx.clock.now()
  const flows = await ctx.db.query(`SELECT status FROM flows WHERE chat_id = $1 AND idempotency_key LIKE $2`, [chatId, `appeal:${ban.ban_id}:%`])
  if (!flows.some((f) => f.status === 'running')) {
    await startUnban(ctx.db, { chatId, userId, banId: ban.ban_id, probation: true }, `appeal:${ban.ban_id}:${flows.length + 1}`, now)
  }
  await runFlows(ctx)
  const left = await loadBan(ctx, chatId, userId)
  return left ? { status: 'accepted', lifted: false } : { status: 'accepted', lifted: true }
}

/**
 * Section 3.6: the button lifts the automatic sanction at once, no explanation and no model.
 * One press per member, after the first bath only; a channel has no appeal in the Mini App (section 3.6.4). A sanction of an
 * administrator is lifted only by the administrators: the member asks them (section 3.6.5).
 */
function appealAllowed(ban: BanRow, userId: number): boolean {
  return ban.source === 'auto' && ban.bans_count <= 1 && !isChannelId(userId)
}

export async function submitAppeal(ctx: Ctx, chatId: number, userId: number): Promise<AppealResult> {
  const ban = await loadBan(ctx, chatId, userId)
  if (!ban) return { status: 'no_ban' }
  if (!appealAllowed(ban, userId)) return { status: 'not_allowed' }
  if (ban.appeal_status === 'accepted') return resumeAccepted(ctx, chatId, userId, ban)
  if (ban.appeal_status !== 'none') return { status: 'rejected' }
  if (!(await accept(ctx, ban))) return submitAppeal(ctx, chatId, userId)
  return resumeAccepted(ctx, chatId, userId, ban)
}

export async function appealState(ctx: Ctx, chatId: number, userId: number): Promise<{ status: string; allowed: boolean; source?: string; sanction?: string }> {
  const ban = await loadBan(ctx, chatId, userId)
  if (!ban) return { status: 'no_ban', allowed: false }
  if (ban.source === 'admin') return { status: ban.appeal_status, allowed: ban.appeal_status === 'none', source: 'admin', sanction: (await sanctionOf(ctx.db, chatId, userId))?.own }
  return { status: ban.appeal_status, allowed: appealAllowed(ban, userId) && ban.appeal_status !== 'rejected' }
}
