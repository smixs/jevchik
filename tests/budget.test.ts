import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildClient } from './support/web.js'

function run(dir: string, env: Record<string, string> = {}) {
  return spawnSync('node', ['scripts/check-budget.mjs', dir], { encoding: 'utf8', env: { ...process.env, ...env } })
}

describe('Mini App size budget (HTML + CSS + JS, Brotli, 150 KiB)', () => {
  it('the production bundle is within the budget', async () => {
    const result = run(await buildClient())
    expect(result.status).toBe(0)
    const total = Number(/total: (\d+) of 153600/.exec(result.stdout)?.[1])
    expect(total).toBeGreaterThan(0)
    expect(total).toBeLessThan(150 * 1024)
  })

  it('the command fails when the budget is exceeded', async () => {
    const result = run(await buildClient(), { BUDGET_BYTES: '100' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('budget exceeded')
  })
})
