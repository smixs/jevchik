import process from 'node:process'
import { runBot } from './bot.js'
import { readConfig } from './config.js'
import { Db } from './db.js'
import { buildReport, renderReport } from './monitor.js'
import { runWeb } from './web.js'

async function main(mode: string | undefined): Promise<void> {
  if (mode !== 'bot' && mode !== 'web' && mode !== 'monitor') {
    console.error('usage: node dist/main.js bot|web|monitor')
    process.exit(2)
  }
  const config = readConfig()
  if (mode === 'monitor') {
    const db = new Db(config.databaseUrl, 2)
    console.log(renderReport(await buildReport(db, new Date())))
    await db.close()
    return
  }
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
