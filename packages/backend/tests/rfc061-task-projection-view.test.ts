// RFC-061 follow-up — GET /api/tasks/:id/projection contract.

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

describe('GET /api/tasks/:id/projection', () => {
  let h: H
  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await build()
  })
  afterEach(() => resetBroadcastersForTests())

  test('404 when task does not exist', async () => {
    const r = await req(h.app, `/api/tasks/no_such_task/projection`)
    expect(r.status).toBe(404)
  })

  test('empty bundle for fresh task', async () => {
    const r = await req(h.app, `/api/tasks/${h.taskId}/projection`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as {
      logicalRuns: unknown[]
      attempts: unknown[]
      outputs: unknown[]
      suspensions: unknown[]
    }
    expect(body.logicalRuns).toEqual([])
    expect(body.attempts).toEqual([])
    expect(body.outputs).toEqual([])
    expect(body.suspensions).toEqual([])
  })

  test('populated bundle exposes logical_runs + attempts + outputs + suspensions', async () => {
    const scope = { nodeId: 'agent_a', loopIter: 0, shardKey: '', iter: 0 } as const
    await writeEvent(h.db, {
      taskId: h.taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      ...scope,
    })
    const attemptId = `att_${ulid()}`
    await writeEvent(h.db, {
      taskId: h.taskId,
      kind: 'attempt-started',
      payload: {},
      actor: 'system',
      ...scope,
      attemptId,
    })
    await writeEvent(h.db, {
      taskId: h.taskId,
      kind: 'attempt-output-captured',
      payload: { portName: 'out', content: 'hello' },
      actor: 'system',
      ...scope,
      attemptId,
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
      ...scope,
    })

    const r = await req(h.app, `/api/tasks/${h.taskId}/projection`)
    const body = (await r.json()) as {
      logicalRuns: Array<{ id: string; status: string }>
      attempts: Array<{ id: string; logicalRunId: string }>
      outputs: Array<{ portName: string; content: string }>
      suspensions: Array<{ id: string; signalKind: string }>
    }
    expect(body.logicalRuns.length).toBe(1)
    expect(body.attempts.length).toBe(1)
    expect(body.attempts[0]?.id).toBe(attemptId)
    expect(body.outputs.length).toBe(1)
    expect(body.outputs[0]?.portName).toBe('out')
    expect(body.suspensions.length).toBe(1)
    expect(body.suspensions[0]?.id).toBe(suspensionId)
    expect(body.suspensions[0]?.signalKind).toBe('self-clarify')
  })
})
