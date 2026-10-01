import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { readConfig } from '../src/config.js'

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compose = parse(read('docker-compose.yml'), { merge: true }) as {
  services: Record<string, { image?: string; build?: unknown; platform?: string; command?: string[]; healthcheck?: { test: string[] }; depends_on?: Record<string, { condition: string }>; environment?: Record<string, string>; ports?: string[]; labels?: Record<string, string>; volumes?: string[] }>
  volumes: Record<string, unknown>
}

describe('F1 (static part only: no Docker on the build machine)', () => {
  it('compose defines exactly db, bot and web; the database image is postgres:16-alpine', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['bot', 'db', 'web'])
    expect(compose.services.db.image).toBe('postgres:16-alpine')
  })

  it('images are built for linux/arm64', () => {
    for (const name of ['bot', 'web', 'db']) expect(compose.services[name].platform).toBe('linux/arm64')
    expect(read('Dockerfile')).toMatch(/FROM --platform=linux\/arm64 node:22-alpine AS build/)
    expect(read('Dockerfile').match(/^FROM /gm)).toHaveLength(2)
  })

  it('every service has a health check, the app waits for a healthy database, containers are excluded from auto-update', () => {
    for (const name of ['bot', 'web', 'db']) {
      expect(compose.services[name].healthcheck?.test.length, name).toBeGreaterThan(1)
      expect(compose.services[name].labels?.['com.centurylinklabs.watchtower.enable'], name).toBe('false')
    }
    for (const name of ['bot', 'web']) expect(compose.services[name].depends_on?.db.condition).toBe('service_healthy')
  })

  it('the web service listens on a local port and its health check is /healthz', () => {
    expect(compose.services.web.ports).toEqual(['127.0.0.1:${WEB_PORT:-8080}:8080'])
    expect(compose.services.web.healthcheck?.test.join(' ')).toContain('/healthz')
    expect(compose.services.web.command).toEqual(['node', 'dist/main.js', 'web'])
    expect(compose.services.bot.command).toEqual(['node', 'dist/main.js', 'bot'])
  })

  it('the import volume is shared by bot and web', () => {
    expect(compose.services.bot.volumes).toEqual(['imports:/data/imports'])
    expect(compose.services.web.volumes).toEqual(['imports:/data/imports'])
    expect(Object.keys(compose.volumes).sort()).toEqual(['imports', 'pgdata'])
  })

  it('required secrets are required by compose, and the environment matches what the code reads', () => {
    const env = compose.services.bot.environment!
    for (const name of ['TELEGRAM_BOT_TOKEN', 'TYPESAFE_API_KEY']) expect(env[name]).toContain(':?')
    expect(env.DATABASE_URL).toContain('@db:5432/')
    const config = readConfig({ DATABASE_URL: 'x', TELEGRAM_BOT_TOKEN: 'y', TYPESAFE_API_KEY: 'z', ...Object.fromEntries(Object.keys(env).map((k) => [k, 'v'])) })
    expect(config.importDir).toBe('v')
    expect(() => readConfig({})).toThrow('DATABASE_URL')
    expect(() => readConfig({ DATABASE_URL: 'x', TELEGRAM_BOT_TOKEN: 'y' })).toThrow('TYPESAFE_API_KEY')
  })

  it('the Dockerfile builds, prunes, runs as an unprivileged user and copies no secrets', () => {
    const file = read('Dockerfile')
    expect(file).toContain('npm ci')
    expect(file).toContain('npm run build')
    expect(file).toContain('npm prune --omit=dev')
    expect(file).toContain('USER node')
    expect(file).not.toMatch(/COPY .*\.env/)
    for (const line of file.split('\n').filter((l) => l.trim() && !l.startsWith('#'))) expect(line).toMatch(/^(FROM|WORKDIR|COPY|RUN|ENV|USER|EXPOSE|CMD)\s/)
    expect(read('.dockerignore').split('\n')).toEqual(expect.arrayContaining(['.env', 'node_modules', '.scratch']))
  })

  it('.env.example lists names without values', () => {
    const lines = read('.env.example').split('\n').filter((l) => l && !l.startsWith('#'))
    expect(lines.every((l) => /^[A-Z_]+=$/.test(l))).toBe(true)
    const names = lines.map((l) => l.slice(0, -1))
    for (const required of ['TELEGRAM_BOT_TOKEN', 'TYPESAFE_API_KEY', 'VISION_BASE_URL', 'VISION_MODEL', 'VISION_API_KEY', 'POSTGRES_PASSWORD']) expect(names).toContain(required)
  })

  it('npm test and test:coverage build dist first, so the packaging check cannot be skipped', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>
    expect(scripts.test).toMatch(/^npm run build && /)
    expect(scripts['test:coverage']).toMatch(/^npm run build && /)
  })

  it('.env is ignored by git and by Docker', () => {
    expect(read('.gitignore')).toMatch(/^\.env$/m)
  })
})
