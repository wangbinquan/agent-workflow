// RFC-061 follow-up — GET /api/tasks/:id/diagnose contract test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { writeEvent } from '../src/services/writeEvents'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  app: Hono
  taskId: string
}

async function build(): Promise<H> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  const wfId = ulid()
  await db.insert(workflows).values({ id: wfId, name: 'wf', definition: '{}' })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { db, app, taskId }
}

async function req(app: Hono, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
}

describe('GET /api/tasks/:id/diagnose', () => {
  let h: H
  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await build()
  })
  afterEach(() => resetBroadcastersForTests())

  test('404 when task does not exist', async () => {
    const r = await req(h.app, `/api/tasks/no_such_task/diagnose`)
    expect(r.status).toBe(404)
  })

  test('empty arrays when task is healthy', async () => {
    const r = await req(h.app, `/api/tasks/${h.taskId}/diagnose`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      task: { taskId: string; status: string; lastEventTs: number | null }
      openSuspensions: unknown[]
      pendingLogicalRuns: unknown[]
      openAlerts: unknown[]
    }
    expect(body.task.taskId).toBe(h.taskId)
    expect(body.task.status).toBe('running')
    expect(body.task.lastEventTs).toBeNull()
    expect(body.openSuspensions).toEqual([])
    expect(body.pendingLogicalRuns).toEqual([])
    expect(body.openAlerts).toEqual([])
  })

  test('surfaces open suspensions + pending logical_runs', async () => {
    const baseScope = { nodeId: 'agent_a', loopIter: 0, shardKey: '', iter: 0 } as const
    await writeEvent(h.db, {
      taskId: h.taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      ...baseScope,
    })
    const suspensionId = `sus_${ulid()}`
    await writeEvent(h.db, {
      taskId: h.taskId,
      kind: 'suspension-created',
      payload: {
        suspensionId,
        signalKind: 'self-clarify',
        awaitsActor: 'user:alice',
        body: { questions: [{ id: 'q1', text: 'q?' }] },
      },
      actor: 'system',
      ...baseScope,
    })

    const r = await req(h.app, `/api/tasks/${h.taskId}/diagnose`)
    const body = (await r.json()) as {
      task: { lastEventTs: number | null }
      openSuspensions: Array<{ id: string; signalKind: string; nodeId: string }>
      pendingLogicalRuns: Array<{ nodeId: string; status: string }>
    }
    expect(body.task.lastEventTs).not.toBeNull()
    expect(body.openSuspensions.length).toBe(1)
    expect(body.openSuspensions[0]?.id).toBe(suspensionId)
    expect(body.openSuspensions[0]?.signalKind).toBe('self-clarify')
    expect(body.openSuspensions[0]?.nodeId).toBe('agent_a')
    // logical_run is now status='suspended' (suspension-created applied
    // the projection update).
    expect(body.pendingLogicalRuns.length).toBe(1)
    expect(body.pendingLogicalRuns[0]?.status).toBe('suspended')
  })
})
