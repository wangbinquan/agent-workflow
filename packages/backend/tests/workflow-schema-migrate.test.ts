import { rimrafDir } from './helpers/cleanup'
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
import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
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
    // RFC-023 bumped the latest to 3; RFC-056 bumped again to 4. Intermediate
    // versions (v2, v3) are invisible to callers — the walk runs through them.
    expect(out.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
    expect(out.inputs).toEqual(v1.inputs)
    expect(out.nodes).toEqual(v1.nodes)
    expect(out.edges).toEqual(v1.edges)
  })

  test('latest → latest is idempotent (no upgrade, no surprise mutation)', () => {
    const latest: WorkflowDefinition = {
      $schema_version: WORKFLOW_SCHEMA_VERSION,
      inputs: [],
      nodes: [],
      edges: [],
    }
    const out = migrateDefinitionToLatest(latest)
    expect(out.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
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
    expect(out.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
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
    rimrafDir(tmp)
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
    expect(wf.definition.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
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

  // RFC-060 PR-E: the RFC-055 agent-multi shardingStrategy backfill was
  // removed alongside the agent-multi NodeKind. A legacy DB row that still
  // mentions `kind: 'agent-multi'` will now surface as an unknown-node-kind
  // validator failure at task-launch time (covered by the agent-multi-grep
  // guard test).
})

describe('POST / PUT paths normalize older versions → latest on write', () => {
  let tmp: string
  let db: DbClient

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-migrate-write-'))
    db = openDb({ path: join(tmp, 'db.sqlite'), migrationsFolder })
  })

  afterEach(() => {
    rimrafDir(tmp)
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
    expect(raw.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
  })

  test('updateWorkflow with v1 def patch → DB row stores latest version', async () => {
    // Seed a workflow at the latest version (createWorkflow normalizes either way).
    const created = await createWorkflow(db, {
      name: 'flow',
      description: '',
      definition: { $schema_version: WORKFLOW_SCHEMA_VERSION, inputs: [], nodes: [], edges: [] },
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
    expect(raw.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
    expect(raw.inputs).toEqual([{ kind: 'text', key: 'k', label: 'k' }])
  })
})
