// Service + HTTP coverage for Workflow CRUD (P-1-11).
// In-memory SQLite; CRUD round-trips and references checks only — full
// topology/port validation lands in P-2-01.

import type {
  DeleteWorkflow,
  UpdateWorkflow,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowDraftSnapshot,
} from '@agent-workflow/shared'
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  validateWorkflow,
} from '../src/services/workflow'
import { ConflictError, NotFoundError } from '../src/util/errors'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SYSTEM_PRINCIPAL = { kind: 'system', reason: 'workflow-service-test' } as const

function buildHarness(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

function sampleDefinition(): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [{ kind: 'text', key: 'requirement', label: '需求', required: true, multiline: true }],
    nodes: [
      { id: 'in_1', kind: 'input', inputKey: 'requirement' },
      {
        id: 'worker',
        kind: 'agent-single',
        agentId: 'agent-code-worker',
        agentName: 'code-worker',
      },
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'in_1', portName: 'out' },
        target: { nodeId: 'worker', portName: 'requirement' },
      },
    ],
  }
}

function saveInput(
  workflow: Pick<WorkflowDetail, 'version' | 'name' | 'description' | 'definition'>,
  patch: Partial<WorkflowDraftSnapshot> = {},
): UpdateWorkflow {
  return {
    expectedVersion: workflow.version,
    clientMutationId: ulid(),
    snapshot: {
      name: patch.name ?? workflow.name,
      description: patch.description ?? workflow.description,
      definition: patch.definition ?? workflow.definition,
    },
  }
}

function deleteInput(workflow: Pick<WorkflowDetail, 'version' | 'name'>): DeleteWorkflow {
  // RFC-222 (D5): the route requires confirm === the workflow name.
  return { expectedVersion: workflow.version, clientMutationId: ulid(), confirm: workflow.name }
}

