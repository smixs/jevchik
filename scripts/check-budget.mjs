// Fails when HTML + CSS + JS of the Mini App exceed 150 KiB after Brotli.
// Usage: node scripts/check-budget.mjs [dir]   (default dist/public, run after `npm run build`)
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { brotliCompressSync } from 'node:zlib'

const LIMIT = Number(process.env.BUDGET_BYTES) || 150 * 1024
const dir = process.argv[2] ?? 'dist/public'
let total = 0
for (const file of ['index.html', 'style.css', 'app.js']) {
  const size = brotliCompressSync(readFileSync(join(dir, file))).length
  console.log(`${file}: ${size} bytes (brotli)`)
  total += size
}
console.log(`total: ${total} of ${LIMIT}`)
if (total > LIMIT) {
  console.error('budget exceeded')
  process.exit(1)
}
