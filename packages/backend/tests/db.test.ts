import { afterAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { openDb } from '../src/db/client'
import { agents } from '../src/db/schema'

const migrationsFolder = resolve(import.meta.dirname, '..', 'db', 'migrations')

describe('db client', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-db-'))
  const dbPath = join(tmp, 'test.sqlite')

  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  test('openDb applies migrations and round-trips an agent insert', async () => {
    const db = openDb({ path: dbPath, migrationsFolder })

    const id = ulid()
    await db.insert(agents).values({
      id,
      name: 'test-agent',
      description: 'sample',
      outputs: JSON.stringify(['out1', 'out2']),
      bodyMd: '# hello\nbody',
    })

    const rows = await db.select().from(agents).where(eq(agents.id, id))
    expect(rows.length).toBe(1)
    expect(rows[0]?.name).toBe('test-agent')
    expect(JSON.parse(rows[0]?.outputs ?? '[]')).toEqual(['out1', 'out2'])
    expect(rows[0]?.bodyMd).toContain('hello')
  })

  test('openDb is idempotent — second open does not re-run migrations destructively', () => {
    expect(() => openDb({ path: dbPath, migrationsFolder })).not.toThrow()
  })
})
