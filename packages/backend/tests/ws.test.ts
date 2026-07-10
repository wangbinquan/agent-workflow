// End-to-end coverage for the three WS channels (P-2-02).
//
// Spawns a real Bun.serve() bound to an ephemeral port so we can connect a
// real WebSocket client. The broadcaster fan-out is exercised by invoking
// services directly (createWorkflow / updateWorkflow / startTask).

import type { Server } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

type AnyServer = Server<unknown>
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createWorkflow, deleteWorkflow, updateWorkflow } from '../src/services/workflow'
import { emitTaskStatus } from '../src/services/task'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { buildWebSocketAdapter } from '../src/ws/server'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  server: AnyServer
  url: string
  cleanup: () => Promise<void>
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '/tmp/__never_used__.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const ws = buildWebSocketAdapter({ daemonToken: TOKEN, db })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req: Request, srv): Promise<Response> {
      const upgraded = await ws.tryUpgrade(req, srv)
      if (upgraded === true) return undefined as unknown as Response
      if (upgraded === false) return await app.fetch(req)
      return upgraded
    },
    websocket: ws.handlers,
  })
  return {
    db,
    server,
    url: `ws://${server.hostname}:${server.port}`,
    cleanup: async () => {
      server.stop(true)
      resetBroadcastersForTests()
    },
  }
}

/**
 * Open a WS connection and collect messages for `timeoutMs`. Resolves with
 * everything received in that window.
 */
async function collectMessages(
  url: string,
  expected: number,
  timeoutMs = 1000,
): Promise<unknown[]> {
  const out: unknown[] = []
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      resolvePromise(out) // return what we got
    }, timeoutMs)
    ws.addEventListener('message', (e) => {
      try {
        out.push(JSON.parse(String(e.data)))
      } catch {
        out.push(e.data)
      }
      if (out.length >= expected) {
        clearTimeout(timer)
        ws.close()
        resolvePromise(out)
      }
    })
    ws.addEventListener('error', (e) => {
      clearTimeout(timer)
      reject(e instanceof Error ? e : new Error('ws error'))
    })
  })
}

/**
 * Resolve as soon as `pred()` is true, polling every few ms, with `capMs` as an
 * upper bound. Replaces fixed `setTimeout(50)` settle waits: WS frames arrive in
 * <5ms locally, so the wait collapses to near-zero while the cap still guards
 * against a genuinely-missing message (which then fails the assertion below it).
 */
async function waitUntil(pred: () => boolean, capMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > capMs) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

const hasType = (msgs: unknown[], type: string): boolean =>
  msgs.some((m) => (m as { type?: string }).type === type)

