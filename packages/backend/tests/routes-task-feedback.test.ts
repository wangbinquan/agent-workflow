// RFC-041 — HTTP layer for task feedback (PR2).
//
// Covers: visibility gate (404/403), valid POST → 201 + distill job created,
// invalid body → 422, permission gating.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { memoryDistillJobs, tasks, taskCollaborators, workflows } from '../src/db/schema'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { TaskFeedback } from '@agent-workflow/shared'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  daemonToken: string
  adminToken: string
  ownerToken: string
  outsiderToken: string
  taskId: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const owner = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const outsider = await createUser(db, {
    username: 'carol',
    displayName: 'Carol',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const adminToken = (await createSession({ db, userId: admin.id })).token
  const ownerToken = (await createSession({ db, userId: owner.id })).token
  const outsiderToken = (await createSession({ db, userId: outsider.id })).token

  const wfId = ulid()
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/wt',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    baseCommit: null,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    ownerUserId: owner.id,
  })
  await db.insert(taskCollaborators).values({
    taskId,
    userId: owner.id,
    role: 'owner',
    addedBy: owner.id,
    addedAt: Date.now(),
  })

  return { db, app, daemonToken: DAEMON_TOKEN, adminToken, ownerToken, outsiderToken, taskId }
}

function authed(token: string, url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return new Request(`http://localhost${url}`, { ...init, headers })
}

describe('routes-task-feedback', () => {
  let h: Harness
  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
  })

  test('owner POSTs a feedback note → 201 + distill job enqueued', async () => {
    const res = await h.app.fetch(
      authed(h.ownerToken, `/api/tasks/${h.taskId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ bodyMd: '  always confirm migration safety  ' }),
      }),
    )
    expect(res.status).toBe(201)
    const j = (await res.json()) as { feedback: TaskFeedback; distillJobId: string }
    expect(j.feedback.bodyMd).toBe('always confirm migration safety') // trim
    expect(j.feedback.authorUserId).toBeTruthy()
    expect(j.distillJobId).toBeTruthy()
    const jobs = h.db.select().from(memoryDistillJobs).all()
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.debounceKey).toBe(`${h.taskId}:feedback`)
  })

  test('owner GETs the feedback list (own task)', async () => {
    await h.app.fetch(
      authed(h.ownerToken, `/api/tasks/${h.taskId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ bodyMd: 'note' }),
      }),
    )
    const res = await h.app.fetch(authed(h.ownerToken, `/api/tasks/${h.taskId}/feedback`))
    expect(res.status).toBe(200)
    const j = (await res.json()) as { items: TaskFeedback[] }
    expect(j.items.length).toBe(1)
  })

  test('outsider POST → 403 (task not visible)', async () => {
    const res = await h.app.fetch(
      authed(h.outsiderToken, `/api/tasks/${h.taskId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ bodyMd: 'note' }),
      }),
    )
    expect(res.status).toBe(403)
  })

  test('admin sees all tasks even when not a collaborator', async () => {
    const res = await h.app.fetch(
      authed(h.adminToken, `/api/tasks/${h.taskId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ bodyMd: 'admin note' }),
      }),
    )
    expect(res.status).toBe(201)
  })

  test('missing taskId returns 404', async () => {
    const res = await h.app.fetch(
      authed(h.adminToken, `/api/tasks/t_does_not_exist/feedback`, {
        method: 'POST',
        body: JSON.stringify({ bodyMd: 'note' }),
      }),
    )
    expect(res.status).toBe(404)
  })

  test('empty body → 422', async () => {
    const res = await h.app.fetch(
      authed(h.ownerToken, `/api/tasks/${h.taskId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ bodyMd: '   ' }),
      }),
    )
    expect(res.status).toBe(422)
  })

  test('body > 4000 → 422', async () => {
    const res = await h.app.fetch(
      authed(h.ownerToken, `/api/tasks/${h.taskId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ bodyMd: 'x'.repeat(4001) }),
      }),
    )
    expect(res.status).toBe(422)
  })
})
