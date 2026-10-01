import type { Ctx } from './ctx.js'
import { HOUR_MS } from './ctx.js'
import type { Q } from './db.js'
import { categoryOf } from './categories.js'
import { createCard, holdText, LEFT_IN_CHAT, type CardKind, type HeldText } from './cards.js'
import { extractFacts, type Answers, type Facts } from './jev/facts.js'
import { isNewcomer } from './jev/history.js'
import { award, boostFor, recordActivity } from './karma.js'
import { pickSignal, settleLink } from './ladder.js'
import { isObserving } from './members.js'
import { seriesFactor } from './formulas.js'
import { submitOpIn } from './ops.js'
import { getSettings, type SettingsView } from './settings/settings.js'
import { decide, startSpamDelete, startSteam, type Action, type DecideInput, type Decision } from './sanctions.js'

export interface EvalMeta {
  authorId: number
  authorName: string
  postedAt: string
  gen: number
  isEdit: boolean
  mediaKind: 'photo' | 'sticker' | 'animation' | null
  mediaOnly: boolean
  hasLinks: boolean
  probation: boolean
  fetchBio: boolean
  prepared?: boolean
  mode: 'live' | 'import'
}

export interface ApplyInput {
  chatId: number
  messageId: number
  startedAt: Date
  settingsSeq: number | null
  meta: EvalMeta
  text: string
  answers: Answers | null
  mediaDescribed: boolean
}

interface MessageRow {
  author_id: number
  posted_at: Date
  reply_to_message_id: number | null
  reply_to_author_id: number | null
  has_quote: boolean
  media_kind: string | null
  run_k: number
  jev_awarded: number
  facts: { sanction?: string } | null
}

interface Env {
  q: Q
  ctx: Ctx
  settings: SettingsView
  input: ApplyInput
  facts: Facts
  msg: MessageRow
  postedAt: Date
}

/** An imported event is dated by its message, so that the week and month boards count it where it happened. */
function eventTime(e: Env): Date {
  return e.input.meta.mode === 'import' ? e.postedAt : e.ctx.clock.now()
}

async function updateJevKarma(e: Env): Promise<void> {
  const { input, facts, msg } = e
  if (facts.level === null) return
  const points = e.settings.list<number>('usefulness_points')[facts.level] ?? 0
  let delta = points * seriesFactor(msg.run_k)
  if (delta > 0) delta *= await boostFor(e.q, e.settings, { chatId: input.chatId, userId: msg.author_id }, e.postedAt)
  const common = { chatId: input.chatId, userId: msg.author_id, messageId: input.messageId, now: eventTime(e), settings: e.settings, source: 'jev', positiveOnly: input.meta.mode === 'import' }
  if (Math.abs(msg.jev_awarded - delta) < 1e-9 && msg.jev_awarded !== 0) return
  if (msg.jev_awarded !== 0) {
    await award(e.q, { ...common, delta: -msg.jev_awarded, reason: 'jev_undo', key: `jev:${input.messageId}:${input.meta.gen}:undo` })
  }
  const applied = delta === 0 ? 0 : (await award(e.q, { ...common, delta, reason: 'jev_usefulness', key: `jev:${input.messageId}:${input.meta.gen}` })).delta
  await e.q.query('UPDATE messages SET jev_awarded = $3 WHERE chat_id = $1 AND message_id = $2', [input.chatId, input.messageId, applied])
}

async function updateLadder(e: Env): Promise<void> {
  const { input, facts, msg } = e
  if (msg.reply_to_message_id === null || msg.reply_to_author_id === null || msg.reply_to_author_id === msg.author_id) return
  const target = await e.q.query('SELECT is_bot FROM members WHERE chat_id = $1 AND user_id = $2', [input.chatId, msg.reply_to_author_id])
  if (!target[0] || target[0].is_bot) return
  const parent = await e.q.query('SELECT posted_at, reply_to_author_id FROM messages WHERE chat_id = $1 AND message_id = $2', [
    input.chatId,
    msg.reply_to_message_id,
  ])
  const windowMs = e.settings.num('dialog_window_hours') * HOUR_MS
  const dialog =
    parent[0]?.reply_to_author_id === msg.author_id && e.postedAt.getTime() - new Date(parent[0].posted_at).getTime() <= windowMs
  const at = (value: number | null, key: string): boolean => value !== null && value >= e.settings.num(key)
  const signal = pickSignal({
    mediaReply: msg.media_kind === 'sticker' || msg.media_kind === 'animation',
    mediaFits: at(facts.mediaFits, 'threshold_media_fits'),
    rudeBlocked: at(facts.rude, 'threshold_rude') && facts.tone === 'serious',
    hasQuote: msg.has_quote,
    dialog,
    thanks: at(facts.isThanks, 'threshold_is_thanks'),
  })
  await settleLink(e.q, {
    chatId: input.chatId,
    fromMessageId: input.messageId,
    toMessageId: msg.reply_to_message_id,
    actorId: msg.author_id,
    targetUserId: msg.reply_to_author_id,
    signal,
    gen: input.meta.gen,
    now: eventTime(e),
    postedAt: e.postedAt,
    settings: e.settings,
    positiveOnly: input.meta.mode === 'import',
  })
}

