import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { freezeAt } from './migration-freeze'

describe('migration 0195 — WorkStart and owner lifecycle event outboxes', () => {
  test('adds durable task and employee event provenance without a shared consumed flag', () => {
    const db = createInMemoryDb(freezeAt(194))
    const tables = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining(['task_lifecycle_event_outbox', 'employee_case_event_origins']),
    )

    const taskColumns = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('tasks')`)
    expect(taskColumns.map((column) => column.name)).toContain('lifecycle_event_revision')

    const fireColumns = db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('webhook_trigger_fires')`,
    )
    expect(fireColumns.map((column) => column.name)).toContain('employee_case_id')

    const outboxColumns = db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('task_lifecycle_event_outbox')`,
    )
    expect(outboxColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'task_id',
        'task_revision',
        'observation_json',
        'state',
        'attempt_count',
        'next_attempt_at',
        'claimed_by',
        'claim_expires_at',
        'last_error',
        'completed_at',
        'dead_letter_at',
      ]),
    )
    expect(outboxColumns.map((column) => column.name)).not.toContain('consumed')

    const originIndexes = db.all<{ name: string; unique: number }>(
      sql`SELECT name, "unique" FROM pragma_index_list('employee_case_event_origins')`,
    )
    expect(originIndexes).toContainEqual(
      expect.objectContaining({ name: 'employee_case_event_origins_delivery_unique', unique: 1 }),
    )
    expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })
})
