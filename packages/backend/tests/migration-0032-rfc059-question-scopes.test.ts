// RFC-059 T2 — migration 0032 adds nullable `question_scopes_json TEXT`
// columns to BOTH `cross_clarify_sessions` (legacy reader for
// `buildExternalFeedbackContext`) and `clarify_rounds` (unified reader for
// `buildPromptContext` cross-questioner branch). The submit handler dual-
// writes the same JSON to both columns; readers may diverge over RFC-058's
// dual-write era, so the column has to land on both tables together or the
// dual-write will fail silently with a SQLite "no such column" error.
//
// Why these tests exist:
//   1. The migration must be `IDX 31` in the drizzle journal (we land
//      after RFC-058's 0031), AND the SQL file must define both ALTER
//      TABLE statements (single line each, plain TEXT NULLABLE).
//   2. New rows persisted post-migration must default `question_scopes_json`
//      to NULL on both tables (so RFC-056/058 behaviour is preserved when
//      the client doesn't send `questionScopes`).
//   3. Existing rows (seeded BEFORE this migration, via the migrator)
//      reach the new state with NULL in the new column — the runtime
//      reader treats NULL as "every question is 'designer'", and any
//      regression that fails to set NULL would break that compat path.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const MIGRATION_FILE = resolve(MIGRATIONS, '0032_rfc059_clarify_rounds_question_scopes.sql')

describe('RFC-059 migration 0032 — table schema changes', () => {
  test('migration file exists and ALTERs BOTH tables (cross_clarify_sessions + clarify_rounds)', () => {
    const sqlText = readFileSync(MIGRATION_FILE, 'utf8')
    expect(sqlText).toMatch(/ALTER TABLE [`"]?cross_clarify_sessions[`"]? ADD COLUMN/i)
    expect(sqlText).toMatch(/ALTER TABLE [`"]?clarify_rounds[`"]? ADD COLUMN/i)
    expect(sqlText).toContain('question_scopes_json')
  })

  test('RFC-217 T8 终态：question_scopes_json 与两张遗留表在 HEAD 已不存在（0107 收尾）', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('clarify_rounds')`)
    expect(cols.map((c) => c.name)).not.toContain('question_scopes_json')
    const tables = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('clarify_sessions','cross_clarify_sessions')`,
    )
    expect(tables).toEqual([])
  })
})
