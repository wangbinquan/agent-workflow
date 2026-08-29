import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { rmSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { freezeAt } from './migration-freeze'

describe('migration 0220 — RFC-341 committed delivery FK repair', () => {
  test('normalizes a legacy-rename upgrade and preserves its delivery receipts', () => {
    const throughFoundation = freezeAt(217)
    const throughTaskCutover = freezeAt(218)
    const throughRepair = freezeAt(219)
    const raw = new Database(':memory:')
    try {
      raw.exec('PRAGMA foreign_keys = ON')
      migrate(drizzle(raw), { migrationsFolder: throughFoundation })
      raw.exec(`
        INSERT INTO committed_events (
          id, event_group_id, event_group_ordinal, producer, family, event_type,
          schema_version, aggregate_kind, aggregate_id, aggregate_seq, operation_ref,
          occurred_at, payload_json, payload_digest, delivery_mode, producer_epoch, created_at
        ) VALUES (
          'event-341-fk', 'group-341-fk', 0, 'task-execution', 'task-lifecycle',
          'task.created.v1', 1, 'task', 'task-341-fk', 1, 'operation-341-fk',
          1, '{}', '${'a'.repeat(64)}', 'dispatchable', 1, 1
        );
        INSERT INTO committed_event_deliveries (
          event_id, consumer_id, delivery_class, next_attempt_at, created_at, updated_at
        ) VALUES ('event-341-fk', 'consumer-341-fk', 'critical', 1, 1, 1);
      `)

      // Production migrations disable FK enforcement outside Drizzle's one
      // transaction. Combined with a reopened Bun connection's legacy rename
      // mode, 0219 cannot rewrite the temporary parent reference.
      raw.exec('PRAGMA foreign_keys = OFF')
      raw.exec('PRAGMA legacy_alter_table = ON')
      migrate(drizzle(raw), { migrationsFolder: throughTaskCutover })
      expect(
        raw
          .query(
            "SELECT `table` AS target FROM pragma_foreign_key_list('committed_event_deliveries') WHERE `from` = 'event_id'",
          )
          .get(),
      ).toEqual({ target: '__rfc341_committed_events' })

      migrate(drizzle(raw), { migrationsFolder: throughRepair })
      raw.exec('PRAGMA foreign_keys = ON')
      expect(
        raw
          .query(
            "SELECT `table` AS target FROM pragma_foreign_key_list('committed_event_deliveries') WHERE `from` = 'event_id'",
          )
          .get(),
      ).toEqual({ target: 'committed_events' })
      expect(
        raw
          .query(
            "SELECT state FROM committed_event_deliveries WHERE event_id = 'event-341-fk' AND consumer_id = 'consumer-341-fk'",
          )
          .get(),
      ).toEqual({ state: 'pending' })
      expect(raw.query('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      raw.close()
      for (const path of [throughFoundation, throughTaskCutover, throughRepair]) {
        rmSync(path, { recursive: true, force: true })
      }
    }
  })
})
