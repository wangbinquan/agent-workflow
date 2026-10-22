// RFC-028 T2 — locks migration 0011: introduces `mcps` table and adds
// `agents.mcp` column (default '[]').
//
// Legacy agent rows inserted BEFORE this migration come back with mcp == '[]'
// (the column default), so AgentSchema validates them and downstream readers
// (services/runner.ts buildInlineConfig) treat them as "no MCPs declared".
//
// If this test fails, RFC-028's "DB stores agent MCP names" + "mcps table
// exists" assumptions (proposal §5, design §2) are broken.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows, rawExec } from '@/platform/persistence/queryHelpers'
import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0011 (RFC-028 mcps + agents.mcp)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('mcps table exists with unique name + sensible defaults', () => {
    const id = ulid()
    const { mcps } = tablesOf(db)
    insertOne(db, mcps, {
      id,
      name: 'postgres-prod',
      description: 'prod read replica',
      type: 'local',
      config: JSON.stringify({ command: ['uvx', 'postgres-mcp'] }),
    })

    const rows = queryRows(db.select().from(mcps))
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.id).toBe(id)
    expect(r.name).toBe('postgres-prod')
    expect(r.type).toBe('local')
    expect(JSON.parse(r.config)).toEqual({ command: ['uvx', 'postgres-mcp'] })
    expect(r.enabled).toBe(true)
    expect(r.schemaVersion).toBe(1)
    expect(r.createdAt).toBeGreaterThan(0)
    expect(r.updatedAt).toBeGreaterThan(0)
  })

  test('mcps.name UNIQUE constraint rejects duplicates', () => {
    const { mcps } = tablesOf(db)
    insertOne(db, mcps, { id: ulid(), name: 'shared', type: 'local', config: '{}' })
    expect(() => {
      return insertOne(db, mcps, { id: ulid(), name: 'shared', type: 'remote', config: '{}' })
    }).toThrow()
  })

  test('mcps accepts type=remote', () => {
    const { mcps } = tablesOf(db)
    insertOne(db, mcps, {
      id: ulid(),
      name: 'sentry',
      type: 'remote',
      config: JSON.stringify({ url: 'https://sentry.io/mcp' }),
    })
    const rows = queryRows(db.select().from(mcps))
    expect(rows[0]!.type).toBe('remote')
  })

  test('agents.mcp column defaults to "[]" when row inserted without value', () => {
    // Insert a row using raw SQL so we *don't* pass mcp — proves the column
    // default kicks in for migrations on top of pre-RFC-028 data.
    rawExec(db, sql`INSERT INTO agents (id, name) VALUES ('a1', 'legacy')`)

    const { agents } = tablesOf(db)
    const rows = queryRows(db.select().from(agents))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.mcp).toBe('[]')
    expect(JSON.parse(rows[0]!.mcp)).toEqual([])
  })

  test('agents.mcp stores JSON string[]', () => {
    const { agents } = tablesOf(db)
    insertOne(db, agents, {
      id: ulid(),
      name: 'auditor',
      mcp: JSON.stringify(['postgres-prod', 'sentry']),
    })

    const rows = queryRows(db.select().from(agents))
    expect(JSON.parse(rows[0]!.mcp)).toEqual(['postgres-prod', 'sentry'])
  })
})