/** The text (or caption) as it was evaluated, kept by the rule for deleted spam (section 3.10). */
function held(e: Env, reason: 'spam' | 'card'): HeldText {
  const { input } = e
  return {
    chatId: input.chatId,
    messageId: input.messageId,
    authorId: e.msg.author_id,
    authorName: input.meta.authorName,
    text: input.text,
    mediaKind: input.meta.mediaKind,
    reason,
    days: e.settings.num('held_text_days'),
    now: e.ctx.clock.now(),
  }
}

/** The message counts as deleted once the deletion goes through (the card buttons follow it, section 3.6.2). */
async function saveHeldText(e: Env): Promise<void> {
  const { input } = e
  await holdText(e.q, held(e, 'spam'))
  await e.q.query('UPDATE messages SET excerpt = NULL WHERE chat_id = $1 AND message_id = $2', [input.chatId, input.messageId])
}

/** The score behind the category: the profile score when the profile outweighs the text (section 3.6.3, «Уверенность»). */
function score(facts: Facts): number | null {
  return pickCategory(facts) === 'profile_promo' && facts.profilePromo !== null ? facts.profilePromo : facts.spam
}

function flowData(e: Env, category: string): { userId: number; messageId: number; name: string; sentAt: string; category: string; spam: number | null } {
  return {
    userId: e.msg.author_id,
    messageId: e.input.messageId,
    name: e.input.meta.authorName,
    sentAt: e.postedAt.toISOString(),
    category,
    spam: score(e.facts),
  }
}

function pickCategory(facts: Facts): string {
  return categoryOf(facts) ?? 'profile_promo'
}

/** Section 3.6.1: the text at the moment of moderation is kept for the card by the rule for deleted spam. */
async function card(e: Env, kind: CardKind, key: string, extra: { done?: string } = {}): Promise<void> {
  await holdText(e.q, held(e, 'card'))
  await createCard(e.q, {
    chatId: e.input.chatId,
    key,
    kind,
    payload: {
      targetUserId: e.msg.author_id,
      targetName: e.input.meta.authorName,
      messageId: e.input.messageId,
      category: categoryOf(e.facts),
      spam: categoryOf(e.facts) === null ? null : score(e.facts),
      ...extra,
    },
    now: e.ctx.clock.now(),
  })
}

/** A member already in the bath, or on the way there (T-steam-race): one record, one restriction, one joke. */
async function alreadySteamed(e: Env): Promise<boolean> {
  const params = [e.input.chatId, e.msg.author_id]
  if ((await e.q.query('SELECT 1 FROM bans WHERE chat_id = $1 AND user_id = $2', params)).length > 0) return true
  const flows = await e.q.query(`SELECT 1 FROM flows WHERE chat_id = $1 AND kind = 'steam' AND status = 'running' AND (data->>'userId')::bigint = $2`, params)
  return flows.length > 0
}

async function perform(e: Env, action: Action): Promise<string | null> {
  const { input } = e
  const now = e.ctx.clock.now()
  switch (action) {
    case 'card_protected':
      await card(e, 'protected', `protected:${input.messageId}`)
      return 'card'
    case 'steam':
      await saveHeldText(e)
      if (await alreadySteamed(e)) {
        await startSpamDelete(e.q, input.chatId, { ...flowData(e, pickCategory(e.facts)), noCard: true }, now)
        return 'delete'
      }
      await startSteam(e.q, e.ctx, { ...flowData(e, pickCategory(e.facts)), chatId: input.chatId }, now)
      return 'steam'
    case 'delete_card':
      await saveHeldText(e)
      await startSpamDelete(e.q, input.chatId, flowData(e, pickCategory(e.facts)), now)
      return 'delete'
    case 'card_review':
      await card(e, 'review', `review:${input.messageId}`)
      return 'card'
    default:
      return null
  }
}

/** Section 3.6.0: probation after an unban works as before, so a member on probation is judged by text whatever the count. */
async function memberState(e: Env): Promise<Standing> {
  const { input } = e
  const rows = await e.q.query('SELECT karma, first_message_id FROM members WHERE chat_id = $1 AND user_id = $2', [input.chatId, e.msg.author_id])
  const member = { chatId: input.chatId, userId: e.msg.author_id, upTo: input.meta.isEdit ? null : input.messageId }
  const newcomer = await isNewcomer(e.q, member, e.settings.num('spam_newcomer_messages'))
  return { karma: rows[0]?.karma ?? 0, isFirst: rows[0]?.first_message_id === input.messageId, newcomer, judged: newcomer || input.meta.probation }
}

