// RFC-213 AC-9 / G4b — the `synchronous` openDb option is really dispatched.
//
// FULL trades throughput for stronger power-loss durability; NORMAL (default) is
// byte-equivalent to the historical setting. MUTATION CHECK (manually verified):
// hardcode `PRAGMA synchronous = NORMAL` in openDb → the FULL assertion reds.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, type DbClient } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-sync-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

function synchronousLevel(db: DbClient): number {
  const s = (db as unknown as { $client: Database }).$client
  return (s.query('PRAGMA synchronous').get() as { synchronous: number }).synchronous
}
function close(db: DbClient): void {
  ;(db as unknown as { $client: Database }).$client.close()
}

describe('RFC-213 AC-9 sqlite synchronous', () => {
  test('synchronous:FULL is dispatched (2); default is NORMAL (1)', () => {
    const full = openDb({
      path: join(tmp(), 'db.sqlite'),
      migrationsFolder: MIGRATIONS,
      synchronous: 'FULL',
    })
    expect(synchronousLevel(full)).toBe(2) // FULL
    close(full)

    const norm = openDb({ path: join(tmp(), 'db.sqlite'), migrationsFolder: MIGRATIONS })
    expect(synchronousLevel(norm)).toBe(1) // NORMAL default (historical)
    close(norm)
  })
})
