import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { MIGRATIONS } from './migration-freeze'

describe('migration 0197 — source-neutral event response rules and bounded audit reads', () => {
  test('creates the rule ledger and indexes the large event/subscription audits', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const columns = db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('event_response_rules')`,
    )
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'id',
        'owner_user_id',
        'source_id',
        'event_type_id',
        'subject_match',
        'target_json',
        'last_status',
      ]),
    )

    const indexes = new Set(
      db
        .all<{ name: string }>(
          sql`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND name LIKE 'idx_event_%'
        `,
        )
        .map((row) => row.name),
    )
    expect(indexes.has('idx_event_response_rules_event')).toBe(true)
    expect(indexes.has('idx_event_response_rules_owner')).toBe(true)
    expect(indexes.has('idx_event_records_audit')).toBe(true)
    expect(indexes.has('idx_event_records_source_audit')).toBe(true)
    expect(indexes.has('idx_event_subscriptions_audit')).toBe(true)
    expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })
})
