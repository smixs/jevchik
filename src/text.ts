import { createHash } from 'node:crypto'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment)
}

export function truncateGraphemes(text: string, limit: number): string {
  const parts = graphemes(text)
  return parts.length <= limit ? text : parts.slice(0, limit).join('')
}

/** The longest prefix of whole grapheme clusters within both limits: `units` counts UTF-16 code units, as Telegram does. */
export function fitGraphemes(text: string, limit: number, units: number): { text: string; count: number } {
  let out = ''
  let count = 0
  for (const { segment } of segmenter.segment(text)) {
    if (count >= limit || out.length + segment.length > units) break
    out += segment
    count++
  }
  return { text: out, count }
}

const EXCERPT_LIMIT = 200

export function makeExcerpt(text: string): string {
  return truncateGraphemes(text, EXCERPT_LIMIT)
}

export function maskName(name: string): string {
  const first = graphemes(name.trim())[0] ?? ''
  return `${first}***`
}

export function graphemeLength(text: string): number {
  return graphemes(text).length
}

/** Emoji of any kind: pictographs, flags, keycaps and the emoji variation selector. */
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|\u{FE0F}|\u{20E3}/u

export function hasEmoji(text: string): boolean {
  return EMOJI.test(text)
}

/** The member tag of section 3.12: `{n}` is the karma rounded with Math.round, signed: +321, -12, 0. */
export function karmaTag(template: string, karma: number): string {
  const n = Math.round(karma)
  return template.replaceAll('{n}', n > 0 ? `+${n}` : String(n))
}

export interface Content {
  text: string
  caption: string
  /** `kind:file_unique_id` of the attachment, null without one. */
  attachment: string | null
}

/** SHA-256 of what a message says (section 3.6): an edit is a change of this hash. The text itself is not stored. */
export function contentHash(content: Content): Buffer {
  return createHash('sha256').update(JSON.stringify([content.text, content.caption, content.attachment])).digest()
}
