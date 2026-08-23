// User regression 2026-08-23: workflow-task details need a durable way back to
// their owning digital employee Case. The migration also repairs executions
// launched before the dedicated task-owned provenance column existed.

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION = resolve(
  import.meta.dir,
  '..',
  'db',
  'migrations',
  '0205_rfc310_task_employee_case_link.sql',
)

describe('migration 0205 — TaskEngine to digital employee Case provenance', () => {
  test('backfills real OS rounds and leaves unrelated legacy action runs unlinked', () => {
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        digital_employee_round_id TEXT
      );
      CREATE TABLE employee_reaction_rounds (
        id TEXT PRIMARY KEY NOT NULL,
        case_id TEXT NOT NULL
      );
      INSERT INTO employee_reaction_rounds (id, case_id) VALUES
        ('round-os-1', 'case-1'),
        ('round-os-2', 'case-2');
      INSERT INTO tasks (id, digital_employee_round_id) VALUES
        ('task-os-1', 'round-os-1'),
        ('task-os-2', 'round-os-2'),
        ('task-legacy-action', 'legacy-action-run'),
        ('task-plain', NULL);
    `)

    sqlite.exec(readFileSync(MIGRATION, 'utf8'))

    expect(
      sqlite.query('SELECT id, digital_employee_case_id AS caseId FROM tasks ORDER BY id').all(),
    ).toEqual([
      { id: 'task-legacy-action', caseId: null },
      { id: 'task-os-1', caseId: 'case-1' },
      { id: 'task-os-2', caseId: 'case-2' },
      { id: 'task-plain', caseId: null },
    ])

    sqlite
      .query("INSERT INTO tasks (id, digital_employee_round_id) VALUES ('task-future', NULL)")
      .run()
    expect(
      sqlite
        .query("SELECT digital_employee_case_id AS caseId FROM tasks WHERE id = 'task-future'")
        .get(),
    ).toEqual({ caseId: null })
    sqlite.close()
  })
})
