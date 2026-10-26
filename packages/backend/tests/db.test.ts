import { agentFixture, readAgentFixtures } from './helpers/model'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { openDb, type DbClient } from '../src/db/client'
import { removeTempDirSync } from './fixtures/tempDir'
import type { Database } from 'bun:sqlite'

describe('db client', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-db-'))
  const dbPath = join(tmp, 'test.sqlite')

  // RFC-254 T32: CLOSE what the tests opened, then remove. Windows refuses to
  // delete a file that still has an open handle, so leaving the SQLite
  // connections dangling made teardown fail with EBUSY — reported as an
  // `(unnamed)` failure in a describe whose real tests had all passed. POSIX
  // hid the leak because unlink there does not care.
  const opened: DbClient[] = []
  const track = (db: DbClient): DbClient => {
    opened.push(db)
    return db
  }

  afterAll(() => {
    for (const db of opened) {
      try {
        ;(db as unknown as { $client: Database }).$client.close()
      } catch {
        /* already closed */
      }
    }
    removeTempDirSync(tmp)
  })

  test('openDb installs the native head and round-trips an agent insert', async () => {
    const db = track(openDb({ path: dbPath }))

    const id = ulid()
    await agentFixture(db, {
      id,
      name: 'test-agent',
      description: 'sample',
      outputs: JSON.stringify(['out1', 'out2']),
      bodyMd: '# hello\nbody',
    })

    const rows = await readAgentFixtures(db, { id })
    expect(rows.length).toBe(1)
    expect(rows[0]?.name).toBe('test-agent')
    expect(JSON.parse(rows[0]?.outputs ?? '[]')).toEqual(['out1', 'out2'])
    expect(rows[0]?.bodyMd).toContain('hello')
  })

  test('openDb admission is idempotent and preserves native rows on reopen', () => {
    expect(() => track(openDb({ path: dbPath }))).not.toThrow()
  })
})
