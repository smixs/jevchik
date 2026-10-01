import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

mkdirSync('dist/public', { recursive: true })
await build({
  entryPoints: ['src/web/client/app.ts'],
  bundle: true,
  minify: true,
  target: 'es2020',
  format: 'iife',
  outfile: 'dist/public/app.js',
})
cpSync('src/web/client/style.css', 'dist/public/style.css')
// The script and the styles are cached for an hour; their address carries a hash of the content, so a new build is seen at once.
const stamp = (file) => createHash('sha256').update(readFileSync(`dist/public/${file}`)).digest('hex').slice(0, 12)
const page = readFileSync('src/web/client/index.html', 'utf8')
  .replace('"/app.js"', `"/app.js?v=${stamp('app.js')}"`)
  .replace('"/style.css"', `"/style.css?v=${stamp('style.css')}"`)
writeFileSync('dist/public/index.html', page)
cpSync('src/migrations', 'dist/migrations', { recursive: true })
