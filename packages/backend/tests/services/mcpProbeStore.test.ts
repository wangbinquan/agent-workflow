// RFC-030 T5 — persistence layer tests for mcp_probes.

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../../src/db/client'
import { mcps } from '../../src/db/schema'
import { composeSqliteMcpProbeStore } from '../../src/modules/resource-catalog/composition/mcpProbeStore'
import type { McpProbeStore } from '../../src/modules/resource-catalog/public/participants'
import type { ProbeResult } from '../../src/services/mcpProbe'
import { getProbeByMcpId, listProbes, upsertProbe } from '../../src/services/mcpProbeStore'

const MIGRATIONS = resolve(import.meta.dir, '..', '..', 'db', 'migrations')

function seedMcp(db: DbClient, name: string): string {
  const id = ulid()
  db.insert(mcps)
    .values({ id, name, type: 'local', config: JSON.stringify({ command: ['true'] }) })
    .run()
  return id
}

function okResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  const now = Date.now()
  return {
    status: 'ok',
    latencyMs: 1234,
    handshakeMs: 100,
    serverInfo: { name: 'fake', version: '1.0' },
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    tools: [{ name: 't1' }],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    startedAt: now,
    finishedAt: now + 1234,
    ...overrides,
  }
}

describe('mcpProbeStore', () => {
  let db: DbClient
  let store: McpProbeStore
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    store = composeSqliteMcpProbeStore(db)
  })

  test('getProbeByMcpId returns null when never probed', async () => {
    const id = seedMcp(db, 'pg')
    expect(await getProbeByMcpId(store, id)).toBeNull()
  })

  test('upsert inserts first time; getProbeByMcpId round-trips full shape', async () => {
    const id = seedMcp(db, 'pg')
    const inserted = await upsertProbe(store, id, 'pg', okResult())
    expect(inserted.status).toBe('ok')
    expect(inserted.tools).toEqual([{ name: 't1' }])
    expect(inserted.mcpName).toBe('pg')

    const fetched = await getProbeByMcpId(store, id)
    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(inserted.id)
  })

  test('upsert is idempotent — second call overwrites without throwing', async () => {
    const id = seedMcp(db, 'pg')
    const first = await upsertProbe(store, id, 'pg', okResult({ latencyMs: 100 }))
    const second = await upsertProbe(store, id, 'pg', okResult({ latencyMs: 9999 }))
    // Same row identity (UNIQUE(mcp_id) implies row id is reused via update).
    expect(second.id).toBe(first.id)
    expect(second.latencyMs).toBe(9999)
  })

  test('listProbes returns rows sorted by mcpName', async () => {
    const idB = seedMcp(db, 'beta')
    const idA = seedMcp(db, 'alpha')
    await upsertProbe(store, idB, 'beta', okResult())
    await upsertProbe(store, idA, 'alpha', okResult())
    const all = await listProbes(store)
    expect(all.map((p) => p.mcpName)).toEqual(['alpha', 'beta'])
  })

  test('listProbes is empty when no probes exist', async () => {
    seedMcp(db, 'pg') // no probe row
    expect(await listProbes(store)).toEqual([])
  })

  test('upsert with unknown mcpId throws ValidationError', async () => {
    await expect(upsertProbe(store, 'm_does_not_exist', 'ghost', okResult())).rejects.toThrow(
      /not found/,
    )
  })

  test('error-shape probe persists with null lists + errorCode + errorDetail', async () => {
    const id = seedMcp(db, 'broken')
    const errResult: ProbeResult = {
      status: 'error',
      latencyMs: 30_010,
      handshakeMs: null,
      serverInfo: null,
      protocolVersion: null,
      capabilities: null,
      tools: null,
      resources: null,
      resourceTemplates: null,
      prompts: null,
      errorCode: 'connect-failed',
      errorMessage: 'spawn uvx ENOENT',
      errorDetail: { stderr: 'uvx: command not found' },
      startedAt: 1,
      finishedAt: 2,
    }
    const r = await upsertProbe(store, id, 'broken', errResult)
    expect(r.status).toBe('error')
    expect(r.errorCode).toBe('connect-failed')
    expect(r.tools).toBeNull()
    expect((r.errorDetail as { stderr: string }).stderr).toBe('uvx: command not found')
  })
})
