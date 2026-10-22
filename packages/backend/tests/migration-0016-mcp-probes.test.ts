// RFC-030 T2 — locks migration 0016: introduces `mcp_probes` table.
// Originally drafted as 0013; renumbered to 0016 to coexist with RFC-031
// (0014) and RFC-029 (0015) that landed on the same branch concurrently.
//
// Pins:
//   - table exists with the canonical columns + defaults
//   - UNIQUE(mcp_id) prevents two probe rows for the same MCP (UPSERT pattern)
//   - ON DELETE CASCADE drops the probe automatically when its parent mcp row
//     is deleted — so we never accumulate orphan probe rows after a user
//     deletes an MCP through /api/mcps/:name
//   - schema_version defaults to 1, created_at/updated_at populated by SQL default
//
// If this fails, RFC-030's "delete mcp cleans up probe" assumption (design
// §2.1) is broken — callers in services/mcp.ts deleteMcp would need an
// explicit DELETE FROM mcp_probes before dropping the parent row.

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryWrite, queryRows } from '@/platform/persistence/queryHelpers'
import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0013 (RFC-030 mcp_probes)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  function seedMcp(name = 'postgres-prod'): string {
    const id = ulid()
    const { mcps } = tablesOf(db)
    insertOne(db, mcps, {
      id,
      name,
      type: 'local',
      config: JSON.stringify({ command: ['true'] }),
    })
    return id
  }

  test('mcp_probes table accepts an ok probe with required + nullable fields', () => {
    const mcpId = seedMcp()
    const id = ulid()
    const now = Date.now()
    const { mcpProbes } = tablesOf(db)
    insertOne(db, mcpProbes, {
      id,
      mcpId,
      status: 'ok',
      latencyMs: 1832,
      handshakeMs: 412,
      serverInfoJson: JSON.stringify({ name: 'postgres-mcp', version: '1.2.0' }),
      protocolVersion: '2024-11-05',
      capabilitiesJson: JSON.stringify({ tools: { listChanged: true } }),
      toolsJson: JSON.stringify([{ name: 'query' }]),
      resourcesJson: JSON.stringify([]),
      resourceTemplatesJson: JSON.stringify([]),
      promptsJson: JSON.stringify([]),
      errorCode: null,
      errorMessage: null,
      errorDetailJson: null,
      startedAt: now,
      finishedAt: now + 1832,
    })

    const rows = queryRows(db.select().from(mcpProbes))
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.id).toBe(id)
    expect(r.mcpId).toBe(mcpId)
    expect(r.status).toBe('ok')
    expect(r.latencyMs).toBe(1832)
    expect(r.schemaVersion).toBe(1)
    expect(r.createdAt).toBeGreaterThan(0)
    expect(r.updatedAt).toBeGreaterThan(0)
  })

  test('mcp_probes.mcp_id is UNIQUE — second probe insert for same mcp rejected', () => {
    const mcpId = seedMcp()
    const { mcpProbes } = tablesOf(db)
    insertOne(db, mcpProbes, {
      id: ulid(),
      mcpId,
      status: 'ok',
      latencyMs: 100,
      startedAt: 1,
      finishedAt: 2,
    })

    expect(() => {
      return insertOne(db, mcpProbes, {
        id: ulid(),
        mcpId,
        status: 'error',
        latencyMs: 200,
        startedAt: 1,
        finishedAt: 2,
      })
    }).toThrow()
  })

  test('ON DELETE CASCADE: deleting parent mcp removes probe row', () => {
    const mcpId = seedMcp()
    const { mcpProbes, mcps } = tablesOf(db)
    insertOne(db, mcpProbes, {
      id: ulid(),
      mcpId,
      status: 'ok',
      latencyMs: 50,
      startedAt: 1,
      finishedAt: 2,
    })
    expect(queryRows(db.select().from(mcpProbes))).toHaveLength(1)

    queryWrite(db.delete(mcps).where(eq(mcps.id, mcpId)))

    expect(queryRows(db.select().from(mcpProbes))).toHaveLength(0)
  })

  test('error probe shape: all list columns nullable, errorCode + errorDetailJson populated', () => {
    const mcpId = seedMcp('broken')
    const { mcpProbes } = tablesOf(db)
    insertOne(db, mcpProbes, {
      id: ulid(),
      mcpId,
      status: 'error',
      latencyMs: 30_010,
      handshakeMs: null,
      serverInfoJson: null,
      toolsJson: null,
      resourcesJson: null,
      resourceTemplatesJson: null,
      promptsJson: null,
      errorCode: 'connect-failed',
      errorMessage: 'spawn uvx ENOENT',
      errorDetailJson: JSON.stringify({ stderr: 'uvx: command not found' }),
      startedAt: 1,
      finishedAt: 30_011,
    })
    const rows = queryRows(db.select().from(mcpProbes))
    expect(rows[0]!.errorCode).toBe('connect-failed')
    expect(rows[0]!.toolsJson).toBeNull()
    expect(JSON.parse(rows[0]!.errorDetailJson!)).toEqual({ stderr: 'uvx: command not found' })
  })
})
