// RFC-027 T4 — integration tests for GET /api/tasks/:taskId/node-runs/
// :nodeRunId/session. Hits the route through createApp so the token
// middleware + Hono routing fire end-to-end. Locks: 200 happy path
// with subagent nesting / 404 task / 404 node-run / 410 non-agent kind
// / multi-attempt isolation.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { SessionViewResponse, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

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

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  })
}

interface SeedOpts {
  nodeKind?: 'agent-single' | 'agent-multi' | 'input' | 'output' | 'wrapper-git'
  promptText?: string | null
  agentName?: string
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
        agentName: opts.agentName ?? 'coder',
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
    clarifyIteration: 0,
    status: 'done',
    promptText: opts.promptText ?? 'do the thing',
    startedAt: 1000,
  })
  return { taskId, nodeRunId }
}

async function insertEvent(
  db: DbClient,
  nodeRunId: string,
  partial: {
    ts?: number
    kind: 'text' | 'tool_use' | 'subagent_capture_failed'
    sessionId: string | null
    parentSessionId?: string | null
    payload: object
  },
): Promise<void> {
  await db.insert(nodeRunEvents).values({
    nodeRunId,
    ts: partial.ts ?? Date.now(),
    kind: partial.kind,
    payload: JSON.stringify(partial.payload),
    sessionId: partial.sessionId,
    parentSessionId: partial.parentSessionId ?? null,
  })
}

describe('GET /api/tasks/:id/node-runs/:nodeRunId/session', () => {
  beforeEach(() => {
    resetBroadcastersForTests()
  })
  afterEach(() => {
    resetBroadcastersForTests()
  })

  test('200: returns the prompt as the first user message followed by a subagent-call tree', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { promptText: 'audit the diff' })
    await insertEvent(db, nodeRunId, {
      kind: 'tool_use',
      sessionId: 'root',
      payload: {
        type: 'tool_use',
        sessionID: 'root',
        part: {
          type: 'tool',
          callID: 'c1',
          tool: 'task',
          metadata: { sessionID: 'child' },
          state: { status: 'completed', output: 'audit done', input: { subagent_type: 'auditor' } },
        },
      },
    })
    await insertEvent(db, nodeRunId, {
      kind: 'text',
      sessionId: 'child',
      parentSessionId: 'root',
      payload: {
        type: 'text',
        sessionID: 'child',
        messageID: 'cm1',
        part: { type: 'text', text: 'audit text here' },
      },
    })

    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/session`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionViewResponse
    expect(body.tree.sessionId).toBe('root')
    expect(body.tree.messages[0]).toMatchObject({ kind: 'user', text: 'audit the diff' })
    const sub = body.tree.messages.find((m) => m.kind === 'subagent-call')
    expect(sub?.kind).toBe('subagent-call')
    if (sub?.kind === 'subagent-call') {
      expect(sub.childAgentName).toBe('auditor')
      expect(sub.child?.messages.some((m) => m.kind === 'assistant-text')).toBe(true)
    }
  })

  test('404 when the task does not exist', async () => {
    const { db, app } = buildApp()
    const { nodeRunId } = await seed(db)
    const res = await req(app, `/api/tasks/no_such_task/node-runs/${nodeRunId}/session`)
    expect(res.status).toBe(404)
  })

  test('404 when node_run does not belong to the task', async () => {
    const { db, app } = buildApp()
    const { taskId } = await seed(db)
    const otherNodeRunId = ulid() // never inserted
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${otherNodeRunId}/session`)
    expect(res.status).toBe(404)
  })

  test('410 when the node kind is not opencode-backed (input / output / wrapper)', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { nodeKind: 'wrapper-git' })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/session`)
    expect(res.status).toBe(410)
  })

  test('multi-attempt isolation: events on a sibling node_run do not leak into the requested one', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { promptText: 'go' })
    // Sibling node_run on the SAME task but distinct nodeRunId.
    const siblingId = ulid()
    await db.insert(nodeRuns).values({
      id: siblingId,
      taskId,
      nodeId: 'n2',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      clarifyIteration: 0,
      status: 'done',
      promptText: 'sibling prompt',
      startedAt: 2000,
    })
    await insertEvent(db, siblingId, {
      kind: 'text',
      sessionId: 'sibling-sess',
      payload: { type: 'text', sessionID: 'sibling-sess', part: { type: 'text', text: 'SIBLING' } },
    })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/session`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as SessionViewResponse
    const allText = JSON.stringify(body)
    expect(allText).not.toContain('SIBLING')
  })
})
