import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { buildContext, dataCheckString, parseContext, verifyInitData } from '../src/web/auth.js'
import { AUTH_T0, BOT_TOKEN, OTHER_BOT_TOKEN, VECTORS } from './support/vectors.js'

const now = new Date(AUTH_T0 * 1000)

describe('F18: initData verification against independently computed vectors', () => {
  it('accepts a valid vector and returns the user and the start parameter', () => {
    const result = verifyInitData(VECTORS.bob_lb, BOT_TOKEN, now)
    expect(result).toEqual({ ok: true, user: { id: 2, first_name: 'Bob', username: 'bob' }, startParam: 'lb_-1001234567890', authDate: AUTH_T0 })
  })

  it('accepts non-ASCII names', () => {
    const result = verifyInitData(VECTORS.cyr, BOT_TOKEN, now)
    expect(result.ok && result.user.first_name).toBe('Карол Ёлкина')
  })

  it('rejects data signed by another bot', () => {
    expect(verifyInitData(VECTORS.other_bot, BOT_TOKEN, now)).toEqual({ ok: false, reason: 'bad_hash' })
    expect(verifyInitData(VECTORS.bob_lb, OTHER_BOT_TOKEN, now)).toEqual({ ok: false, reason: 'bad_hash' })
  })

  it('rejects an expired auth_date and accepts exactly 24 hours', () => {
    expect(verifyInitData(VECTORS.old, BOT_TOKEN, now)).toEqual({ ok: false, reason: 'expired' })
    expect(verifyInitData(VECTORS.edge, BOT_TOKEN, now).ok).toBe(true)
  })

  it('rejects missing and malformed input', () => {
    expect(verifyInitData(undefined, BOT_TOKEN, now)).toEqual({ ok: false, reason: 'missing' })
    expect(verifyInitData('', BOT_TOKEN, now)).toEqual({ ok: false, reason: 'missing' })
    expect(verifyInitData('user=1', BOT_TOKEN, now)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyInitData(`${VECTORS.bob_lb}&hash=${'0'.repeat(64)}`, BOT_TOKEN, now)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('a mutation of the hash, of every signed field, or a removed or added field breaks the signature', () => {
    const params = new URLSearchParams(VECTORS.bob_lb)
    const rebuild = (mutate: (p: URLSearchParams) => void): string => {
      const copy = new URLSearchParams(VECTORS.bob_lb)
      mutate(copy)
      return copy.toString()
    }
    for (const key of params.keys()) {
      const changed = rebuild((p) => p.set(key, `${p.get(key)}x`))
      const result = verifyInitData(changed, BOT_TOKEN, now)
      expect(result.ok, `changing ${key}`).toBe(false)
      const removed = rebuild((p) => p.delete(key))
      expect(verifyInitData(removed, BOT_TOKEN, now).ok, `removing ${key}`).toBe(false)
    }
    expect(verifyInitData(rebuild((p) => p.set('extra', '1')), BOT_TOKEN, now).ok).toBe(false)
    const hash = params.get('hash')!
    const flipped = `${hash.slice(0, -1)}${hash.endsWith('0') ? '1' : '0'}`
    expect(verifyInitData(rebuild((p) => p.set('hash', flipped)), BOT_TOKEN, now).ok).toBe(false)
    expect(verifyInitData(rebuild((p) => p.set('hash', hash.toUpperCase())), BOT_TOKEN, now).ok).toBe(false)
  })

  it('the order of the pairs does not matter', () => {
    const pairs = [...new URLSearchParams(VECTORS.admin_admin).entries()]
    fc.assert(
      fc.property(fc.shuffledSubarray(pairs, { minLength: pairs.length, maxLength: pairs.length }), (shuffled) => {
        const raw = shuffled.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
        expect(verifyInitData(raw, BOT_TOKEN, now).ok).toBe(true)
      }),
    )
  })

  it('a repeated key is refused', () => {
    expect(dataCheckString(`${VECTORS.bob_lb}&query_id=other`)).toBeNull()
    expect(verifyInitData(`${VECTORS.bob_lb}&query_id=other`, BOT_TOKEN, now)).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('start_param context', () => {
  it('parses screen and chat id, negative ids included', () => {
    expect(parseContext('lb_-1001234567890')).toEqual({ screen: 'lb', chatId: -1001234567890 })
    expect(parseContext('appeal_-42')).toEqual({ screen: 'appeal', chatId: -42 })
    expect(parseContext(buildContext('admin', -1009876543210))).toEqual({ screen: 'admin', chatId: -1009876543210 })
  })

  it('refuses anything else', () => {
    for (const bad of [null, '', 'lb', 'lb_', 'xx_-1', 'lb_abc', 'lb_-1;drop', 'LB_-1', 'lb_-12345678901234567890']) expect(parseContext(bad)).toBeNull()
  })
})
