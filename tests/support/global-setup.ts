import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string
  }
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => done(port))
    })
  })
}

function run(command: string, args: string[]): void {
  // pg_ctl and initdb must not depend on the caller's locale variables: an empty LANG makes postgres fail to start.
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stdout}${result.stderr}`)
}

/** Starts a throwaway PostgreSQL cluster in .scratch/pg on a free port, unless TEST_DATABASE_URL points at one. */
export default async function setup(project: TestProject): Promise<() => void> {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('pgAdminUrl', process.env.TEST_DATABASE_URL)
    return () => {}
  }
  const bin = process.env.PG_BIN ?? '/opt/homebrew/bin'
  const dir = resolve('.scratch/pg')
  if (existsSync(join(dir, 'postmaster.pid'))) run(join(bin, 'pg_ctl'), ['-D', dir, '-m', 'immediate', 'stop'])
  rmSync(dir, { recursive: true, force: true })
  run(join(bin, 'initdb'), ['-D', dir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--locale=C'])
  const port = await freePort()
  appendFileSync(
    join(dir, 'postgresql.conf'),
    `\nlisten_addresses = '127.0.0.1'\nport = ${port}\nunix_socket_directories = ''\nfsync = off\nsynchronous_commit = off\nfull_page_writes = off\nmax_connections = 300\n`,
  )
  run(join(bin, 'pg_ctl'), ['-D', dir, '-l', join(dir, 'server.log'), '-w', 'start'])
  project.provide('pgAdminUrl', `postgres://postgres@127.0.0.1:${port}/postgres`)
  return () => {
    run(join(bin, 'pg_ctl'), ['-D', dir, '-m', 'immediate', '-w', 'stop'])
    rmSync(dir, { recursive: true, force: true })
  }
}
