// RFC-222 (B 线) — admin-only hard delete of a terminal task.
//
//   D-1  admin deletes a terminal task → 200; row + cascade gone; task_feedback
//        gone; memory_distill_jobs / recovery_events / lifecycle_repair_audit
//        RETAINED; worktree reaped.
//   D-2  four terminal statuses → 200; four active statuses → 409.
//   D-3  403 face: user / manager (no tasks:delete); 404 missing; replay 404.
//   D-4  task.deleted broadcast on the tasks-list channel.
//   D-5  cleanup failure → 200 with cleanup:'pending', DB already deleted.
//   D-6  concurrent/front gates: active-in-memory → 409; fusion-internal → 409.

import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  lifecycleRepairAudit,
  nodeRuns,
  recoveryEvents,
  taskFeedback,
  tasks,
  workflows,
} from '../src/db/schema'
import { createApp } from '../src/server'
import {
  TASKS_LIST_CHANNEL,
  resetBroadcastersForTests,
  tasksListBroadcaster,
} from '../src/ws/broadcaster'
import { createUser } from '../src/services/users'
import { __setActiveTaskForTesting } from '../src/services/task'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = join(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  app: Hono
  adminToken: string
  userToken: string
  managerToken: string
}

async function harness(): Promise<H> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const admin = await createUser(db, {
    username: 'root',
    displayName: 'Root',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  const user = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const manager = await createUser(db, {
    username: 'mgr',
    displayName: 'Mgr',
    role: 'manager',
    password: 'longEnoughPassword',
  })
  return {
    db,
    app,
    adminToken: (await createSession({ db, userId: admin.id })).token,
    userToken: (await createSession({ db, userId: user.id })).token,
    managerToken: (await createSession({ db, userId: manager.id })).token,
  }
}

async function seedTask(
  db: DbClient,
  over: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const id = ulid()
  // tasks.workflowId FKs to workflows.id — seed a stub workflow first.
  await db.insert(workflows).values({
    id: `wf_${id}`,
    name: 'stub',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  } as never)
  await db.insert(tasks).values({
    id,
    name: `task-${id}`,
    workflowId: `wf_${id}`,
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw-rfc222',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'done',
    inputs: '{}',
    startedAt: Date.now(),
    ...over,
  })
  return id
}

async function req(h: H, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return h.app.request(path, { ...init, headers })
}

/** DELETE with the correct confirm body for a seeded task. */
async function del(h: H, token: string, id: string, confirm: string): Promise<Response> {
  return req(h, token, `/api/tasks/${id}`, { method: 'DELETE', body: JSON.stringify({ confirm }) })
}

afterEach(() => {
  __setActiveTaskForTesting(undefined)
  resetBroadcastersForTests()
})

describe('RFC-222 D-1 — cascade + retention', () => {
  let h: H
  beforeEach(async () => {
    h = await harness()
  })

  test('admin deletes a terminal task: row + node_runs + task_feedback gone; audit retained', async () => {
    const id = await seedTask(h.db)
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId: id,
      nodeId: 'n1',
      status: 'done',
    } as typeof nodeRuns.$inferInsert)
    await h.db
      .insert(taskFeedback)
      .values({ id: ulid(), taskId: id, bodyMd: 'nice', createdAt: Date.now() } as never)
    await h.db.insert(recoveryEvents).values({
      id: ulid(),
      taskId: id,
      beforeSnapshotJson: '{}',
      afterSnapshotJson: '{}',
      outcome: 'recovered',
      appliedAt: Date.now(),
      createdAt: Date.now(),
      actor: 'system',
      kind: 'auto-resume',
    } as never)
    await h.db.insert(lifecycleRepairAudit).values({
      id: ulid(),
      taskId: id,
      alertRule: 'stuck',
      alertDetailJson: '{}',
      optionId: 'requeue',
      beforeSnapshotJson: '{}',
      afterSnapshotJson: '{}',
      outcome: 'applied',
      appliedAt: Date.now(),
    } as never)

    const res = await del(h, h.adminToken, id, `task-${id}`)
    expect(res.status).toBe(200)

    expect((await h.db.select().from(tasks).where(eq(tasks.id, id))).length).toBe(0)
    expect((await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))).length).toBe(0)
    expect((await h.db.select().from(taskFeedback).where(eq(taskFeedback.taskId, id))).length).toBe(
      0,
    )
    // Retained (memory / DR / append-only audit outlive the task).
    expect(
      (await h.db.select().from(recoveryEvents).where(eq(recoveryEvents.taskId, id))).length,
    ).toBe(1)
    expect(
      (await h.db.select().from(lifecycleRepairAudit).where(eq(lifecycleRepairAudit.taskId, id)))
        .length,
    ).toBe(1)
  })
})

