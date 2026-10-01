import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export async function readStatic(root: string, urlPath: string): Promise<{ body: Buffer; type: string } | null> {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '')
  if (clean.startsWith('..')) return null
  const type = TYPES[extname(clean)]
  if (!type) return null
  try {
    return { body: await readFile(join(root, clean)), type }
  } catch {
    return null
  }
}
