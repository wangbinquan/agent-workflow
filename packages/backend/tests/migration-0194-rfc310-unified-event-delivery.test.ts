import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { MIGRATIONS } from './migration-freeze'

describe('migration 0194 — unified multicast event delivery', () => {
  test('stores generic event launch provenance and removes transport priority', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskColumns = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('tasks')`)
    expect(taskColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['event_subscription_id', 'event_delivery_id']),
    )

    const deliveryColumns = db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('event_deliveries')`,
    )
    const deliveryNames = deliveryColumns.map((column) => column.name)
    expect(deliveryNames).not.toContain('priority')
    expect(deliveryNames).toEqual(
      expect.arrayContaining([
        'attempt_count',
        'next_attempt_at',
        'claimed_by',
        'claim_expires_at',
        'last_error',
        'dead_letter_at',
      ]),
    )
    expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })

  test('allows one event to fan out but forbids duplicate delivery per subscription', () => {
    const db = createInMemoryDb(MIGRATIONS)
    db.run(sql`
      INSERT INTO event_sources (
        source_id, revision, descriptor_json, descriptor_digest, state, registered_at
      ) VALUES ('source', 1, '{}', 'digest', 'published', 1)
    `)
    db.run(sql`
      INSERT INTO event_type_catalog (
        event_type_id, revision, source_id, source_revision,
        descriptor_json, descriptor_digest, state, registered_at
      ) VALUES ('event.type', 1, 'source', 1, '{}', 'digest', 'published', 1)
    `)
    for (const subscriptionId of ['subscription-a', 'subscription-b']) {
      db.run(sql`
        INSERT INTO event_subscriptions (
          id, event_type_id, event_type_revision, source_id, source_revision,
          subject_type, subject_ref, subscriber_kind, subscriber_ref,
          mode, state, created_at, updated_at
        ) VALUES (
          ${subscriptionId}, 'event.type', 1, 'source', 1,
          'subject', 'subject-1', 'system', ${subscriptionId},
          'exact', 'active', 1, 1
        )
      `)
    }
    db.run(sql`
      INSERT INTO event_records (
        id, event_type_id, event_type_revision, source_id, source_revision,
        subject_type, subject_ref, occurred_at, observed_at, dedupe_key, summary_json
      ) VALUES (
        'event-1', 'event.type', 1, 'source', 1,
        'subject', 'subject-1', 1, 1, 'dedupe-1', '{"summary":"event"}'
      )
    `)
    for (const [deliveryId, subscriptionId] of [
      ['delivery-a', 'subscription-a'],
      ['delivery-b', 'subscription-b'],
    ] as const) {
      db.run(sql`
        INSERT INTO event_deliveries (
          id, event_id, subscription_id, subscriber_kind, subscriber_ref,
          delivery_class, state, attempt_count, next_attempt_at, created_at
        ) VALUES (
          ${deliveryId}, 'event-1', ${subscriptionId}, 'system', ${subscriptionId},
          'test', 'pending', 0, 1, 1
        )
      `)
    }

    expect(
      db.all<{ subscriptionId: string }>(
        sql`SELECT subscription_id AS subscriptionId FROM event_deliveries ORDER BY subscription_id`,
      ),
    ).toEqual([{ subscriptionId: 'subscription-a' }, { subscriptionId: 'subscription-b' }])
    expect(() =>
      db.run(sql`
        INSERT INTO event_deliveries (
          id, event_id, subscription_id, subscriber_kind, subscriber_ref,
          delivery_class, state, attempt_count, next_attempt_at, created_at
        ) VALUES (
          'delivery-duplicate', 'event-1', 'subscription-a', 'system', 'subscription-a',
          'test', 'pending', 0, 1, 1
        )
      `),
    ).toThrow()
  })
})
