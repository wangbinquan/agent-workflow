// RFC-061 follow-up: rewritten on top of the projection.
// GET /api/tasks/:taskId/node-runs/:nodeRunId/inventory now resolves
// (logical_run.id → latest attempt → <appHome>/runs/<taskId>/<attemptId>/
// inventory.json) instead of reading from the removed
// node_runs.inventory_snapshot_json column. The seed helper writes the
// file to disk so the readSnapshotFromRunDir path is exercised end-to-
// end. Behaviour locks preserved: 200 captured / 200 file-missing /
// 200 parse-failed / 404 task / 404 node-run / 410 non-agent kind.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { logicalRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { writeEvent } from '../src/services/writeEvents'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { InventorySnapshot, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  appHome: string
  cleanup: () => void
}

function buildApp(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-inv-'))
  const prevHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  return {
    db,
    app,
    appHome,
    cleanup: () => {
      rmSync(appHome, { recursive: true, force: true })
      if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prevHome
    },
  }
}

async function req(app: Hono, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
}

interface SeedOpts {
  nodeKind?: 'agent-single' | 'input' | 'output' | 'wrapper-git' | 'review' | 'clarify'
  /** Body to write into `<appHome>/runs/<taskId>/<attemptId>/inventory.json`. */
  inventoryBody?: string | null
  /** Skip seeding any attempt for this logical_run. */
  noAttempt?: boolean
}

async function seed(
  h: Harness,
  opts: SeedOpts = {},
): Promise<{ taskId: string; nodeRunId: string; attemptId: string | null }> {
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
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await h.db.insert(tasks).values({
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
  const scope = { nodeId, loopIter: 0, shardKey: '', iter: 0 } as const
  const lrEvt = await writeEvent(h.db, {
    taskId,
    kind: 'logical-run-created',
    payload: {},
    actor: 'system',
    ...scope,
  })
  const nodeRunId = lrEvt.id
  let attemptId: string | null = null
  if (!opts.noAttempt) {
    attemptId = `att_${ulid()}`
    await writeEvent(h.db, {
      taskId,
      kind: 'attempt-started',
      payload: {},
      actor: 'system',
      ...scope,
      attemptId,
    })
    if (opts.inventoryBody !== undefined && opts.inventoryBody !== null) {
      const runDir = join(h.appHome, 'runs', taskId, attemptId)
      mkdirSync(runDir, { recursive: true })
      writeFileSync(join(runDir, 'inventory.json'), opts.inventoryBody)
    }
  }
  return { taskId, nodeRunId, attemptId }
}

describe('GET /api/tasks/:id/node-runs/:nodeRunId/inventory', () => {
  let h: Harness
  beforeEach(() => {
    resetBroadcastersForTests()
    h = buildApp()
  })
  afterEach(() => {
    resetBroadcastersForTests()
    h.cleanup()
  })

  test('200 captured: persisted snapshot is returned verbatim through zod validation', async () => {
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
          readonly: false,
          source: 'inline',
        },
      ],
      skills: [{ name: 'foo', source: 'managed', path: '/x', description: null }],
      mcps: [{ name: 'memcache', type: 'local', status: 'connected', hint: null }],
      plugins: [{ specifier: 'file:///a.mjs', source: 'inline' }],
    }
    const { taskId, nodeRunId } = await seed(h, { inventoryBody: JSON.stringify(snapshot) })
    const res = await req(h.app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(true)
    if (body.captured) {
      expect(body.agents[0]?.name).toBe('coder')
      expect(body.mcps[0]?.status).toBe('connected')
    }
  })

  test('200 captured:false reason=file-missing when no attempt has been spawned yet', async () => {
    const { taskId, nodeRunId } = await seed(h, { noAttempt: true })
    const res = await req(h.app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) expect(body.reason).toBe('file-missing')
  })

  test('200 captured:false reason=parse-failed when the on-disk JSON is corrupt', async () => {
    const { taskId, nodeRunId } = await seed(h, { inventoryBody: '{ broken json' })
    const res = await req(h.app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) expect(body.reason).toBe('parse-failed')
  })

  test('404 when the task does not exist', async () => {
    const { nodeRunId } = await seed(h)
    const res = await req(h.app, `/api/tasks/no_such_task/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(404)
  })

  test('404 when node_run does not belong to the task', async () => {
    const { taskId } = await seed(h)
    const otherId = ulid()
    const res = await req(h.app, `/api/tasks/${taskId}/node-runs/${otherId}/inventory`)
    expect(res.status).toBe(404)
  })

  test('410 for non-agent node kinds', async () => {
    for (const kind of ['wrapper-git', 'review', 'clarify', 'input', 'output'] as const) {
      const { taskId, nodeRunId } = await seed(h, { nodeKind: kind })
      const res = await req(h.app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
      expect(res.status).toBe(410)
    }
  })
})
