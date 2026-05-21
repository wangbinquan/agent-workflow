// Locks in RFC-005 PR-A T4 + RFC-023 PR-A T6: workflow $schema_version
// transparent upgrade. As of RFC-023 the latest version is 3; v1 and v2 are
// both upgraded on read to v3.
//
// Contract:
//   - GET path: rowToWorkflow → migrateDefinitionToLatest. Old docs come back
//     as the latest version in-memory; the on-disk row is not modified until
//     the next PUT.
//   - POST / PUT paths: normalize via migrateDefinitionToLatest before
//     storing, so new writes always land at the latest version.
//   - Pure helper: idempotent (latest → latest is identity).
//
// If this goes red, check packages/backend/src/services/workflow.ts and
// packages/shared/src/schemas/workflow.ts in lock-step.

import type { Workflow, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { ulid } from 'ulid'
import {
  createWorkflow,
  getWorkflow,
  migrateDefinitionToLatest,
  updateWorkflow,
} from '../src/services/workflow'

const migrationsFolder = resolve(import.meta.dirname, '..', 'db', 'migrations')

describe('migrateDefinitionToLatest pure helper', () => {
  test('v1 walks up to the latest version, preserving shape', () => {
    const v1: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
      nodes: [{ id: 'in_1', kind: 'input', inputKey: 'topic' }],
      edges: [],
    }
    const out = migrateDefinitionToLatest(v1)
    // RFC-023: latest is 3. The intermediate (v2) is invisible to callers.
    expect(out.$schema_version).toBe(3)
    expect(out.inputs).toEqual(v1.inputs)
    expect(out.nodes).toEqual(v1.nodes)
    expect(out.edges).toEqual(v1.edges)
  })

  test('latest → latest is idempotent (no upgrade, no surprise mutation)', () => {
    const latest: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [],
      nodes: [],
      edges: [],
    }
    const out = migrateDefinitionToLatest(latest)
    expect(out.$schema_version).toBe(3)
    expect(out.inputs).toEqual(latest.inputs)
    expect(out.nodes).toEqual(latest.nodes)
    expect(out.edges).toEqual(latest.edges)
  })

  test('v1 upgrade does not mutate input (returns a new object)', () => {
    const v1: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [],
      edges: [],
    }
    const out = migrateDefinitionToLatest(v1)
    expect(v1.$schema_version).toBe(1) // original untouched
    expect(out.$schema_version).toBe(3)
    expect(out).not.toBe(v1)
  })
})

