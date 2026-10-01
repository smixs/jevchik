import type { Ctx } from './ctx.js'
import type { Q } from './db.js'
import { submitOpIn, TAG_ELIGIBLE, type OpSpec } from './ops.js'
import { getSettings, getSettingsWithVersions, SettingsView } from './settings/settings.js'
import { karmaTag } from './text.js'

/** No second waiting operation for the same member: the waiting one takes the karma at the moment of sending. */
const NO_WAITING_TAG = `NOT EXISTS (SELECT 1 FROM operations o WHERE o.chat_id = m.chat_id AND o.operation_kind = 'set_tag'
  AND o.status = 'pending' AND (o.payload->>'userId')::bigint = m.user_id)`

interface TagTarget {
  chatId: number
  userId: number
  key: string
}

function tagOp(target: TagTarget, settings: SettingsView): OpSpec {
  return {
    chatId: target.chatId,
    key: `tag:${target.userId}:${target.key}`,
    kind: 'set_tag',
    payload: {
      userId: target.userId,
      template: settings.str('karma_tag_template'),
      intervalMs: settings.num('karma_tag_min_interval_minutes') * 60_000,
    },
  }
}

interface TagChange extends TagTarget {
  karma: number
  now: Date
  settings: SettingsView
}

/** Section 3.12: a change of the whole karma value queues a `set_tag` operation, unless the text is already set or one is waiting. */
export async function queueTag(q: Q, change: TagChange): Promise<void> {
  if (!change.settings.bool('karma_tag_enabled')) return
  const rows = await q.query(`SELECT m.tag_text FROM members m WHERE m.chat_id = $1 AND m.user_id = $2 AND ${TAG_ELIGIBLE} AND ${NO_WAITING_TAG}`, [
    change.chatId,
    change.userId,
  ])
  if (rows.length === 0 || rows[0].tag_text === karmaTag(change.settings.str('karma_tag_template'), change.karma)) return
  await submitOpIn(q, change.now, tagOp(change, change.settings))
}

/** The first placement: every member with at least one karma event whose tag differs, through the same queue. */
async function placeTags(q: Q, chat: { chatId: number; key: string; now: Date }, settings: SettingsView): Promise<void> {
  const members = await q.query(
    `SELECT m.user_id, m.karma, m.tag_text FROM members m
     WHERE m.chat_id = $1 AND ${TAG_ELIGIBLE} AND ${NO_WAITING_TAG}
       AND EXISTS (SELECT 1 FROM karma_events e WHERE e.chat_id = m.chat_id AND e.user_id = m.user_id)
     ORDER BY m.user_id`,
    [chat.chatId],
  )
  const template = settings.str('karma_tag_template')
  for (const m of members) {
    if (m.tag_text === karmaTag(template, m.karma)) continue
    await submitOpIn(q, chat.now, tagOp({ chatId: chat.chatId, userId: m.user_id, key: chat.key }, settings))
  }
}

/** One placement per period of a chat, recorded in job_runs in the same transaction: a failed one is not recorded and runs again. */
async function placeOnce(ctx: Ctx, chatId: number, period: string, settings: SettingsView): Promise<void> {
  const now = ctx.clock.now()
  await ctx.db.tx(async (q) => {
    const fresh = await q.query('INSERT INTO job_runs (job, period, subject, ran_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1', ['tag_placement', period, String(chatId), now])
    if (fresh.length > 0) await placeTags(q, { chatId, key: `placement:${period}`, now }, settings)
  })
}

export async function placeTagsAfterImport(ctx: Ctx, chatId: number, jobId: number): Promise<void> {
  const settings = await getSettings(ctx.db, chatId)
  if (settings.bool('karma_tag_enabled')) await placeOnce(ctx, chatId, `import:${jobId}`, settings)
}

async function importsWithoutPlacement(ctx: Ctx, chatId: number): Promise<number[]> {
  const rows = await ctx.db.query(
    `SELECT j.job_id FROM import_jobs j WHERE j.chat_id = $1 AND j.status = 'done' AND NOT EXISTS (
       SELECT 1 FROM job_runs r WHERE r.job = 'tag_placement' AND r.period = 'import:' || j.job_id AND r.subject = $1::text)
     ORDER BY j.job_id`,
    [chatId],
  )
  return rows.map((r) => r.job_id as number)
}

/**
 * The first placement, while `karma_tag_enabled` is on: once per version of that setting (the default for chats that existed
 * before tags, and every switch back on), and for every finished import whose own placement did not happen.
 */
export async function runTagPlacement(ctx: Ctx): Promise<void> {
  for (const row of await ctx.db.query('SELECT chat_id FROM chats ORDER BY chat_id')) {
    const chatId = row.chat_id as number
    const { values, versions } = await getSettingsWithVersions(ctx.db, chatId)
    if (values.karma_tag_enabled !== true) continue
    const settings = new SettingsView(values)
    await placeOnce(ctx, chatId, `v${versions.karma_tag_enabled}`, settings)
    for (const jobId of await importsWithoutPlacement(ctx, chatId)) await placeOnce(ctx, chatId, `import:${jobId}`, settings)
  }
}
