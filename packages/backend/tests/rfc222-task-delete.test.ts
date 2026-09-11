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
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createSession } from './helpers/auth/sessionStore'
import type { ProviderNeutralDatabase } from '../src/db/query'
import {
  lifecycleRepairAudit,
  nodeRuns,
  recoveryEvents,
  taskCollaborators,
  taskFeedback,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import {
  TASKS_LIST_CHANNEL,
  resetBroadcastersForTests,
  tasksListBroadcaster,
} from '../src/ws/broadcaster'
import { createUser } from '../src/services/users'
import { createInMemoryDb } from '../src/db/client'
import { createApp } from '../src/server'
import { __setActiveTaskForTesting } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

interface H {
  db: ProviderNeutralDatabase
  app: Hono
  adminToken: string
  userToken: string
  managerToken: string
}

async function harness(scope: ProviderHttpApplicationScope): Promise<H> {
  const db = scope.harness.db
  const app = (await scope.open()).app
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
  db: ProviderNeutralDatabase,
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

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-222 D-1 — cascade + retention',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-task-delete-',
  },
  (scope) => {
    let h: H
    beforeEach(async () => {
      h = await harness(scope)
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
      expect(
        (await h.db.select().from(taskFeedback).where(eq(taskFeedback.taskId, id))).length,
      ).toBe(0)
      // Retained (memory / DR / append-only audit outlive the task).
      expect(
        (await h.db.select().from(recoveryEvents).where(eq(recoveryEvents.taskId, id))).length,
      ).toBe(1)
      expect(
        (await h.db.select().from(lifecycleRepairAudit).where(eq(lifecycleRepairAudit.taskId, id)))
          .length,
      ).toBe(1)
    })
  },
)

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-222 D-2 — status gate',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-task-delete-',
  },
  (scope) => {
    let h: H
    beforeEach(async () => {
      h = await harness(scope)
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
  },
)

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-222 D-3 — permission + confirm',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-task-delete-',
  },
  (scope) => {
    let h: H
    beforeEach(async () => {
      h = await harness(scope)
    })

    // RFC-285 B1 改判：权限门与可见性门分层——
    //   - 外人 user（无 tasks:read:all、非成员）：可见性中间件先拦 → 404 同形
    //     （改前是 403 task-not-visible，本用例的旧 403 断言恰好双关命中）；
    //   - manager（tasks:read:all 可见、按 RFC-222 无 tasks:delete）：过可见性门
    //     → 权限门 403（这才是「no tasks:delete」的真探针）；
    //   - 可见成员 user（collaborator、无 tasks:delete）：同 403（成员反例）。
    test('外人 user → 404（B1 同形）；manager/成员 user → 403（权限门保留）', async () => {
      const id = await seedTask(h.db)
      expect((await del(h, h.userToken, id, `task-${id}`)).status).toBe(404)
      expect((await del(h, h.managerToken, id, `task-${id}`)).status).toBe(403)
      const memberTaskId = await seedTask(h.db)
      const userRow = (await h.db.select().from(users).where(eq(users.username, 'bob')))[0]!
      await h.db.insert(taskCollaborators).values({
        taskId: memberTaskId,
        userId: userRow.id,
        role: 'collaborator',
        addedAt: Date.now(),
        addedBy: userRow.id,
      })
      expect((await del(h, h.userToken, memberTaskId, `task-${memberTaskId}`)).status).toBe(403)
      expect((await h.db.select().from(tasks).where(eq(tasks.id, id))).length).toBe(1) // survived
      expect((await h.db.select().from(tasks).where(eq(tasks.id, memberTaskId))).length).toBe(1)
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
  },
)

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-222 D-4 — WS broadcast',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-task-delete-',
  },
  (scope) => {
    test('task.deleted fires on the tasks-list channel with the taskId', async () => {
      const h = await harness(scope)
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

    test('root deletion broadcasts every cascaded task with its frozen audience', async () => {
      const h = await harness(scope)
      const [owner, collaborator] = await Promise.all([
        h.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, 'bob'))
          .then((rows) => rows[0]!),
        h.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.username, 'mgr'))
          .then((rows) => rows[0]!),
      ])
      const rootId = await seedTask(h.db, { ownerUserId: owner.id })
      const childId = await seedTask(h.db, {
        ownerUserId: collaborator.id,
        parentTaskId: rootId,
        invocationDepth: 1,
      })
      await h.db.insert(taskCollaborators).values({
        taskId: childId,
        userId: owner.id,
        role: 'collaborator',
        addedBy: collaborator.id,
        addedAt: Date.now(),
      })
      const audiences = new Map<string, ReadonlySet<string>>()
      const unsubscribe = tasksListBroadcaster.subscribe(TASKS_LIST_CHANNEL, (message, context) => {
        if (message.type === 'task.deleted' && context?.kind === 'task.deleted-audience') {
          audiences.set(message.taskId, context.visibleUserIds)
        }
      })
      try {
        expect((await del(h, h.adminToken, rootId, `task-${rootId}`)).status).toBe(200)
        expect([...audiences.keys()].sort()).toEqual([rootId, childId].sort())
        expect([...audiences.get(rootId)!]).toEqual([owner.id])
        expect([...audiences.get(childId)!].sort()).toEqual([owner.id, collaborator.id].sort())
      } finally {
        unsubscribe()
      }
    })
  },
)

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-222 D-6 — front gates',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-task-delete-',
  },
  (scope) => {
    let h: H
    beforeEach(async () => {
      h = await harness(scope)
    })

    test('fusion-internal task → 409 task-internal', async () => {
      const id = await seedTask(h.db, { spaceKind: 'internal' })
      const res = await del(h, h.adminToken, id, `task-${id}`)
      expect(res.status).toBe(409)
      expect(((await res.json()) as { code: string }).code).toBe('task-internal')
    })
  },
)

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-222 D-5 — cleanup best-effort',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-task-delete-',
  },
  (scope) => {
    test('a real worktree dir is reaped on delete', async () => {
      const h = await harness(scope)
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
  },
)

// RFC-359 AC-6 例外：单引擎，**不是「还没迁」**——测试钩子按 provider 不对称。
//
// 两侧的产品判据同形（都是「本进程还有没有 driver 在跑这个任务」）：SQLite 侧
// `isActive: isTaskActive` = `runtimeRegistry.hasTask(id) || testActiveControllers`，PG 侧
// `isActive: (id) => executionModule.runtimeRegistry.hasTask(id)`。差的是后面那个**测试注入项**
// ——`__setActiveTaskForTesting` 往 `testActiveControllers` 里塞，只有 SQLite 那一支读它；
// 而且两侧锚的还不是同一个模块实例（SQLite 进程级单例，PG 是装配出来的那个）。
//
// 于是 **PG 侧的 `task-active` 删除闸门今天没有任何用例覆盖**。这是真缺口，记在 plan §5z：
// 补法是给夹具加一个 provider 中立的「把任务标成在跑」口子（SQLite 走现有钩子、PG 往
// `selected.executionModule.runtimeRegistry` 注册），或先统一两侧锚模块实例的方式。
// 两者都不该夹在一次用例迁移里做。
describe('RFC-222 D-6 — front gates（active-in-memory，单引擎）', () => {
  test('active-in-memory (canceled but controller live) → 409 task-active', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = createApp({
      token: DAEMON_TOKEN,
      configPath: '/tmp/aw-rfc222-delete-config-never-used.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const admin = await createUser(db, {
      username: 'root-single',
      displayName: 'Root',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const adminToken = (await createSession({ db, userId: admin.id })).token
    const id = await seedTask(db, { status: 'canceled' })
    __setActiveTaskForTesting(id)
    const res = await del({ app } as H, adminToken, id, `task-${id}`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('task-active')
  })
})
