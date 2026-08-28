import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION = resolve(
  import.meta.dir,
  '..',
  'db',
  'migrations',
  '0215_rfc336_employee_case_advanced_options.sql',
)

describe('migration 0215 — digital employee Case advanced options', () => {
  test('preserves existing Cases and installs exact-once metering storage', () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE employee_cases (id TEXT PRIMARY KEY NOT NULL);
      INSERT INTO employee_cases (id) VALUES ('legacy-case');
    `)

    sqlite.exec(readFileSync(MIGRATION, 'utf8'))

    expect(
      sqlite
        .query(
          `SELECT max_duration_ms, consumed_duration_ms, max_total_tokens, consumed_total_tokens
             FROM employee_cases WHERE id = 'legacy-case'`,
        )
        .get(),
    ).toEqual({
      max_duration_ms: null,
      consumed_duration_ms: 0,
      max_total_tokens: null,
      consumed_total_tokens: 0,
    })
    sqlite
      .query(
        `INSERT INTO employee_case_metering_receipts
           (source_ref, case_id, round_id, duration_ms, total_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('task:execution-1', 'legacy-case', 'round-1', 120, 340, 1)
    expect(() =>
      sqlite
        .query(
          `INSERT INTO employee_case_metering_receipts
             (source_ref, case_id, round_id, duration_ms, total_tokens, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('task:execution-1', 'legacy-case', 'round-1', 120, 340, 2),
    ).toThrow()
    sqlite.close()
  })
})
