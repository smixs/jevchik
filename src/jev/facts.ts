import type { JevAnswer } from '../ports.js'

const SPAM_QUESTIONS = ['spam_earnings_crypto', 'spam_topic_pivot', 'spam_channel_bait', 'spam_other_offer'] as const

export interface Facts {
  spam: number | null
  spamCategory: string | null
  profilePromo: number | null
  rude: number | null
  tone: string | null
  level: number | null
  confidence: number | null
  isAnswer: number | null
  isQuestion: number | null
  isThanks: number | null
  isFlood: number | null
  mediaFits: number | null
}

export type Answers = Record<string, JevAnswer>

function noul(answers: Answers | null, name: string): number | null {
  const answer = answers?.[name]
  if (!answer || answer.type !== 'noul') return null
  const value = answer.noul
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : null
}

const inRange = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && value >= min && value <= max

function score(answers: Answers | null): { level: number | null; confidence: number | null } {
  const answer = answers?.usefulness
  const none = { level: null, confidence: null }
  if (!answer || answer.type !== 'score' || !inRange(answer.score, 0, 4)) return none
  if (answer.confidence !== undefined && !inRange(answer.confidence, 0, 1)) return none
  return { level: Math.round(answer.score), confidence: answer.confidence ?? null }
}

function spamOf(answers: Answers | null): { spam: number | null; category: string | null } {
  let spam: number | null = null
  let category: string | null = null
  for (const name of SPAM_QUESTIONS) {
    const value = noul(answers, name)
    if (value !== null && (spam === null || value > spam)) {
      spam = value
      category = name
    }
  }
  return { spam, category }
}

/** A missing or malformed answer is "no data" (null), never zero. */
export function extractFacts(answers: Answers | null): Facts {
  const { spam, category } = spamOf(answers)
  const promo = noul(answers, 'profile_promo')
  const tone = answers?.tone
  const { level, confidence } = score(answers)
  return {
    spam,
    spamCategory: category,
    profilePromo: promo,
    rude: noul(answers, 'rude'),
    tone: tone?.type === 'choice' && typeof tone.choice === 'string' ? tone.choice : null,
    level,
    confidence,
    isAnswer: noul(answers, 'is_answer'),
    isQuestion: noul(answers, 'is_question'),
    isThanks: noul(answers, 'is_thanks'),
    isFlood: noul(answers, 'is_flood'),
    mediaFits: noul(answers, 'media_fits'),
  }
}
