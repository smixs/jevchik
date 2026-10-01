import { readdirSync, readFileSync } from 'node:fs'
import pg from 'pg'

pg.types.setTypeParser(20, (value) => Number(value))
pg.types.setTypeParser(1700, (value) => Number(value))

export type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Q {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>
}

const RETRYABLE = new Set(['40001', '40P01'])

export class Db implements Q {
  readonly pool: pg.Pool

  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 3000 })
    this.pool.on('error', () => {})
  }

  async query<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params as unknown[])
    return result.rows as T[]
  }

  async tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runTx(fn)
      } catch (error) {
        const code = (error as { code?: string }).code
        if (attempt >= 3 || !code || !RETRYABLE.has(code)) throw error
      }
    }
  }

  private async runTx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    const q: Q = {
      query: async <R = Row>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as R[],
    }
    try {
      await client.query('BEGIN')
      const value = await fn(q)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

export async function migrate(db: Db): Promise<void> {
  const dir = new URL('./migrations/', import.meta.url)
  const files = readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()
  const client = await db.pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(727272)')
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)')
    for (const name of files) {
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name])
      if (done.rowCount) continue
      await client.query('BEGIN')
      await client.query(readFileSync(new URL(name, dir), 'utf8'))
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
      await client.query('COMMIT')
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727272)').catch(() => {})
    client.release()
  }
}
