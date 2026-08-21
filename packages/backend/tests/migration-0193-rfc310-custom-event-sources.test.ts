import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { MIGRATIONS } from './migration-freeze'

describe('migration 0193 — global custom event sources', () => {
  test('adds stable definitions and immutable revision receipts without changing event runtime tables', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const tables = db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    )
    expect(tables.map((row) => row.name)).toContain('custom_event_source_definitions')
    expect(tables.map((row) => row.name)).toContain('custom_event_source_revisions')

    const definitionColumns = db.all<{ name: string; pk: number }>(
      sql`SELECT name, pk FROM pragma_table_info('custom_event_source_definitions')`,
    )
    expect(definitionColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', pk: 1 }),
        expect.objectContaining({ name: 'draft_json' }),
        expect.objectContaining({ name: 'published_revision' }),
        expect.objectContaining({ name: 'retired_at' }),
      ]),
    )

    const revisionColumns = db.all<{ name: string; pk: number }>(
      sql`SELECT name, pk FROM pragma_table_info('custom_event_source_revisions')`,
    )
    expect(revisionColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'source_id', pk: 1 }),
        expect.objectContaining({ name: 'revision', pk: 2 }),
        expect.objectContaining({ name: 'content_digest' }),
        expect.objectContaining({ name: 'validation_receipt_json' }),
      ]),
    )
  })
})
