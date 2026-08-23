// User regression 2026-08-23: digital employee Cases need their own durable
// task name instead of deriving the list/detail title from Context fields.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION = resolve(
  import.meta.dir,
  '..',
  'db',
  'migrations',
  '0206_rfc310_employee_case_name.sql',
)

describe('migration 0206 — durable digital employee Case task name', () => {
  test('backfills the previously displayed Context subject and keeps older writers migration-compatible', () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE employee_context_records (
        id TEXT PRIMARY KEY NOT NULL,
        state_json TEXT NOT NULL
      );
      CREATE TABLE employee_cases (
        id TEXT PRIMARY KEY NOT NULL,
        primary_context_id TEXT NOT NULL
      );
      INSERT INTO employee_context_records (id, state_json) VALUES
        ('context-subject', '{"subjectRef":"REQ-42"}'),
        ('context-title', '{"title":"Investigate checkout"}'),
        ('context-empty', '{}');
      INSERT INTO employee_cases (id, primary_context_id) VALUES
        ('case-subject', 'context-subject'),
        ('case-title', 'context-title'),
        ('case-fallback', 'context-empty');
    `)

    sqlite.exec(readFileSync(MIGRATION, 'utf8'))

    expect(sqlite.query('SELECT id, name FROM employee_cases ORDER BY id').all()).toEqual([
      { id: 'case-fallback', name: 'case-fallback' },
      { id: 'case-subject', name: 'REQ-42' },
      { id: 'case-title', name: 'Investigate checkout' },
    ])
    expect(() =>
      sqlite
        .query(
          "INSERT INTO employee_cases (id, primary_context_id) VALUES ('case-new', 'context-empty')",
        )
        .run(),
    ).not.toThrow()
    expect(sqlite.query("SELECT name FROM employee_cases WHERE id = 'case-new'").get()).toEqual({
      name: '',
    })
    sqlite.close()
  })
})
