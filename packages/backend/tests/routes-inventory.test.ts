// RFC-029 T6 — integration tests for
// GET /api/tasks/:taskId/node-runs/:nodeRunId/inventory.
// Locks: 200 captured / 200 uncaptured (NULL column) / 200 parse-failed
// (corrupt JSON) / 404 task / 404 node-run / 410 non-agent kind.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { InventorySnapshot, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function buildApp(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function req(app: Hono, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
}

interface SeedOpts {
  nodeKind?:
    | 'agent-single'
    | 'agent-multi'
    | 'input'
    | 'output'
    | 'wrapper-git'
    | 'review'
    | 'clarify'
  inventoryJson?: string | null
}

async function seed(
  db: DbClient,
  opts: SeedOpts = {},
): Promise<{ taskId: string; nodeRunId: string }> {
  const taskId = `task_${ulid()}`
  const workflowId = `wf_${taskId}`
  const nodeId = 'n1'
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      {
        id: nodeId,
        kind: opts.nodeKind ?? 'agent-single',
        agentName: 'coder',
      } as WorkflowNode,
    ],
    edges: [],
    outputs: [],
  }
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/test',
    worktreePath: '/tmp/test',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: 1000,
  })
  const nodeRunId = ulid()
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'done',
    promptText: 'go',
    startedAt: 1000,
    inventorySnapshotJson: opts.inventoryJson ?? null,
  })
  return { taskId, nodeRunId }
}

describe('GET /api/tasks/:id/node-runs/:nodeRunId/inventory', () => {
  beforeEach(() => {
    resetBroadcastersForTests()
  })
  afterEach(() => {
    resetBroadcastersForTests()
  })

  test('200 captured: persisted snapshot is returned verbatim through zod validation', async () => {
    const { db, app } = buildApp()
    const snapshot = {
      captured: true,
      schemaVersion: 1,
      capturedAt: 1700000000000,
      agents: [
        {
          name: 'coder',
          mode: 'primary',
          modelProviderId: 'anthropic',
          modelId: 'claude-opus-4-7',
          source: 'inline',
        },
      ],
      skills: [{ name: 'foo', source: 'managed', path: '/x', description: null }],
      mcps: [{ name: 'memcache', type: 'local', status: 'connected', hint: null }],
      plugins: [{ specifier: 'file:///a.mjs', source: 'inline' }],
    }
    const { taskId, nodeRunId } = await seed(db, { inventoryJson: JSON.stringify(snapshot) })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(true)
    if (body.captured) {
      expect(body.agents[0]?.name).toBe('coder')
      expect(body.mcps[0]?.status).toBe('connected')
    }
  })

  test('200 captured:false reason=file-missing when column is NULL (legacy row or pre-run-not-yet)', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { inventoryJson: null })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) expect(body.reason).toBe('file-missing')
  })

  test('200 captured:false reason=parse-failed when stored JSON is corrupt', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { inventoryJson: '{ broken json' })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) expect(body.reason).toBe('parse-failed')
  })

  test('404 when the task does not exist', async () => {
    const { db, app } = buildApp()
    const { nodeRunId } = await seed(db)
    const res = await req(app, `/api/tasks/no_such_task/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(404)
  })

  test('404 when node_run does not belong to the task', async () => {
    const { db, app } = buildApp()
    const { taskId } = await seed(db)
    const otherId = ulid()
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${otherId}/inventory`)
    expect(res.status).toBe(404)
  })

  test('410 for non-agent node kinds', async () => {
    const { db, app } = buildApp()
    for (const kind of ['wrapper-git', 'review', 'clarify', 'input', 'output'] as const) {
      const { taskId, nodeRunId } = await seed(db, { nodeKind: kind })
      const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
      expect(res.status).toBe(410)
    }
  })
})