describe('RFC-222 D-2 — status gate', () => {
  let h: H
  beforeEach(async () => {
    h = await harness()
  })

  for (const status of ['done', 'failed', 'canceled', 'interrupted'] as const) {
    test(`terminal '${status}' → 200`, async () => {
      const id = await seedTask(h.db, { status })
      expect((await del(h, h.adminToken, id, `task-${id}`)).status).toBe(200)
    })
  }

  for (const status of ['pending', 'running', 'awaiting_review', 'awaiting_human'] as const) {
    test(`active '${status}' → 409 task-not-terminal`, async () => {
      const id = await seedTask(h.db, { status })
      const res = await del(h, h.adminToken, id, `task-${id}`)
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('task-not-terminal')
    })
  }
})

describe('RFC-222 D-3 — permission + confirm', () => {
  let h: H
  beforeEach(async () => {
    h = await harness()
  })

  test('user and manager → 403 (no tasks:delete)', async () => {
    const id = await seedTask(h.db)
    expect((await del(h, h.userToken, id, `task-${id}`)).status).toBe(403)
    expect((await del(h, h.managerToken, id, `task-${id}`)).status).toBe(403)
    expect((await h.db.select().from(tasks).where(eq(tasks.id, id))).length).toBe(1) // survived
  })

  test('missing task → 404; replay after delete → 404', async () => {
    expect((await del(h, h.adminToken, 'nope', 'nope')).status).toBe(404)
    const id = await seedTask(h.db)
    expect((await del(h, h.adminToken, id, `task-${id}`)).status).toBe(200)
    expect((await del(h, h.adminToken, id, `task-${id}`)).status).toBe(404)
  })

  test('missing confirm → 422; wrong confirm → 422 (task survives)', async () => {
    const id = await seedTask(h.db)
    const missing = await req(h, h.adminToken, `/api/tasks/${id}`, { method: 'DELETE' })
    expect(missing.status).toBe(422)
    expect(((await missing.json()) as { code: string }).code).toBe('delete-confirm-required')
    const wrong = await del(h, h.adminToken, id, 'not-the-name')
    expect(wrong.status).toBe(422)
    expect(((await wrong.json()) as { code: string }).code).toBe('delete-confirm-mismatch')
    expect((await h.db.select().from(tasks).where(eq(tasks.id, id))).length).toBe(1)
  })
})

describe('RFC-222 D-4 — WS broadcast', () => {
  test('task.deleted fires on the tasks-list channel with the taskId', async () => {
    const h = await harness()
    const id = await seedTask(h.db)
    const seen: string[] = []
    const unsub = tasksListBroadcaster.subscribe(TASKS_LIST_CHANNEL, (msg) => {
      if (msg.type === 'task.deleted') seen.push(msg.taskId)
    })
    try {
      expect((await del(h, h.adminToken, id, `task-${id}`)).status).toBe(200)
      expect(seen).toContain(id)
    } finally {
      unsub()
    }
  })
})

describe('RFC-222 D-6 — front gates', () => {
  let h: H
  beforeEach(async () => {
    h = await harness()
  })

  test('active-in-memory (canceled but controller live) → 409 task-active', async () => {
    const id = await seedTask(h.db, { status: 'canceled' })
    __setActiveTaskForTesting(id)
    const res = await del(h, h.adminToken, id, `task-${id}`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('task-active')
  })

  test('fusion-internal task → 409 task-internal', async () => {
    const id = await seedTask(h.db, { spaceKind: 'internal' })
    const res = await del(h, h.adminToken, id, `task-${id}`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('task-internal')
  })
})

describe('RFC-222 D-5 — cleanup best-effort', () => {
  test('a real worktree dir is reaped on delete', async () => {
    const h = await harness()
    const wt = join('/tmp', `aw-rfc222-wt-${ulid()}`)
    mkdirSync(wt, { recursive: true })
    try {
      const id = await seedTask(h.db, { worktreePath: wt, repoPath: '/tmp/aw-rfc222-nonrepo' })
      const res = await del(h, h.adminToken, id, `task-${id}`)
      expect(res.status).toBe(200)
      // DB deletion is authoritative regardless of cleanup outcome.
      expect((await h.db.select().from(tasks).where(eq(tasks.id, id))).length).toBe(0)
      expect(existsSync(wt)).toBe(false)
    } finally {
      if (existsSync(wt)) rmSync(wt, { recursive: true, force: true })
    }
  })
})
