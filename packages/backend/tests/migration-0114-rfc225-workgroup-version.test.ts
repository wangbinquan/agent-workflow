// RFC-225 T1 — workgroup optimistic revision exists on fresh and upgraded DBs.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0114 (RFC-225) — fresh install', () => {
  test('workgroups.version exists and defaults to 1', () => {
    const db = createInMemoryDb(MIGRATIONS)
    db.$client.query("INSERT INTO workgroups (id, name) VALUES ('wg', 'group')").run()
    const row = db.$client.query("SELECT version FROM workgroups WHERE id = 'wg'").get() as {
      version: number
    }
    expect(row.version).toBe(1)
  })
})

describe('migration 0114 (RFC-225) — rolling upgrade', () => {
  let tmp: string
  let raw: Database

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-mig0114-'))
    cpSync(MIGRATIONS, tmp, { recursive: true })
    const journalPath = join(tmp, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 112)
    writeFileSync(journalPath, JSON.stringify(journal))
    raw = new Database(':memory:')
    raw.exec('PRAGMA foreign_keys = OFF')
    migrate(drizzle(raw), { migrationsFolder: tmp })
  })

  afterEach(() => {
    raw?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  test('existing rows backfill version=1 and future inserts default to 1', () => {
    raw.query("INSERT INTO workgroups (id, name) VALUES ('old', 'old-group')").run()
    raw.exec(readFileSync(join(MIGRATIONS, '0114_rfc225_workgroup_version.sql'), 'utf8'))
    raw.query("INSERT INTO workgroups (id, name) VALUES ('new', 'new-group')").run()
    const rows = raw.query('SELECT id, version FROM workgroups ORDER BY id').all() as Array<{
      id: string
      version: number
    }>
    expect(rows).toEqual([
      { id: 'new', version: 1 },
      { id: 'old', version: 1 },
    ])
    expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
