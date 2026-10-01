import type { Ctx } from './ctx.js'
import { withRetry } from './retry.js'

interface MediaCandidate {
  fileId: string
  size?: number
}

export interface MediaRef {
  kind: 'photo' | 'sticker' | 'animation'
  uniqueId: string
  emoji?: string | null
  candidates: MediaCandidate[]
}

const MAX_MEDIA_BYTES = 5 * 1024 * 1024

const inflight = new WeakMap<Ctx, Map<string, Promise<string | null>>>()

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }

function mimeOf(path: string): string | null {
  return MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? null
}

async function describeCandidate(ctx: Ctx, candidate: MediaCandidate): Promise<string | null> {
  if (candidate.size !== undefined && candidate.size > MAX_MEDIA_BYTES) return null
  const info = await withRetry(ctx, () => ctx.tg.getFile(candidate.fileId))
  if (!info.file_path || (info.file_size !== undefined && info.file_size > MAX_MEDIA_BYTES)) return null
  const mime = mimeOf(info.file_path)
  if (!mime) return null
  const image = await withRetry(ctx, () => ctx.tg.downloadFile(info.file_path as string))
  return ctx.vision!.describe({ image, mime })
}

async function describeUncached(ctx: Ctx, media: MediaRef): Promise<string | null> {
  for (const candidate of media.candidates) {
    try {
      const text = await describeCandidate(ctx, candidate)
      if (text && text.trim()) return text.trim()
    } catch (error) {
      ctx.log.warn('vision_failed', { kind: media.kind, error: String(error).slice(0, 200) })
      return null
    }
  }
  return null
}

async function cachedDescription(ctx: Ctx, media: MediaRef): Promise<string | null> {
  const rows = await ctx.db.query('SELECT description FROM media_descriptions WHERE file_unique_id = $1', [media.uniqueId])
  if (rows[0]) return rows[0].description as string
  const text = await describeUncached(ctx, media)
  if (text) {
    await ctx.db.query(
      'INSERT INTO media_descriptions (file_unique_id, description, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [media.uniqueId, text, ctx.clock.now()],
    )
  }
  return text
}

function composeDescription(media: MediaRef, text: string): string {
  const emoji = media.emoji ? ` (${media.emoji})` : ''
  const label = media.kind === 'animation' ? 'gif' : media.kind
  return `${label}${emoji}: ${text}`
}

/** Description of a photo, sticker or gif for Jev. Never throws; null means "no description". */
export async function describeMedia(ctx: Ctx, media: MediaRef): Promise<string | null> {
  if (!ctx.vision) return null
  let map = inflight.get(ctx)
  if (!map) inflight.set(ctx, (map = new Map()))
  let pending = map.get(media.uniqueId)
  if (!pending) {
    pending = cachedDescription(ctx, media).finally(() => map!.delete(media.uniqueId))
    map.set(media.uniqueId, pending)
  }
  const text = await pending.catch(() => null)
  return text ? composeDescription(media, text) : null
}
