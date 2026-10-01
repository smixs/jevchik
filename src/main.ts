import process from 'node:process'
import { runBot } from './bot.js'
import { readConfig } from './config.js'
import { runWeb } from './web.js'

async function main(mode: string | undefined): Promise<void> {
  if (mode !== 'bot' && mode !== 'web') {
    console.error('usage: node dist/main.js bot|web')
    process.exit(2)
  }
  const config = readConfig()
  if (mode === 'web') {
    await runWeb(config)
    return
  }
  const abort = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => abort.abort())
  await runBot(config, abort.signal)
}

main(process.argv[2]).catch((error) => {
  console.error(error)
  process.exit(1)
})
