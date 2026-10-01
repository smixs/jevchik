import { JEV_MODEL } from '../ctx.js'
import type { JevRequest } from '../ports.js'
import type { QuestionSet } from '../settings/settings.js'

interface SenderProfile {
  name: string
  username: string | null
  bio: string | null
}

export interface JevState {
  message: string
  replied_to: string | null
  previous_messages: string[]
  /** Section 3.6.0: how long the sender has been in the chat; null where it is not known (appeal, import). */
  sender_history: string | null
  media_description: string | null
  sender_profile: SenderProfile | null
}

export const TOKENS_PER_REQUEST = 64_000
export const TOKENS_STATE_AND_QUESTION = 32_000
export const TRUNCATION_MARK = '…[truncated]'

export function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 2)
}

function buildState(state: JevState): JevState {
  return {
    message: state.message,
    replied_to: state.replied_to ?? null,
    previous_messages: state.previous_messages ?? [],
    sender_history: state.sender_history ?? null,
    media_description: state.media_description ?? null,
    sender_profile: state.sender_profile ?? null,
  }
}

export function buildRequest(state: JevState, questions: QuestionSet): JevRequest {
  return { state: { ...buildState(state) }, model: JEV_MODEL, questions }
}

export interface QuestionFilter {
  hasProfile: boolean
  hasMedia: boolean
  hasReply: boolean
}

/** Applies the presence rules of section 3.5. appeal_genuine never belongs to message evaluation. */
export function selectQuestions(all: QuestionSet, filter: QuestionFilter): QuestionSet {
  const picked: QuestionSet = {}
  for (const [name, question] of Object.entries(all)) {
    if (name === 'appeal_genuine') continue
    if (name === 'profile_promo' && !filter.hasProfile) continue
    if (name === 'media_fits' && !(filter.hasMedia && filter.hasReply)) continue
    picked[name] = question
  }
  return picked
}

function longestQuestion(questions: QuestionSet): number {
  return Math.max(0, ...Object.values(questions).map((question) => estimateTokens(question)))
}

export function fits(request: JevRequest): boolean {
  const total = estimateTokens(request)
  const stateAndQuestion = estimateTokens(request.state) + longestQuestion(request.questions as QuestionSet)
  return total <= TOKENS_PER_REQUEST && stateAndQuestion <= TOKENS_STATE_AND_QUESTION
}

function cutMessage(state: JevState, questions: QuestionSet): JevState | null {
  const chars = Array.from(state.message)
  let keep = chars.length
  while (keep > 0) {
    keep = Math.floor(keep * 0.8)
    const candidate = { ...state, message: chars.slice(0, keep).join('') + TRUNCATION_MARK }
    if (fits(buildRequest(candidate, questions))) return candidate
  }
  return null
}

export interface Fitted {
  request: JevRequest
  truncated: boolean
}

/**
 * Truncation order from section 3.5: older previous_messages, replied_to, media_description, sender_profile, message.
 * sender_history (section 3.6.0) is about the sender too and goes together with sender_profile.
 */
export function fitRequest(input: JevState, questions: QuestionSet): Fitted | null {
  let state = buildState(input)
  const attempt = (): boolean => fits(buildRequest(state, questions))
  let truncated = false
  const stages: Array<() => boolean> = [
    () => {
      if (state.previous_messages.length === 0) return false
      state = { ...state, previous_messages: state.previous_messages.slice(1) }
      return true
    },
    () => {
      if (state.replied_to === null) return false
      state = { ...state, replied_to: null }
      return true
    },
    () => {
      if (state.media_description === null) return false
      state = { ...state, media_description: null }
      return true
    },
    () => {
      if (state.sender_profile === null && state.sender_history === null) return false
      state = { ...state, sender_profile: null, sender_history: null }
      return true
    },
  ]
  if (attempt()) return { request: buildRequest(state, questions), truncated }
  for (const stage of stages) {
    while (stage()) {
      truncated = true
      if (attempt()) return { request: buildRequest(state, questions), truncated }
    }
  }
  const cut = cutMessage(state, questions)
  return cut ? { request: buildRequest(cut, questions), truncated: true } : null
}
