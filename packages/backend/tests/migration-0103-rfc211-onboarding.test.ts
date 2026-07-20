// RFC-211 T1 — migration 0103.
//
// Why this test exists: every additive migration in this repo carries a
// same-shaped test (see migration-0102-rfc210 / migration-0098-rfc204). Two
// things here are worth pinning specifically:
//
//   1. NOT NULL DEFAULT false on all five `example` columns. If one of them
//      landed nullable, `example = 1` filters would silently skip rows whose
//      value is NULL and cleanup would leave orphans behind; if one landed NOT
//      NULL without a default, the upgrade itself would fail on any non-empty
//      table.
//   2. `uq_onboarding_artifacts_resource` really is UNIQUE. Provision is
//      idempotent BECAUSE of that index — without it a retried step would fork
//      a second bookkeeping row for the same resource and the cleanup ledger
//      would double-count.
//
// The repo has no schema.ts↔SQL drift detector, so these assertions are also
// the only thing standing between a hand-edited migration and a column that
// exists in TypeScript but not in the database.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '@/db/client'

interface ColumnInfo {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
}

function columns(db: Database, table: string): ColumnInfo[] {
  return db.query(`PRAGMA table_info(${table})`).all() as unknown as ColumnInfo[]
}

const MIGRATIONS_FOLDER = join(import.meta.dir, '..', 'db', 'migrations')

function withMigratedDb<T>(fn: (raw: Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'aw-mig-0103-'))
  const dbPath = join(dir, 'test.db')
  try {
    openDb({ path: dbPath, migrationsFolder: MIGRATIONS_FOLDER })
    const raw = new Database(dbPath, { readwrite: true })
    try {
      return fn(raw)
    } finally {
      raw.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('migration 0103 — RFC-211 guided onboarding sandbox', () => {
  test('all five business tables gain example: INTEGER NOT NULL DEFAULT false', () => {
    withMigratedDb((db) => {
      for (const table of ['agents', 'skills', 'workflows', 'workgroups', 'tasks']) {
        const col = columns(db, table).find((c) => c.name === 'example')
        expect({ table, found: col !== undefined }).toEqual({ table, found: true })
        expect({ table, type: col?.type }).toEqual({ table, type: 'INTEGER' })
        expect({ table, notnull: col?.notnull }).toEqual({ table, notnull: 1 })
        expect({ table, dflt: col?.dflt_value }).toEqual({ table, dflt: 'false' })
      }
    })
  })

  test('onboarding_runs carries the progress + suffix columns', () => {
    withMigratedDb((db) => {
      const names = new Set(columns(db, 'onboarding_runs').map((c) => c.name))
      for (const name of [
        'id',
        'user_id',
        'track',
        'status',
        'current_step',
        'completed_steps',
        'suffix',
        'created_at',
        'updated_at',
      ]) {
        expect({ name, present: names.has(name) }).toEqual({ name, present: true })
      }
    })
  })

  test('onboarding_runs cascades from users — a deleted user takes their guide state along', () => {
    withMigratedDb((db) => {
      const fks = db.query('PRAGMA foreign_key_list(onboarding_runs)').all() as unknown as Array<{
        table: string
        on_delete: string
      }>
      const userFk = fks.find((f) => f.table === 'users')
      expect(userFk).toBeDefined()
      expect(userFk?.on_delete).toBe('CASCADE')
    })
  })

  test('onboarding_artifacts key the resource by id and are unique per resource', () => {
    withMigratedDb((db) => {
      const names = new Set(columns(db, 'onboarding_artifacts').map((c) => c.name))
      for (const name of ['run_id', 'resource_type', 'resource_id', 'resource_name']) {
        expect({ name, present: names.has(name) }).toEqual({ name, present: true })
      }
      const indexes = db
        .query('PRAGMA index_list(onboarding_artifacts)')
        .all() as unknown as Array<{ name: string; unique: number }>
      const uq = indexes.find((i) => i.name === 'uq_onboarding_artifacts_resource')
      expect(uq).toBeDefined()
      expect(uq?.unique).toBe(1)
    })
  })

  test('a fresh database seeds NOTHING — the guide only creates on demand', () => {
    // RFC-211 deliberately does not seed example resources at boot. Seeding
    // would (a) make every list non-empty on a brand-new install, which is
    // exactly the condition the first-run surface keys off, and (b) hand every
    // user the same shared rows to break. This assertion turns "we do not seed"
    // into an executable contract instead of a paragraph in a design doc.
    withMigratedDb((db) => {
      for (const table of ['agents', 'skills', 'workflows', 'workgroups', 'tasks']) {
        const row = db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE example = 1`).get() as {
          n: number
        }
        expect({ table, n: row.n }).toEqual({ table, n: 0 })
      }
      const runs = db.query('SELECT COUNT(*) AS n FROM onboarding_runs').get() as { n: number }
      expect(runs.n).toBe(0)
    })
  })
})