describe('GET path: legacy row → latest definition returned by getWorkflow', () => {
  let tmp: string
  let db: DbClient

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-migrate-'))
    db = openDb({ path: join(tmp, 'db.sqlite'), migrationsFolder })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('legacy v1 row → getWorkflow returns latest-version definition', async () => {
    const id = ulid()
    const now = Date.now()
    // Insert raw v1 row (simulating a workflow stored before RFC-005 shipped).
    await db.insert(workflows).values({
      id,
      name: 'legacy',
      description: '',
      definition: JSON.stringify({
        $schema_version: 1,
        inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
        nodes: [{ id: 'in_1', kind: 'input', inputKey: 'topic' }],
        edges: [],
      }),
      version: 1,
      createdAt: now,
      updatedAt: now,
    })

    const got = await getWorkflow(db, id)
    expect(got).not.toBeNull()
    const wf = got as Workflow
    expect(wf.definition.$schema_version).toBe(3)
    // Shape otherwise unchanged.
    expect(wf.definition.inputs).toHaveLength(1)
    expect(wf.definition.nodes).toHaveLength(1)
    expect(wf.definition.nodes[0]?.id).toBe('in_1')
  })

  test('on-disk row stays at v1 until next PUT (heal-on-edit pattern)', async () => {
    const id = ulid()
    const now = Date.now()
    await db.insert(workflows).values({
      id,
      name: 'legacy',
      description: '',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    // GET should not modify the DB row.
    await getWorkflow(db, id)
    const rows = await db.select().from(workflows).where(eq(workflows.id, id))
    const raw = JSON.parse(rows[0]!.definition) as { $schema_version: number }
    expect(raw.$schema_version).toBe(1)
  })

  // RFC-055 — getWorkflow returns agent-multi nodes with shardingStrategy
  // backfilled to per-file when the stored row omits the field, so the
  // inspector form never starts on an empty Select. The on-disk row stays
  // unmodified (heal-on-next-PUT, same pattern as the schema upgrade above).
  test('legacy agent-multi node without shardingStrategy → GET fills per-file (RFC-055)', async () => {
    const id = ulid()
    const now = Date.now()
    await db.insert(workflows).values({
      id,
      name: 'legacy',
      description: '',
      definition: JSON.stringify({
        $schema_version: 3,
        inputs: [],
        nodes: [
          { id: 'wg', kind: 'wrapper-git', nodeIds: ['x'] },
          { id: 'x', kind: 'input', inputKey: 'topic' },
          {
            id: 'm1',
            kind: 'agent-multi',
            agentName: 'auditor',
            sourcePort: { nodeId: 'wg', portName: 'git_diff' },
            // shardingStrategy intentionally omitted
          },
          { id: 's1', kind: 'agent-single', agentName: 'reviewer' },
        ],
        edges: [],
      }),
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    const wf = (await getWorkflow(db, id)) as Workflow
    const m1 = wf.definition.nodes.find((n) => n.id === 'm1') as Record<string, unknown>
    expect(m1.shardingStrategy).toEqual({ kind: 'per-file' })
    // Non-agent-multi nodes are untouched.
    const s1 = wf.definition.nodes.find((n) => n.id === 's1') as Record<string, unknown>
    expect(s1.shardingStrategy).toBeUndefined()
    // On-disk row still lacks the field — heal-on-edit pattern.
    const rows = await db.select().from(workflows).where(eq(workflows.id, id))
    const raw = JSON.parse(rows[0]!.definition) as {
      nodes: Array<Record<string, unknown>>
    }
    const rawM1 = raw.nodes.find((n) => n.id === 'm1') as Record<string, unknown>
    expect(rawM1.shardingStrategy).toBeUndefined()
  })
})

describe('POST / PUT paths normalize older versions → latest on write', () => {
  let tmp: string
  let db: DbClient

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-migrate-write-'))
    db = openDb({ path: join(tmp, 'db.sqlite'), migrationsFolder })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('createWorkflow with v1 def → DB row stores latest version', async () => {
    const created = await createWorkflow(db, {
      name: 'new-flow',
      description: '',
      definition: {
        $schema_version: 1,
        inputs: [],
        nodes: [],
        edges: [],
      },
    })
    // Returned via getWorkflow which always upgrades, so we read the raw row
    // directly to confirm the on-disk shape lands at the latest version.
    const rows = await db.select().from(workflows).where(eq(workflows.id, created.id))
    const raw = JSON.parse(rows[0]!.definition) as { $schema_version: number }
    expect(raw.$schema_version).toBe(3)
  })

  test('updateWorkflow with v1 def patch → DB row stores latest version', async () => {
    // Seed a workflow at the latest version (createWorkflow normalizes either way).
    const created = await createWorkflow(db, {
      name: 'flow',
      description: '',
      definition: { $schema_version: 3, inputs: [], nodes: [], edges: [] },
    })

    // PUT with a v1 patch — could happen from an older client.
    await updateWorkflow(db, created.id, {
      definition: {
        $schema_version: 1,
        inputs: [{ kind: 'text', key: 'k', label: 'k' }],
        nodes: [],
        edges: [],
      },
    })

    const rows = await db.select().from(workflows).where(eq(workflows.id, created.id))
    const raw = JSON.parse(rows[0]!.definition) as {
      $schema_version: number
      inputs: Array<{ kind: string; key: string; label: string }>
    }
    expect(raw.$schema_version).toBe(3)
    expect(raw.inputs).toEqual([{ kind: 'text', key: 'k', label: 'k' }])
  })
})