interface Standing {
  karma: number
  isFirst: boolean
  newcomer: boolean
  judged: boolean
}

function decideInput(e: Env, member: Standing): DecideInput {
  const { settings, facts, input } = e
  return {
    karma: member.karma,
    isFirst: member.isFirst,
    judged: member.judged,
    newcomer: member.newcomer,
    probation: input.meta.probation,
    spam: facts.spam,
    profilePromo: facts.profilePromo,
    auto: settings.num('spam_auto_threshold'),
    profileAuto: settings.num('profile_auto_threshold'),
    reviewDelete: settings.num('probation_review_delete_threshold'),
    review: settings.num('spam_review_threshold'),
    protect: settings.num('protect_threshold'),
  }
}

async function probationLinkDelete(e: Env): Promise<string> {
  await saveHeldText(e)
  await startSpamDelete(e.q, e.input.chatId, { ...flowData(e, 'probation_link'), noCard: true }, e.ctx.clock.now())
  return 'delete'
}

/** Section 3.6: an edit does not undo what was done; the card says what stays. */
const EDIT_DONE: Record<string, string> = {
  steam: 'парилка осталась в силе',
  delete: 'сообщение осталось удалённым',
  card: LEFT_IN_CHAT,
}

/** Section 3.6.0: a softer edit gives a card only when the text is judged (a newcomer or probation). */
async function withoutSanction(e: Env, judged: boolean, previous: string | null): Promise<string | null> {
  const { input } = e
  if (input.meta.probation && input.meta.hasLinks) return probationLinkDelete(e)
  if (previous && input.meta.isEdit && judged) {
    await card(e, 'edit_lowered', `edit_lowered:${input.messageId}:${input.meta.gen}`, { done: EDIT_DONE[previous] })
    return previous
  }
  return null
}

async function applyDecision(e: Env, decision: Decision, judged: boolean): Promise<string | null> {
  const { input } = e
  const previous = e.msg.facts?.sanction ?? null
  if (decision.action === 'none') return withoutSanction(e, judged, previous)
  return previous && input.meta.isEdit ? previous : perform(e, decision.action)
}

async function moderate(e: Env): Promise<string | null> {
  const { input } = e
  const member = await memberState(e)
  const decision = decide(decideInput(e, member))
  const sanction = await applyDecision(e, decision, member.judged)
  const unverifiedMedia = input.meta.mediaOnly && !input.mediaDescribed && member.newcomer
  if (unverifiedMedia && sanction === null) await card(e, 'media_unverified', `media:${input.messageId}`)
  // Section 3.6.3: observation mode no longer touches spam; the bot reaction keeps waiting for the end of the week.
  if (sanction === null && !(await isObserving(e.q, input.chatId, e.settings, input.startedAt))) await maybeReact(e)
  return sanction
}

async function maybeReact(e: Env): Promise<void> {
  const { facts, settings } = e
  if (facts.level === null || facts.level < settings.num('react_min_level')) return
  if ((facts.confidence ?? 0) < settings.num('react_min_confidence')) return
  await submitOpIn(e.q, e.ctx.clock.now(), {
    chatId: e.input.chatId,
    key: `react:${e.input.messageId}`,
    kind: 'set_reaction',
    payload: { messageId: e.input.messageId, emoji: settings.str('bot_reaction_emoji') },
  })
}

/** Applies one evaluation (or its absence) to karma, activity and moderation. Runs inside the caller's transaction. */
export async function applyEvaluation(ctx: Ctx, q: Q, input: ApplyInput): Promise<void> {
  const settings = await getSettings(q, input.chatId, input.settingsSeq)
  const rows = await q.query<MessageRow>('SELECT * FROM messages WHERE chat_id = $1 AND message_id = $2 FOR UPDATE', [input.chatId, input.messageId])
  if (rows.length === 0) return
  const facts = extractFacts(input.answers)
  const msg = rows[0]
  const e: Env = { q, ctx, settings, input, facts, msg, postedAt: new Date(msg.posted_at) }
  const active = facts.isFlood === null || facts.isFlood < settings.num('threshold_is_flood')
  if (active) await recordActivity(q, { chatId: input.chatId, userId: msg.author_id }, e.postedAt, settings.str('timezone'))
  await updateJevKarma(e)
  await updateLadder(e)
  const sanction = input.meta.mode === 'live' ? await moderate(e) : null
  const isAnswer = facts.isAnswer !== null && facts.isAnswer >= settings.num('threshold_is_answer')
  await q.query(
    `UPDATE messages SET eval_gen = GREATEST(eval_gen, $3), usefulness_level = $4, is_answer = $5, facts = $6 WHERE chat_id = $1 AND message_id = $2`,
    [input.chatId, input.messageId, input.meta.gen, facts.level, isAnswer, JSON.stringify({ ...facts, sanction: sanction ?? msg.facts?.sanction ?? null })],
  )
}
