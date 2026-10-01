import type { JevResponse } from './ports.js'

/** Probability from the appeal_genuine answer, or null when the answer is missing or malformed. */
export function extractAppeal(response: JevResponse): number | null {
  const answer = response.answers?.appeal_genuine
  if (!answer || answer.type !== 'noul' || typeof answer.noul !== 'number') return null
  return answer.noul >= 0 && answer.noul <= 1 ? answer.noul : null
}
