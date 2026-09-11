// RFC-027 T4 — integration tests for GET /api/tasks/:taskId/node-runs/
// :nodeRunId/session. Hits the route through createApp so the token
// middleware + Hono routing fire end-to-end. Locks: 200 happy path
// with subagent nesting / 404 task / 404 node-run / 410 non-agent kind
// / multi-attempt isolation.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { SessionViewResponse, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const TOKEN = 'a'.repeat(64)

async function buildApp(
  scope: ProviderHttpApplicationScope,
): Promise<{ db: ProviderNeutralDatabase; app: Hono }> {
  const db = scope.harness.db
  const app = (await scope.open()).app
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
  db: ProviderNeutralDatabase,
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
    promptText: opts.promptText ?? 'do the thing',
    startedAt: 1000,
  })
  return { taskId, nodeRunId }
}

async function insertEvent(
  db: ProviderNeutralDatabase,
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

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'GET /api/tasks/:id/node-runs/:nodeRunId/session',
  {
    token: TOKEN,
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    tempPrefix: 'aw-routes-session-',
  },
  (scope) => {
    beforeEach(() => {
      resetBroadcastersForTests()
    })
    afterEach(() => {
      resetBroadcastersForTests()
    })

    test('200: returns the prompt as the first user message followed by a subagent-call tree', async () => {
      const { db, app } = await buildApp(scope)
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
            state: {
              status: 'completed',
              output: 'audit done',
              input: { subagent_type: 'auditor' },
            },
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
      const { db, app } = await buildApp(scope)
      const { nodeRunId } = await seed(db)
      const res = await req(app, `/api/tasks/no_such_task/node-runs/${nodeRunId}/session`)
      expect(res.status).toBe(404)
    })

    test('404 when node_run does not belong to the task', async () => {
      const { db, app } = await buildApp(scope)
      const { taskId } = await seed(db)
      const otherNodeRunId = ulid() // never inserted
      const res = await req(app, `/api/tasks/${taskId}/node-runs/${otherNodeRunId}/session`)
      expect(res.status).toBe(404)
    })

    test('410 when the node kind is not opencode-backed (input / output / wrapper)', async () => {
      const { db, app } = await buildApp(scope)
      const { taskId, nodeRunId } = await seed(db, { nodeKind: 'wrapper-git' })
      const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/session`)
      expect(res.status).toBe(410)
    })

    test('multi-attempt isolation: events on a sibling node_run do not leak into the requested one', async () => {
      const { db, app } = await buildApp(scope)
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
        status: 'done',
        promptText: 'sibling prompt',
        startedAt: 2000,
      })
      await insertEvent(db, siblingId, {
        kind: 'text',
        sessionId: 'sibling-sess',
        payload: {
          type: 'text',
          sessionID: 'sibling-sess',
          part: { type: 'text', text: 'SIBLING' },
        },
      })
      const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/session`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as SessionViewResponse
      const allText = JSON.stringify(body)
      expect(allText).not.toContain('SIBLING')
    })

    test('RFC-027 §UX merge: inline-session siblings get their events + prompts unified', async () => {
      const { db, app } = await buildApp(scope)
      const { taskId, nodeRunId } = await seed(db, { promptText: 'round-0 ask' })
      // The seed gives us round 0 (clarifyIteration=0). Attach an
      // opencode session_id to it, then mint two more node_runs that
      // share the same session_id (RFC-026 inline reruns).
      // Real-world startedAt is always BEFORE the first event of the
      // run; force that ordering on round 0 by resetting startedAt
      // (the default seed used 1000, but our event below lands at 1100).
      await db
        .update(nodeRuns)
        .set({ opencodeSessionId: 'opc_inline_1', startedAt: 1000 })
        .where(eq(nodeRuns.id, nodeRunId))
      await insertEvent(db, nodeRunId, {
        ts: 1100,
        kind: 'text',
        sessionId: 'opc_inline_1',
        payload: {
          type: 'text',
          sessionID: 'opc_inline_1',
          messageID: 'm1',
          part: { type: 'text', text: 'ROUND_0_REPLY' },
        },
      })

      const round1Id = ulid()
      await db.insert(nodeRuns).values({
        id: round1Id,
        taskId,
        nodeId: 'n1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        status: 'done',
        promptText: 'round-1 answer',
        startedAt: 2000,
        opencodeSessionId: 'opc_inline_1',
      })
      await insertEvent(db, round1Id, {
        ts: 2100,
        kind: 'text',
        sessionId: 'opc_inline_1',
        payload: {
          type: 'text',
          sessionID: 'opc_inline_1',
          messageID: 'm2',
          part: { type: 'text', text: 'ROUND_1_REPLY' },
        },
      })

      const round2Id = ulid()
      await db.insert(nodeRuns).values({
        id: round2Id,
        taskId,
        nodeId: 'n1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        status: 'done',
        promptText: 'round-2 answer',
        startedAt: 3000,
        opencodeSessionId: 'opc_inline_1',
      })
      await insertEvent(db, round2Id, {
        ts: 3100,
        kind: 'text',
        sessionId: 'opc_inline_1',
        payload: {
          type: 'text',
          sessionID: 'opc_inline_1',
          messageID: 'm3',
          part: { type: 'text', text: 'ROUND_2_REPLY' },
        },
      })

      // Request the LATEST round; backend must merge in earlier rounds.
      const res = await req(app, `/api/tasks/${taskId}/node-runs/${round2Id}/session`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as SessionViewResponse
      // Three user prompts + three assistant replies, in chronological order.
      const seq = body.tree.messages.map((m) =>
        m.kind === 'user' ? `U:${m.text}` : m.kind === 'assistant-text' ? `A:${m.text}` : m.kind,
      )
      expect(seq).toEqual([
        'U:round-0 ask',
        'A:ROUND_0_REPLY',
        'U:round-1 answer',
        'A:ROUND_1_REPLY',
        'U:round-2 answer',
        'A:ROUND_2_REPLY',
      ])
    })

    test('legacy path: opencodeSessionId=null keeps the per-node_run isolation', async () => {
      const { db, app } = await buildApp(scope)
      const { taskId, nodeRunId } = await seed(db, { promptText: 'only-this-run' })
      // Same node, no opencode session id — a follow-up retry should
      // NOT leak its events into this run's /session response.
      const siblingId = ulid()
      await db.insert(nodeRuns).values({
        id: siblingId,
        taskId,
        nodeId: 'n1',
        iteration: 0,
        retryIndex: 1,
        reviewIteration: 0,
        status: 'done',
        promptText: 'retry-prompt',
        startedAt: 3000,
      })
      await insertEvent(db, siblingId, {
        ts: 3100,
        kind: 'text',
        sessionId: 'opc_sibling',
        payload: {
          type: 'text',
          sessionID: 'opc_sibling',
          messageID: 'm1',
          part: { type: 'text', text: 'RETRY_REPLY' },
        },
      })
      const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/session`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as SessionViewResponse
      const serialized = JSON.stringify(body)
      expect(serialized).toContain('only-this-run')
      expect(serialized).not.toContain('RETRY_REPLY')
      expect(serialized).not.toContain('retry-prompt')
    })
  },
)
