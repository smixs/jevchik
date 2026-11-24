// Прогон выгруженных сообщений через Jev.
// Запуск: node eval/run.mjs <chat> [--limit N] [--dry]
// --dry печатает первый запрос и оценку объёма, в сеть не ходит.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'

const [chat, ...flags] = process.argv.slice(2)
if (!chat) throw new Error('usage: node eval/run.mjs <chat> [--limit N] [--dry]')
const dry = flags.includes('--dry')
const limit = Number(flags[flags.indexOf('--limit') + 1]) || 300
const MODEL = 'jev-1.13.0'
const CONTEXT = 3
const CONCURRENCY = 8

const root = new URL('..', import.meta.url).pathname
const messages = JSON.parse(readFileSync(`${root}data/raw/${chat}.json`, 'utf8')).result.results
  .filter((m) => !m.action)
  .reverse()
const questions = JSON.parse(readFileSync(`${root}eval/questions.json`, 'utf8'))
const byId = new Map(messages.map((m) => [m.id, m]))

const line = (m) => `${m.sender}: ${m.text || (m.media ? '[media]' : '')}`

function request(m, i) {
  const parent = byId.get(m.reply_to)
  const state = {
    message: m.text,
    replied_to: parent ? line(parent) : null,
    previous_messages: messages.slice(Math.max(0, i - CONTEXT), i).map(line),
    // профиля в выгрузке нет, вопрос profile_promo на этом прогоне не задаётся
  }
  const { profile_promo, media_fits, ...asked } = questions
  return { state, model: MODEL, questions: asked }
}

// равномерная выборка по всей выгрузке, только сообщения с текстом
const withText = messages.map((m, i) => [m, i]).filter(([m]) => m.text && m.text.trim())
const step = Math.max(1, Math.floor(withText.length / limit))
const sample = withText.filter((_, k) => k % step === 0).slice(0, limit)

if (dry) {
  const bodies = sample.map(([m, i]) => JSON.stringify(request(m, i)))
  const chars = bodies.reduce((s, b) => s + b.length, 0)
  console.log(bodies[0])
  console.log(`\nсообщений: ${sample.length}, знаков в запросах: ${chars}`)
  console.log(`грубая оценка: ${Math.round(chars / 3)} токенов, $${((chars / 3 / 1e6) * 0.042).toFixed(4)}`)
  process.exit(0)
}

const key = process.env.TYPESAFE_API_KEY
if (!key) throw new Error('нет TYPESAFE_API_KEY (node --env-file=.env eval/run.mjs ...)')

async function ask(body, attempt = 1) {
  const res = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const wait = Number(res.headers.get('retry-after')) || 2 ** attempt
    await new Promise((r) => setTimeout(r, wait * 1000))
    return ask(body, attempt + 1)
  }
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return res.json()
}

mkdirSync(`${root}data/eval`, { recursive: true })
const out = `${root}data/eval/${chat}.jsonl`
const done = new Set(
  existsSync(out) ? readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : [],
)
const queue = sample.filter(([m]) => !done.has(m.id))
let tokens = 0
let failed = 0

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [m, i] = job
      try {
        const r = await ask(request(m, i))
        tokens += r.usage?.input_tokens ?? 0
        const row = {
          id: m.id,
          sender_id: m.sender_id,
          reactions: m.engagement?.reactions ?? 0,
          replies: m.comments ?? 0,
          text: m.text,
          answers: r.answers,
        }
        writeFileSync(out, JSON.stringify(row) + '\n', { flag: 'a' })
      } catch (e) {
        failed++
        console.error(m.id, String(e.message).slice(0, 200))
      }
    }
  }),
)

console.log(`готово: ${out}`)
console.log(`входных токенов: ${tokens}, $${((tokens / 1e6) * 0.042).toFixed(4)}, ошибок: ${failed}`)