describe('WebSocket channels', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  test('unknown ws channel returns 404 (no upgrade)', async () => {
    const res = await fetch(`http://${h.server.hostname}:${h.server.port}/ws/bogus`)
    expect(res.status).toBe(404)
  })

  test('missing token rejects with 401 (no upgrade)', async () => {
    const res = await fetch(`http://${h.server.hostname}:${h.server.port}/ws/tasks`)
    expect(res.status).toBe(401)
  })

  test('/ws/tasks: hello + receives task.created and task.status', async () => {
    // This test only asserts the hello frame (no broadcast is triggered), so we
    // ask for exactly 1 message — collectMessages early-resolves on the hello
    // instead of idling out the full window.
    const msgs = await collectMessages(`${h.url}/ws/tasks?token=${TOKEN}`, 1, 1500)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    const first = msgs[0] as { type: string; channel?: string }
    expect(first.type).toBe('hello')
    expect(first.channel).toBe('tasks')
  })

  test('/ws/workflows: hello + workflow.created event after createWorkflow', async () => {
    const received: unknown[] = []
    const ws = new WebSocket(`${h.url}/ws/workflows?token=${TOKEN}`)
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res())
      ws.addEventListener('error', () => rej(new Error('ws error')))
    })
    ws.addEventListener('message', (e) => received.push(JSON.parse(String(e.data))))
    // Hello frame is queued before the first broadcast — wait for it.
    await waitUntil(() => hasType(received, 'hello'))

    await createWorkflow(h.db, {
      name: 'wf-1',
      description: '',
      definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
    })
    await waitUntil(() => hasType(received, 'workflow.created'))
    ws.close()

    const types = received.map((m) => (m as { type: string }).type)
    expect(types).toContain('hello')
    expect(types).toContain('workflow.created')
  })

  test('/ws/workflows: updateWorkflow emits workflow.updated; delete emits workflow.deleted', async () => {
    const wf = await createWorkflow(h.db, {
      name: 'wf',
      description: '',
      definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
    })

    const received: Array<{ type: string }> = []
    const ws = new WebSocket(`${h.url}/ws/workflows?token=${TOKEN}`)
    await new Promise<void>((res) => {
      ws.addEventListener('open', () => res())
    })
    ws.addEventListener('message', (e) => received.push(JSON.parse(String(e.data))))
    await waitUntil(() => hasType(received, 'hello'))

    await updateWorkflow(h.db, wf.id, { name: 'wf renamed' })
    await deleteWorkflow(h.db, wf.id)
    await waitUntil(
      () => hasType(received, 'workflow.updated') && hasType(received, 'workflow.deleted'),
    )
    ws.close()

    const types = received.map((m) => m.type)
    expect(types).toContain('workflow.updated')
    expect(types).toContain('workflow.deleted')
  })

  test('/ws/tasks/{id}: task.status broadcasts from emitTaskStatus', async () => {
    // Seed a fake task row (avoids spawning the scheduler in this test).
    const taskId = ulid()
    await h.db.insert(workflows).values({
      id: 'wf-x',
      name: 'wf',
      definition: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id: taskId,
      workflowId: 'wf-x',
      workflowSnapshot: '{}',
      repoPath: '/tmp/x',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })

    const received: Array<{ type: string; status?: string }> = []
    const ws = new WebSocket(`${h.url}/ws/tasks/${taskId}?token=${TOKEN}`)
    await new Promise<void>((res) => {
      ws.addEventListener('open', () => res())
    })
    ws.addEventListener('message', (e) => received.push(JSON.parse(String(e.data))))
    await waitUntil(() => hasType(received, 'hello'))

    // Trigger emitTaskStatus by flipping the row + invoking the helper.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
    if (t === undefined) throw new Error('seeded task missing')
    emitTaskStatus({
      id: t.id,
      name: t.name,
      workflowId: t.workflowId,
      workflowName: null,
      workflowSnapshot: {},
      workflowVersion: null,
      repoPath: t.repoPath,
      repoUrl: null,
      worktreePath: t.worktreePath,
      baseBranch: t.baseBranch,
      branch: t.branch,
      baseCommit: null,
      status: 'done',
      inputs: {},
      maxDurationMs: null,
      maxTotalTokens: null,
      startedAt: t.startedAt,
      finishedAt: t.startedAt + 1,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
      expiresAt: null,
      deletedAt: null,
      schemaVersion: 1,
      gitUserName: null,
      gitUserEmail: null,
      // RFC-075: TaskSchema now carries the working branch + commit&push flag.
      workingBranch: null,
      autoCommitPush: false,
      // RFC-120 T9: TaskSchema now carries the deferred-dispatch opt-in flag.
      // RFC-066: TaskSchema now requires per-task repo metadata.
      repoCount: 1,
      spaceKind: 'remote', // RFC-165
      sourceAgentName: null,
      repos: [],
    })

    await waitUntil(() => hasType(received, 'task.status') && hasType(received, 'task.done'))
    ws.close()

    const types = received.map((m) => m.type)
    expect(types).toContain('hello')
    expect(types).toContain('task.status')
    expect(types).toContain('task.done')
  })

  test('/ws/tasks/{id}?since=N replays node_run_events with id > N', async () => {
    // Seed a task + node_run + 3 events.
    const taskId = ulid()
    await h.db.insert(workflows).values({
      id: 'wf-y',
      name: 'wf',
      definition: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await h.db.insert(tasks).values({
      name: 'fixture-task',

      id: taskId,
      workflowId: 'wf-y',
      workflowSnapshot: '{}',
      repoPath: '/tmp/y',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const nrId = ulid()
    await h.db
      .insert(nodeRuns)
      .values({ id: nrId, taskId, nodeId: 'n1', status: 'done', startedAt: Date.now() })
    for (let i = 0; i < 3; i++) {
      await h.db.insert(nodeRunEvents).values({
        nodeRunId: nrId,
        ts: Date.now(),
        kind: 'text',
        payload: JSON.stringify({ chunk: i }),
      })
    }

    // Read back the event ids so we know what to ?since=.
    const allEvents = await h.db.select().from(nodeRunEvents)
    const sortedIds = allEvents.map((e) => e.id).sort((a, b) => a - b)
    const firstId = sortedIds[0] ?? 0

    const received: Array<{ type: string; id?: number; payload?: unknown }> = []
    const ws = new WebSocket(`${h.url}/ws/tasks/${taskId}?token=${TOKEN}&since=${firstId}`)
    await new Promise<void>((res) => {
      ws.addEventListener('open', () => res())
    })
    ws.addEventListener('message', (e) => received.push(JSON.parse(String(e.data))))
    // Exactly 2 events have id > firstId; the server replays them on connect.
    // Wait until both have arrived (no third can come, so the count stays exact).
    await waitUntil(() => received.filter((m) => m.type === 'node.event').length >= 2)
    ws.close()

    const events = received.filter((m) => m.type === 'node.event')
    expect(events.length).toBe(2) // events with id > firstId
    expect(events[0]?.id).toBe(sortedIds[1])
  })
})
