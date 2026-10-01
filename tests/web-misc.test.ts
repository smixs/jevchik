import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from './support/harness.js'
import { VECTORS } from './support/vectors.js'
import { get, makeWeb, seedWorld, send } from './support/web.js'

let h: Harness
let web: Awaited<ReturnType<typeof makeWeb>>
beforeEach(async () => {
  h = await createHarness()
  await seedWorld(h)
  h.tg.members.set(99, 'administrator')
  web = await makeWeb(h)
})
afterEach(async () => {
  await h.close()
})

describe('two administrators extending the observation', () => {
  it('the loser gets 409, not 500', async () => {
    await h.db.query(`CREATE FUNCTION slow() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$ LANGUAGE plpgsql`)
    await h.db.query(`CREATE TRIGGER slow BEFORE INSERT ON chat_settings FOR EACH ROW EXECUTE FUNCTION slow()`)
    const post = (until: string) => send(web, 'POST', '/api/admin/observation', VECTORS.admin_admin, { until })
    const results = await Promise.all([post('2026-09-20T00:00:00Z'), post('2026-09-21T00:00:00Z')])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    const loser = results.find((r) => r.status === 409)!
    expect((await loser.json()).error).toBe('conflict')
  })
})

describe('a participant who hid the page sees their own name', () => {
  it('on their own page; others still get 404 and the leaderboard row stays masked', async () => {
    await send(web, 'POST', '/api/me/hide', VECTORS.bob_lb, { hidden: true })
    const own = await (await get(web, '/api/me', VECTORS.bob_lb)).json()
    expect([own.name, own.hidden]).toEqual(['Bob', true])
    const board = await (await get(web, '/api/leaderboard?period=all', VECTORS.alice_lb)).json()
    const bob = board.rows.find((r: { name: string }) => r.name === 'B***')
    expect(bob).toBeTruthy()
    expect((await get(web, `/api/members/${bob.public_id}`, VECTORS.alice_lb)).status).toBe(404)
    const ownById = await (await get(web, `/api/members/${bob.public_id}`, VECTORS.bob_lb)).json()
    expect(ownById.name).toBe('Bob')
  })
})
