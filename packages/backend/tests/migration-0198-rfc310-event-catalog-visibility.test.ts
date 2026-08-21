import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'

import { createInMemoryDb, openDb } from '@/db/client'
import { freezeAt, MIGRATIONS } from './migration-freeze'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('migration 0198 — public and compatibility event catalog separation', () => {
  test('persists catalog visibility and indexes public audit reads', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const columns = db.all<{ name: string }>(
      sql`SELECT name FROM pragma_table_info('event_type_catalog')`,
    )
    expect(columns.map((column) => column.name)).toContain('catalog_visibility')

    const indexes = new Set(
      db
        .all<{ name: string }>(
          sql`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'event_type_catalog'
        `,
        )
        .map((row) => row.name),
    )
    expect(indexes.has('idx_event_type_catalog_visibility')).toBe(true)
    expect(db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
  })

  test('hides legacy pseudo-events and moves active MR attention to the unified source', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc310-event-visibility-upgrade-'))
    roots.push(root)
    const path = join(root, 'db.sqlite')
    const beforeMigrations = freezeAt(196)
    roots.push(beforeMigrations)
    const before = openDb({ path, migrationsFolder: beforeMigrations })
    for (const eventTypeId of [
      'development.work-received',
      'development.review-updated',
      'development.pipeline-updated',
      'development.conflict-updated',
      'development.lifecycle-updated',
      'development.employee-result',
      'development.approval-updated',
    ]) {
      before.run(sql`
        INSERT INTO event_type_catalog (
          event_type_id, revision, source_id, source_revision,
          descriptor_json, descriptor_digest, state, registered_at
        ) VALUES (
          ${eventTypeId}, 1, 'development.code-host-state', 1,
          '{}', 'legacy-digest', 'published', 1
        )
      `)
    }
    before.run(sql`
      INSERT INTO event_subscriptions (
        id, event_type_id, event_type_revision, source_id, source_revision,
        subject_type, subject_ref, subscriber_kind, subscriber_ref,
        active_identity_key, state, created_at, updated_at
      ) VALUES (
        'legacy-pipeline-subscription', 'development.pipeline-updated', 1,
        'development.code-host-state', 1, 'merge-request', 'repo!42',
        'employee-case', 'case-1', 'legacy-identity', 'active', 1, 1
      )
    `)
    before.run(sql`
      INSERT INTO observer_activations (
        source_id, source_revision, subscriber_count, state, generation,
        wake_epoch, lease_epoch, next_scan_at, updated_at
      ) VALUES ('development.code-host-state', 1, 1, 'active', 3, 0, 0, 5000, 1)
    `)
    ;(before as unknown as { $client: { close(): void } }).$client.close()

    const after = openDb({ path, migrationsFolder: MIGRATIONS })
    expect(
      after.all<{ eventTypeId: string; visibility: string }>(sql`
        SELECT event_type_id AS eventTypeId, catalog_visibility AS visibility
        FROM event_type_catalog
        ORDER BY event_type_id
      `),
    ).toEqual(
      expect.arrayContaining([
        { eventTypeId: 'development.work-received', visibility: 'internal' },
        { eventTypeId: 'development.review-updated', visibility: 'internal' },
        { eventTypeId: 'development.pipeline-updated', visibility: 'internal' },
      ]),
    )
    expect(
      after.all<{
        eventTypeId: string
        revision: number
        sourceId: string
      }>(sql`
        SELECT event_type_id AS eventTypeId, event_type_revision AS revision,
               source_id AS sourceId
        FROM event_subscriptions
        WHERE id = 'legacy-pipeline-subscription'
      `)[0],
    ).toEqual({
      eventTypeId: 'development.pipeline-check-due',
      revision: 1,
      sourceId: 'code-host.activity',
    })
    expect(
      after.all<{ sourceId: string; subscriberCount: number; nextScanAt: number }>(sql`
        SELECT source_id AS sourceId, subscriber_count AS subscriberCount,
               next_scan_at AS nextScanAt
        FROM observer_activations
      `)[0],
    ).toEqual({ sourceId: 'code-host.activity', subscriberCount: 1, nextScanAt: 0 })
    ;(after as unknown as { $client: { close(): void } }).$client.close()
  })
})
