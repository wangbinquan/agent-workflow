// RFC-239 — route-level error codes, named here so the route-error-code
// coverage guard sees a test that exercises each NEW code:
//   file-content-side-invalid / narrative-scope-invalid / narrative-not-found
// (the service-level codes are asserted in task-file-content.test.ts /
// change-narrative.test.ts by behavior).

import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { resetChangeNarrativeStateForTests } from '../src/services/changeNarrative'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

afterEach(() => {
  resetBroadcastersForTests()
  resetChangeNarrativeStateForTests()
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

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `01RC${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const workflowId = `wf-${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    definition: JSON.stringify({ nodes: [], edges: [] }),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/none',
    worktreePath: '/tmp/none',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function getJson(
  app: Hono,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request(path, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('RFC-239 route error codes', () => {
  test('file-content with a bad side → 422 file-content-side-invalid', async () => {
    const { db, app } = buildApp()
    const id = await seedTask(db)
    const r = await getJson(app, `/api/tasks/${id}/file-content?path=a.md&side=weird`)
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('file-content-side-invalid')
  })

  test('change-narrative with a non-task scope → 422 narrative-scope-invalid', async () => {
    const { db, app } = buildApp()
    const id = await seedTask(db)
    const r = await getJson(app, `/api/tasks/${id}/change-narrative?scope=node`)
    expect(r.status).toBe(422)
    expect(r.body.code).toBe('narrative-scope-invalid')
  })

  test('change-narrative before any generation → 404 narrative-not-found', async () => {
    const { db, app } = buildApp()
    const id = await seedTask(db)
    const r = await getJson(app, `/api/tasks/${id}/change-narrative`)
    expect(r.status).toBe(404)
    expect(r.body.code).toBe('narrative-not-found')
  })
})
