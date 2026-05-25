// RFC-061 follow-up — REST contract tests for the suspensions +
// timeline endpoints added by the same commit.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { writeEvent } from '../src/services/writeEvents'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  cleanup: () => void
}

function buildApp(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-susp-'))
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
    cleanup: () => {
      rmSync(appHome, { recursive: true, force: true })
      if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prevHome
    },
  }
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

async function seedTaskAndScope(db: DbClient): Promise<{ taskId: string; logicalRunId: string }> {
  const wfId = ulid()
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    definition: '{}',
    schemaVersion: 1,
    version: 1,
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw',
    worktreePath: '/tmp/aw-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const lrEvt = await writeEvent(db, {
    taskId,
    kind: 'logical-run-created',
    payload: {},
    actor: 'system',
    nodeId: 'agent_a',
    loopIter: 0,
    shardKey: '',
    iter: 0,
  })
  return { taskId, logicalRunId: lrEvt.id }
}

describe('GET /api/tasks/:id/suspensions + /api/suspensions/:id', () => {
  let h: Harness
  beforeEach(() => {
    h = buildApp()
  })
  afterEach(() => h.cleanup())

  test('empty list when no suspensions exist', async () => {
    const { taskId } = await seedTaskAndScope(h.db)
    const res = await req(h.app, `/api/tasks/${taskId}/suspensions`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: unknown[] }
    expect(body.rows).toEqual([])
  })

  test('lists an open suspension created via writeEvent', async () => {
    const { taskId, logicalRunId } = await seedTaskAndScope(h.db)
    const suspensionId = `sus_${ulid()}`
    await writeEvent(h.db, {
      taskId,
      kind: 'suspension-created',
      payload: {
        suspensionId,
        signalKind: 'self-clarify',
        awaitsActor: 'user:',
        body: {
          questions: [{ id: 'q1', text: 'what color?', type: 'text' }],
        },
      },
      actor: 'system',
      nodeId: 'agent_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })

    const res = await req(h.app, `/api/tasks/${taskId}/suspensions`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      rows: Array<{
        id: string
        signalKind: string
        nodeRunId: string
        awaitsActor: string
        resolvedAt: number | null
      }>
    }
    expect(body.rows.length).toBe(1)
    const r = body.rows[0]!
    expect(r.id).toBe(suspensionId)
    expect(r.signalKind).toBe('self-clarify')
    expect(r.nodeRunId).toBe(logicalRunId)
    expect(r.awaitsActor).toBe('user:')
    expect(r.resolvedAt).toBeNull()
  })

  test('GET /api/suspensions/:id 404 when missing', async () => {
    const res = await req(h.app, `/api/suspensions/sus_does_not_exist`)
    expect(res.status).toBe(404)
  })

  test('POST resolve rejects an unknown suspension with 404', async () => {
    const res = await req(h.app, `/api/suspensions/sus_does_not_exist/resolve`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(404)
  })

  test('GET /api/suspensions lists open rows across every task', async () => {
    const a = await seedTaskAndScope(h.db)
    const b = await seedTaskAndScope(h.db)
    for (const t of [a, b]) {
      await writeEvent(h.db, {
        taskId: t.taskId,
        kind: 'suspension-created',
        payload: {
          suspensionId: `sus_${ulid()}`,
          signalKind: 'self-clarify',
          awaitsActor: 'user:',
          body: { questions: [{ id: 'q1', text: 'q?', type: 'text' }] },
        },
        actor: 'system',
        nodeId: 'agent_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      })
    }
    const res = await req(h.app, `/api/suspensions`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: Array<{ taskId: string }> }
    expect(body.rows.length).toBe(2)
    const taskIds = new Set(body.rows.map((r) => r.taskId))
    expect(taskIds.has(a.taskId)).toBe(true)
    expect(taskIds.has(b.taskId)).toBe(true)
  })

  test('GET /api/suspensions?signalKind=review filters', async () => {
    const t = await seedTaskAndScope(h.db)
    await writeEvent(h.db, {
      taskId: t.taskId,
      kind: 'suspension-created',
      payload: {
        suspensionId: `sus_${ulid()}`,
        signalKind: 'self-clarify',
        awaitsActor: 'user:',
        body: { questions: [{ id: 'q1', text: 'q?', type: 'text' }] },
      },
      actor: 'system',
      nodeId: 'agent_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
    const res = await req(h.app, `/api/suspensions?signalKind=review`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rows: Array<unknown> }
    expect(body.rows.length).toBe(0)
  })

  test('?openOnly=false returns resolved rows too', async () => {
    const { taskId } = await seedTaskAndScope(h.db)
    const suspensionId = `sus_${ulid()}`
    await writeEvent(h.db, {
      taskId,
      kind: 'suspension-created',
      payload: {
        suspensionId,
        signalKind: 'self-clarify',
        awaitsActor: 'user:',
        body: { questions: [{ id: 'q1', text: 'q?', type: 'text' }] },
      },
      actor: 'system',
      nodeId: 'agent_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
    await writeEvent(h.db, {
      taskId,
      kind: 'suspension-resolved',
      payload: { suspensionId, signalKind: 'self-clarify', decision: { answers: [] } },
      actor: 'user:test',
      nodeId: 'agent_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      resolutionId: `res_${ulid()}`,
    })

    const open = await req(h.app, `/api/tasks/${taskId}/suspensions`)
    expect(((await open.json()) as { rows: unknown[] }).rows.length).toBe(0)

    const all = await req(h.app, `/api/tasks/${taskId}/suspensions?openOnly=false`)
    expect(((await all.json()) as { rows: unknown[] }).rows.length).toBe(1)
  })
})

describe('GET /api/tasks/:id/timeline', () => {
  let h: Harness
  beforeEach(() => {
    h = buildApp()
  })
  afterEach(() => h.cleanup())

  test('404 for unknown task', async () => {
    const res = await req(h.app, `/api/tasks/no_such_task/timeline`)
    expect(res.status).toBe(404)
  })

  test('returns events in id order; cursor paginates', async () => {
    const { taskId } = await seedTaskAndScope(h.db)
    // seed 3 more events on top of the logical-run-created from
    // seedTaskAndScope (= 4 total).
    const attemptId = `att_${ulid()}`
    await writeEvent(h.db, {
      taskId,
      kind: 'attempt-started',
      payload: {},
      actor: 'system',
      nodeId: 'agent_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId,
    })
    await writeEvent(h.db, {
      taskId,
      kind: 'attempt-subagent-output',
      payload: { sessionId: 'sub', content: 'hello' },
      actor: 'system',
      nodeId: 'agent_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId,
    })
    await writeEvent(h.db, {
      taskId,
      kind: 'attempt-finished-success',
      payload: {},
      actor: 'system',
      nodeId: 'agent_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId,
    })

    const first = await req(h.app, `/api/tasks/${taskId}/timeline?limit=2`)
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as {
      events: Array<{ id: string; kind: string }>
      cursor: string | null
    }
    expect(firstBody.events.length).toBe(2)
    expect(firstBody.cursor).not.toBeNull()

    const second = await req(
      h.app,
      `/api/tasks/${taskId}/timeline?limit=10&afterId=${firstBody.cursor}`,
    )
    const secondBody = (await second.json()) as {
      events: Array<{ id: string }>
      cursor: string | null
    }
    expect(secondBody.events.length).toBe(2)
    expect(secondBody.cursor).toBeNull()
  })

  test('?kind filters', async () => {
    const { taskId } = await seedTaskAndScope(h.db)
    const attemptId = `att_${ulid()}`
    await writeEvent(h.db, {
      taskId,
      kind: 'attempt-started',
      payload: {},
      actor: 'system',
      nodeId: 'agent_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId,
    })
    await writeEvent(h.db, {
      taskId,
      kind: 'attempt-finished-success',
      payload: {},
      actor: 'system',
      nodeId: 'agent_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId,
    })

    const res = await req(h.app, `/api/tasks/${taskId}/timeline?kind=attempt-started`)
    const body = (await res.json()) as { events: Array<{ kind: string }> }
    expect(body.events.length).toBe(1)
    expect(body.events[0]?.kind).toBe('attempt-started')
  })
})
