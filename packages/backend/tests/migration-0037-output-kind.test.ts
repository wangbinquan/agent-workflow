// RFC-072 — migration 0037 adds node_run_outputs.kind.
//
// LOCKS: after the full migration sequence runs on a fresh DB, node_run_outputs
// has a `kind` TEXT column that is NULLABLE (legacy rows / ports with no
// declared kind stay NULL → the Outputs tab renders them as plain text with no
// download button). The primary key (node_run_id, port_name) is unchanged.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface ColumnInfo {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
}

describe('RFC-072 — migration 0037 node_run_outputs.kind', () => {
  test('kind column exists and is a nullable TEXT column', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await db.all(sql`PRAGMA table_info(node_run_outputs)`)) as ColumnInfo[]
    const kindCol = cols.find((c) => c.name === 'kind')
    expect(kindCol).toBeDefined()
    expect(kindCol?.type.toUpperCase()).toBe('TEXT')
    expect(kindCol?.notnull).toBe(0)
    expect(kindCol?.pk).toBe(0)
  })

  test('primary key remains (node_run_id, port_name); content stays NOT NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = (await db.all(sql`PRAGMA table_info(node_run_outputs)`)) as ColumnInfo[]
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name)
    expect(new Set(pkCols)).toEqual(new Set(['node_run_id', 'port_name']))
    expect(cols.find((c) => c.name === 'content')?.notnull).toBe(1)
  })
})
