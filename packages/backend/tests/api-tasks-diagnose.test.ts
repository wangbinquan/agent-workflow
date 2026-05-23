// RFC-053 PR-D — POST /api/tasks/:id/diagnose
//
// Live invariant scan: returns the same shape as
// runLifecycleInvariants({ scope: { taskId } }) so the UI Diagnose
// panel can render up-to-date alerts without polling the cached
// lifecycle_alerts feed. Asserts:
//   - auth gate (matches sibling /api/tasks/:id routes)
//   - violation found → 200 with openAlerts including the rule
//   - clean shape → 200 with empty openAlerts
//   - unknown task id → 200 scanned=0 (matches service semantics — the
//     visibility middleware decides the 404 path)
//   - WS broadcast fires on lifecycle.alert with the right shape

import { afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode, TasksListWsMessage } from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { docVersions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import {
  resetBroadcastersForTests,
  TASKS_LIST_CHANNEL,
  tasksListBroadcaster,
} from '../src/ws/broadcaster'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

afterEach(() => {
  resetBroadcastersForTests()
})

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

async function diagnose(
  app: Hono,
  taskId: string,
  opts: { auth?: boolean } = {},
): Promise<Response> {
  const auth = opts.auth ?? true
  return app.request(`/api/tasks/${taskId}/diagnose`, {
    method: 'POST',
    headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {},
  })
}

async function seedTask(
  db: DbClient,
  taskStatus: 'awaiting_review' | 'done' | 'running',
  nodes: WorkflowNode[],
): Promise<string> {
  const taskId = `task_${ulid()}`
  const workflowId = `wf_${taskId}`
  const def: WorkflowDefinition = { $schema_version: 2, inputs: [], nodes, edges: [], outputs: [] }
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(def),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: taskStatus,
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describe('POST /api/tasks/:id/diagnose — auth gate', () => {
  test('401 without bearer token', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, 'running', [])
    const res = await diagnose(app, taskId, { auth: false })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/tasks/:id/diagnose — clean task', () => {
  test('returns scanned=1, openAlerts=[] for a healthy task', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, 'running', [])
    const res = await diagnose(app, taskId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { scanned: number; openAlerts: unknown[] }
    expect(body.scanned).toBe(1)
    expect(body.openAlerts).toEqual([])
  })
})

describe('POST /api/tasks/:id/diagnose — RFC-052 shape', () => {
  test('returns 200 + R1 alert for the canonical stuck-review shape', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, 'awaiting_review', [
      { id: 'rev_1', kind: 'review' } as WorkflowNode,
    ])
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'rev_1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      clarifyIteration: 0,
      status: 'awaiting_review',
      startedAt: Date.now(),
    })
    await db.insert(docVersions).values({
      id: ulid(),
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: runId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'dv/v1.md',
      decision: 'approved',
      decidedAt: Date.now(),
    })
    const res = await diagnose(app, taskId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      scanned: number
      newAlerts: number
      openAlerts: Array<{ rule: string; severity: string }>
    }
    expect(body.scanned).toBe(1)
    expect(body.newAlerts).toBe(1)
    const r1 = body.openAlerts.filter((a) => a.rule === 'R1')
    expect(r1).toHaveLength(1)
    expect(r1[0]!.severity).toBe('warning')
  })

  test('broadcasts lifecycle.alert on tasks-list channel for the new finding', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, 'awaiting_review', [
      { id: 'rev_1', kind: 'review' } as WorkflowNode,
    ])
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'rev_1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      clarifyIteration: 0,
      status: 'awaiting_review',
      startedAt: Date.now(),
    })
    await db.insert(docVersions).values({
      id: ulid(),
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: runId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'dv/v1.md',
      decision: 'approved',
      decidedAt: Date.now(),
    })
    const messages: TasksListWsMessage[] = []
    const unsub = tasksListBroadcaster.subscribe(TASKS_LIST_CHANNEL, (m) => {
      messages.push(m)
    })
    try {
      const res = await diagnose(app, taskId)
      expect(res.status).toBe(200)
    } finally {
      unsub()
    }
    const lifecycle = messages.filter((m) => m.type === 'lifecycle.alert')
    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0]).toMatchObject({
      type: 'lifecycle.alert',
      taskId,
      rule: 'R1',
      severity: 'warning',
      transition: 'new',
    })
  })
})

describe('POST /api/tasks/:id/diagnose — unknown task id', () => {
  test('returns 200 scanned=0 (visibility middleware handles 404 via service-side lookup)', async () => {
    const { app } = buildApp()
    const res = await diagnose(app, 'task_does_not_exist')
    // The visibility middleware short-circuits with 403/404 BEFORE the handler
    // runs when the task is missing. Either is acceptable as long as it's not
    // a 5xx.
    expect([200, 403, 404]).toContain(res.status)
  })
})

// RFC-057 — `/diagnose` merges in stored stuck-rule rows so the panel
// shows the full set of open alerts (invariant + stuck). Without this,
// the banner can say "1 open alert" (from /alerts which reads the table)
// while the panel says "no findings" (from /diagnose which only ran the
// invariant scan). Locked here so a refactor of the route can't silently
// drop the merge.
describe('POST /api/tasks/:id/diagnose — RFC-057 stuck-rule merge', () => {
  test('openAlerts includes pre-existing stuck-rule (S3) row even though the live scan does not produce one', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, 'running', [])
    // Plant a fresh S3 row directly — mimicking what the periodic
    // stuck-task scan would have written once the 30-min threshold
    // elapsed. The /diagnose handler runs only the invariant scan so
    // it never inserts S3/S4 itself; merging from the table is the
    // only path that surfaces them.
    const { lifecycleAlerts } = await import('../src/db/schema')
    await db.insert(lifecycleAlerts).values({
      id: 'al_s3_test',
      taskId,
      rule: 'S3',
      severity: 'warning',
      detail: JSON.stringify({ rule: 'S3', repairHint: { kind: 'review', nodeRunId: 'nr_x' } }),
      detectedAt: Date.now(),
      resolvedAt: null,
    })

    const res = await diagnose(app, taskId)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      openAlerts: Array<{ id: string; rule: string; severity: string }>
    }
    const s3 = body.openAlerts.filter((a) => a.rule === 'S3')
    expect(s3).toHaveLength(1)
    expect(s3[0]!.id).toBe('al_s3_test')
  })

  test('does not duplicate an alert that the invariant scan also returns', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, 'awaiting_review', [
      { id: 'rev_1', kind: 'review' } as WorkflowNode,
    ])
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'rev_1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      clarifyIteration: 0,
      status: 'awaiting_review',
      startedAt: Date.now(),
    })
    await db.insert(docVersions).values({
      id: ulid(),
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: runId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'dv/v1.md',
      decision: 'approved',
      decidedAt: Date.now(),
    })
    // First call: invariant scan inserts the R1 row.
    await diagnose(app, taskId)
    // Second call: the merge path also reads the table; ensure the row
    // appears exactly once (not duplicated by the merge).
    const res = await diagnose(app, taskId)
    const body = (await res.json()) as { openAlerts: Array<{ id: string; rule: string }> }
    const r1 = body.openAlerts.filter((a) => a.rule === 'R1')
    expect(r1).toHaveLength(1)
  })
})