describe('workflow service', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('list empty -> []', async () => {
    expect(await listWorkflows(db)).toEqual([])
  })

  test('create stores definition + sets version=1', async () => {
    const wf = await createWorkflow(db, {
      name: 'my workflow',
      description: 'desc',
      definition: sampleDefinition(),
    })
    expect(wf.id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/) // ULID
    expect(wf.name).toBe('my workflow')
    expect(wf.version).toBe(1)
    expect(wf.definition.nodes.length).toBe(2)
    expect(wf.definition.edges.length).toBe(1)
  })

  test('update bumps version + persists definition', async () => {
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: sampleDefinition(),
    })
    const after = await updateWorkflow(
      db,
      wf.id,
      saveInput(wf, {
        name: 'renamed',
        definition: { ...sampleDefinition(), nodes: [] },
      }),
      SYSTEM_PRINCIPAL,
    )
    expect(after.revision.version).toBe(2)
    expect(after.snapshot.name).toBe('renamed')
    expect(after.snapshot.definition.nodes.length).toBe(0)
  })

  test('update unknown id -> NotFoundError', async () => {
    await expect(
      updateWorkflow(
        db,
        '01HXXXXXXXXXXXXXXXXXXX',
        {
          expectedVersion: 1,
          clientMutationId: ulid(),
          snapshot: { name: 'x', description: '', definition: sampleDefinition() },
        },
        SYSTEM_PRINCIPAL,
      ),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  test('delete removes; unknown -> NotFoundError', async () => {
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: sampleDefinition(),
    })
    const input = deleteInput(wf)
    await deleteWorkflow(db, wf.id, input, SYSTEM_PRINCIPAL)
    expect(await getWorkflow(db, wf.id)).toBeNull()
    await expect(deleteWorkflow(db, wf.id, input, SYSTEM_PRINCIPAL)).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('delete refuses when ANY task references the workflow (running)', async () => {
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: sampleDefinition(),
    })
    await db.insert(tasks).values({
      name: 'fixture-task',

      id: ulid(),
      workflowId: wf.id,
      workflowSnapshot: JSON.stringify(wf.definition),
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/T',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await expect(
      deleteWorkflow(db, wf.id, deleteInput(wf), SYSTEM_PRINCIPAL),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('delete refuses when ANY task references the workflow (done)', async () => {
    // Per design Q&A round 18: any reference (regardless of status) blocks
    // deletion. Future relaxation tracked in STATE.md tech debt.
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: sampleDefinition(),
    })
    await db.insert(tasks).values({
      name: 'fixture-task',

      id: ulid(),
      workflowId: wf.id,
      workflowSnapshot: JSON.stringify(wf.definition),
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/T',
      status: 'done',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await expect(
      deleteWorkflow(db, wf.id, deleteInput(wf), SYSTEM_PRINCIPAL),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('validate on empty workflow definition returns ok', async () => {
    // Rule coverage lives in workflow-validator.test.ts; this test pins down
    // the service-level wiring (workflow lookup + ok-shape).
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
    })
    const result = await validateWorkflow(db, wf.id)
    expect(result).toEqual({ ok: true, issues: [] })
  })

  test('validate surfaces concrete issues when references do not resolve', async () => {
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: sampleDefinition(),
    })
    const result = await validateWorkflow(db, wf.id)
    expect(result.ok).toBe(false)
    const codes = result.issues.map((i) => i.code)
    // sampleDefinition references agent 'code-worker' (not seeded) and edges
    // an `out` port that doesn't exist on the input node.
    expect(codes).toContain('agent-not-found')
    expect(codes).toContain('edge-source-port-missing')
  })
})

describe('workflow HTTP routes', () => {
  let app: Hono

  beforeEach(() => {
    ;({ app } = buildHarness())
  })

  test('POST creates workflow + GET roundtrips', async () => {
    const post = await req(app, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'wf1',
        description: 'd',
        definition: sampleDefinition(),
      }),
    })
    expect(post.status).toBe(201)
    const created = (await post.json()) as { id: string; version: number }
    expect(created.version).toBe(1)

    const got = await req(app, `/api/workflows/${created.id}`)
    expect(got.status).toBe(200)
  })

  test('ordinary POST/PUT reject name-only agent selectors before persistence', async () => {
    const nameOnly = {
      ...sampleDefinition(),
      nodes: sampleDefinition().nodes.map((node) =>
        node.kind === 'agent-single'
          ? { id: node.id, kind: node.kind, agentName: 'code-worker' }
          : node,
      ),
    }
    const rejectedCreate = await req(app, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'name-only-create', description: '', definition: nameOnly }),
    })
    expect(rejectedCreate.status).toBe(422)
    expect(((await rejectedCreate.json()) as { code: string }).code).toBe(
      'workflow-agent-id-required',
    )

    const createdResponse = await req(app, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'canonical',
        description: '',
        definition: sampleDefinition(),
      }),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as WorkflowDetail
    const rejectedUpdate = await req(app, `/api/workflows/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify(saveInput(created, { definition: nameOnly })),
    })
    expect(rejectedUpdate.status).toBe(422)
    expect(((await rejectedUpdate.json()) as { code: string }).code).toBe(
      'workflow-agent-id-required',
    )
  })

  test('invalid payload returns 422 with workflow-invalid code', async () => {
    const res = await req(app, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: '', description: '', definition: sampleDefinition() }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('workflow-invalid')
  })

  test('missing $schema_version in definition rejected', async () => {
    const res = await req(app, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'wf',
        description: '',
        definition: { nodes: [], edges: [], inputs: [] },
      }),
    })
    expect(res.status).toBe(422)
  })

  test('PUT updates fields and increments version', async () => {
    const created = (await (
      await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: 'wf',
          description: '',
          definition: sampleDefinition(),
        }),
      })
    ).json()) as WorkflowDetail

    const put = await req(app, `/api/workflows/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify(saveInput(created, { name: 'renamed' })),
    })
    expect(put.status).toBe(200)
    const after = (await put.json()) as {
      snapshot: { name: string }
      revision: { version: number }
    }
    expect(after.snapshot.name).toBe('renamed')
    expect(after.revision.version).toBe(2)
  })

  // 2026-07-10 naming unification: workflow names follow the workgroup slug
  // rules (WORKFLOW_NAME_RE alias). CREATE is guarded by the strict schema;
  // PUT validates ONLY a changed name, so stored legacy free-form names keep
  // auto-saving (grandfather decision — 放行存量，只卡新名).
  test('POST with a free-form name → 422 workflow-invalid (strict create schema)', async () => {
    const res = await req(app, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'My Workflow',
        description: '',
        definition: sampleDefinition(),
      }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('workflow-invalid')
  })

  test('PUT: unchanged legacy name saves; rename validates against the slug rules', async () => {
    const { db: hdb, app: happ } = buildHarness()
    // Route-create with a valid slug, then service-rename to a legacy
    // free-form value — simulates a row stored before the unification.
    const post = await req(happ, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'legacy-seed',
        description: '',
        definition: sampleDefinition(),
      }),
    })
    const created = (await post.json()) as WorkflowDetail
    // Simulate a row written before the slug rule existed. The current save
    // service correctly refuses to mint a new invalid name, so this fixture
    // must bypass it just like a historical migration state would.
    await hdb
      .update(workflows)
      .set({ name: 'Legacy Name With Spaces' })
      .where(eq(workflows.id, created.id))
    const legacy = await getWorkflow(hdb, created.id)
    if (legacy === null) throw new Error('legacy workflow disappeared')

    // Auto-save shape: echoes the stored legacy name → must keep working.
    const same = await req(happ, `/api/workflows/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify(saveInput(legacy, { description: 'touched' })),
    })
    expect(same.status).toBe(200)
    const current = await getWorkflow(hdb, created.id)
    if (current === null) throw new Error('workflow disappeared after save')

    // An actual rename must satisfy the unified rules.
    const bad = await req(happ, `/api/workflows/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify(saveInput(current, { name: 'Still Bad Name' })),
    })
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as { code: string }).code).toBe('workflow-name-invalid')

    const good = await req(happ, `/api/workflows/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify(saveInput(current, { name: 'legacy-renamed' })),
    })
    expect(good.status).toBe(200)
    expect(((await good.json()) as { snapshot: { name: string } }).snapshot.name).toBe(
      'legacy-renamed',
    )
  })

  test('GET unknown id returns 404 with workflow-not-found', async () => {
    const res = await req(app, '/api/workflows/01HFAKEFAKEFAKEFAKEFAKE')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('workflow-not-found')
  })

  test('DELETE 204; double DELETE 404', async () => {
    const created = (await (
      await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: 'wf',
          description: '',
          definition: sampleDefinition(),
        }),
      })
    ).json()) as WorkflowDetail
    const body = JSON.stringify(deleteInput(created))
    const del = await req(app, `/api/workflows/${created.id}`, { method: 'DELETE', body })
    expect(del.status).toBe(204)
    const again = await req(app, `/api/workflows/${created.id}`, { method: 'DELETE', body })
    expect(again.status).toBe(404)
  })

  test('PUT and DELETE reject missing revision fences', async () => {
    const created = (await (
      await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: 'fenced-workflow',
          description: '',
          definition: sampleDefinition(),
        }),
      })
    ).json()) as WorkflowDetail

    expect(
      (
        await req(app, `/api/workflows/${created.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: 'partial-patch' }),
        })
      ).status,
    ).toBe(422)
    expect((await req(app, `/api/workflows/${created.id}`, { method: 'DELETE' })).status).toBe(422)
  })

  test('POST /:id/validate returns ok for an empty workflow', async () => {
    const created = (await (
      await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: 'wf',
          description: '',
          definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
        }),
      })
    ).json()) as WorkflowDetail
    const res = await req(app, `/api/workflows/${created.id}/validate`, {
      method: 'POST',
      body: JSON.stringify({
        expectedVersion: created.version,
        expectedSnapshotHash: created.snapshotHash,
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      revision: {
        workflowId: created.id,
        version: created.version,
        snapshotHash: created.snapshotHash,
      },
      ok: true,
      issues: [],
    })
  })

  test('all /api/workflows/* require token', async () => {
    expect((await app.request('/api/workflows')).status).toBe(401)
  })
})
