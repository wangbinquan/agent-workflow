// RFC-053 — visibility middleware also applies to /alerts + /diagnose.
//
// The two new routes mount under `app.use('/api/tasks/:id/*', ...)`
// which delegates to RFC-036's `canViewTask` gate. An outsider (no
// owner / no collaborator membership) should receive HTTP 403 with
// code='task-not-found'（RFC-285 B1 同形 404）, NOT 200 + empty data and NOT 500.
//
// Mirrors `tests/tasks-visibility.test.ts` but targets the two RFC-053
// routes explicitly.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskCollaborators, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  aliceToken: string
  bobToken: string
  carolToken: string
  daveToken: string
  bobTaskId: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })

  const alice = await createUser(db, {
    username: 'alice',
    displayName: 'Alice',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const bob = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const carol = await createUser(db, {
    username: 'carol',
    displayName: 'Carol',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const dave = await createUser(db, {
    username: 'dave',
    displayName: 'Dave',
    role: 'user',
    password: 'longEnoughPassword',
  })

  const aliceToken = (await createSession({ db, userId: alice.id })).token
  const bobToken = (await createSession({ db, userId: bob.id })).token
  const carolToken = (await createSession({ db, userId: carol.id })).token
  const daveToken = (await createSession({ db, userId: dave.id })).token

  const wfId = 'wf-vis'
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
  })

  const bobTaskId = 'task-bob-vis'
  const now = Date.now()
  await db.insert(tasks).values({
    id: bobTaskId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${bobTaskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: now,
    ownerUserId: bob.id,
  })
  await db.insert(taskCollaborators).values([
    { taskId: bobTaskId, userId: bob.id, role: 'owner', addedBy: bob.id, addedAt: now },
    // RFC-099: the 'reviewer' role tag is gone — plain collaborator membership.
    { taskId: bobTaskId, userId: carol.id, role: 'collaborator', addedBy: bob.id, addedAt: now },
  ])
  return { db, app, aliceToken, bobToken, carolToken, daveToken, bobTaskId }
}

async function get(app: Hono, token: string, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } })
}

async function post(app: Hono, token: string, path: string): Promise<Response> {
  return app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
}

describe('RFC-053 — GET /api/tasks/:id/alerts visibility gate', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('admin → 200', async () => {
    const r = await get(h.app, h.aliceToken, `/api/tasks/${h.bobTaskId}/alerts`)
    expect(r.status).toBe(200)
  })

  test('owner (bob) → 200', async () => {
    const r = await get(h.app, h.bobToken, `/api/tasks/${h.bobTaskId}/alerts`)
    expect(r.status).toBe(200)
  })

  test('collaborator (carol) → 200', async () => {
    const r = await get(h.app, h.carolToken, `/api/tasks/${h.bobTaskId}/alerts`)
    expect(r.status).toBe(200)
  })

  // RFC-285 B1：外人 404 与不存在同形（旧 403 task-not-visible 退役）。
  test('outsider (dave) → 404 task-not-found（B1 同形）', async () => {
    const r = await get(h.app, h.daveToken, `/api/tasks/${h.bobTaskId}/alerts`)
    expect(r.status).toBe(404)
    const body = (await r.json()) as { code: string }
    expect(body.code).toBe('task-not-found')
  })
})

describe('RFC-053 — POST /api/tasks/:id/diagnose visibility gate', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('admin → 200', async () => {
    const r = await post(h.app, h.aliceToken, `/api/tasks/${h.bobTaskId}/diagnose`)
    expect(r.status).toBe(200)
  })

  test('owner (bob) → 200', async () => {
    const r = await post(h.app, h.bobToken, `/api/tasks/${h.bobTaskId}/diagnose`)
    expect(r.status).toBe(200)
  })

  test('collaborator (carol) → 200', async () => {
    const r = await post(h.app, h.carolToken, `/api/tasks/${h.bobTaskId}/diagnose`)
    expect(r.status).toBe(200)
  })

  // RFC-285 B1：同上——写型入口的外人同样 404 同形。
  test('outsider (dave) → 404 task-not-found（B1 同形）', async () => {
    const r = await post(h.app, h.daveToken, `/api/tasks/${h.bobTaskId}/diagnose`)
    expect(r.status).toBe(404)
    const body = (await r.json()) as { code: string }
    expect(body.code).toBe('task-not-found')
  })
})
