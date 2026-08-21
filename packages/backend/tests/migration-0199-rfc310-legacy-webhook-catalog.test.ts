import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'

import { openDb } from '@/db/client'
import { freezeAt, MIGRATIONS } from './migration-freeze'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('migration 0199 — retire the duplicate legacy Webhook directory', () => {
  test('keeps immutable rows but exposes only the unified code-host source to new authoring', () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc310-legacy-webhook-catalog-'))
    roots.push(root)
    const path = join(root, 'db.sqlite')
    const beforeMigrations = freezeAt(197)
    roots.push(beforeMigrations)
    const before = openDb({ path, migrationsFolder: beforeMigrations })
    before.run(sql`
      INSERT INTO event_sources (
        source_id, revision, descriptor_json, descriptor_digest, state, registered_at
      ) VALUES ('code-host.webhook', 1, '{}', 'legacy-source', 'published', 1)
    `)
    before.run(sql`
      INSERT INTO event_type_catalog (
        event_type_id, revision, source_id, source_revision,
        descriptor_json, descriptor_digest, catalog_visibility, state, registered_at
      ) VALUES
        ('code-host.webhook.mr_opened', 1, 'code-host.webhook', 1,
         '{}', 'legacy-webhook-event', 'public', 'published', 1),
        ('platform.task.completed', 1, 'platform.task-lifecycle', 1,
         '{}', 'unrelated-public-event', 'public', 'published', 1)
    `)
    ;(before as unknown as { $client: { close(): void } }).$client.close()

    const after = openDb({ path, migrationsFolder: MIGRATIONS })
    expect(
      after.all<{ eventTypeId: string; visibility: string }>(sql`
        SELECT event_type_id AS eventTypeId, catalog_visibility AS visibility
        FROM event_type_catalog
        ORDER BY event_type_id
      `),
    ).toEqual([
      { eventTypeId: 'code-host.webhook.mr_opened', visibility: 'compatibility' },
      { eventTypeId: 'platform.task.completed', visibility: 'public' },
    ])
    expect(
      after.all<{ sourceId: string }>(sql`
        SELECT DISTINCT source_id AS sourceId
        FROM event_type_catalog
        WHERE state = 'published' AND catalog_visibility = 'public'
        ORDER BY source_id
      `),
    ).toEqual([{ sourceId: 'platform.task-lifecycle' }])
    expect(after.all(sql`PRAGMA foreign_key_check`)).toEqual([])
    ;(after as unknown as { $client: { close(): void } }).$client.close()
  })
})
