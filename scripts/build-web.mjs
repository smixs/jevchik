import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

mkdirSync('dist/public', { recursive: true })
await build({
  entryPoints: ['src/web/client/app.ts'],
  bundle: true,
  minify: true,
  target: 'es2020',
  format: 'iife',
  outfile: 'dist/public/app.js',
})
cpSync('src/web/client/index.html', 'dist/public/index.html')
cpSync('src/web/client/style.css', 'dist/public/style.css')
cpSync('src/migrations', 'dist/migrations', { recursive: true })
