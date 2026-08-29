import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { freezeAt } from './migration-freeze'

describe('migration 0218 — RFC-341 committed-event ledger', () => {
  test('adds immutable event, ordered aggregate, delivery and cutover tables', () => {
    const db = createInMemoryDb(freezeAt(217))
    const tables = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'committed_event_aggregate_heads',
        'committed_events',
        'committed_event_deliveries',
        'committed_event_family_cutovers',
      ]),
    )
    expect(
      db.all<{ producer: string; family: string; mode: string; epoch: number }>(sql`
        SELECT producer, family, mode, epoch
        FROM committed_event_family_cutovers
        ORDER BY producer, family
      `),
    ).toEqual([
      { producer: 'collaboration', family: 'clarify', mode: 'legacy', epoch: 1 },
      { producer: 'collaboration', family: 'questions', mode: 'legacy', epoch: 1 },
      { producer: 'collaboration', family: 'review', mode: 'legacy', epoch: 1 },
      { producer: 'task-execution', family: 'task-lifecycle', mode: 'legacy', epoch: 1 },
    ])
    const eventIndexes = db.all<{ name: string; unique: number }>(
      sql`SELECT name, "unique" FROM pragma_index_list('committed_events')`,
    )
    expect(eventIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'committed_events_aggregate_seq_unique', unique: 1 }),
        expect.objectContaining({ name: 'committed_events_group_ordinal_unique', unique: 1 }),
      ]),
    )
    expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })
})
