// RFC-159 T7 — manual "run now".
//
// Locks the pure-launch contract: run-now fires immediately via the same
// fireSchedule path (owner actor + launchability re-check + scheduled_task_id
// stamping) but must NOT mutate the schedule's automated-cadence state
// (next_run_at / last_* / consecutive_failures) — a manual test-run never
// advances the clock nor auto-disables. Works on a disabled schedule (manual
// override). Route gate = same owner/admin visibility as the other routes.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'

import { buildActor, type Actor } from '../src/auth/actor'
import { createSession } from './helpers/auth/sessionStore'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { scheduledTasks, workflows } from '../src/db/schema'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { getScheduledTask, runScheduleNow } from './helpers/integrationTriggerResourceBinding'
import type { BuildScheduleLaunch } from '../src/services/scheduledTasks'
import { createUser } from '../src/services/users'
import { createWorkflow } from '../src/services/workflow'
import { NotFoundError } from '../src/util/errors'
import type { CreateWorkflow, StartTask } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { createIdentityAccessRuntime } from '../src/modules/identity-access/composition'
import {
  createScheduledTaskWithIntegrationTriggerResources as createScheduledTask,
  withIntegrationTriggerResources,
} from './helpers/integrationTriggerResourceBinding'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)
const DEF: CreateWorkflow['definition'] = { $schema_version: 1, inputs: [], nodes: [], edges: [] }
const TRIGGER_DEF: CreateWorkflow['definition'] = {
  $schema_version: 5,
  inputs: [],
  nodes: [
    {
      id: 'trigger-agent',
      kind: 'agent-single',
      agentId: 'agent-never-reached',
      agentName: 'not-needed-before-trigger-preflight',
      promptTemplate: 'Handle {{trigger.webhook.comment_text}}',
    },
  ],
  edges: [],
}
const STUB_TASK_ID = 'task-run-now-stub'
const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const

/** A launch stub that captures its args instead of spawning a real opencode task. */
function stubLaunch(): {
  build: BuildScheduleLaunch
  captured: { owner?: string; schedId?: string; body?: StartTask }
} {
  const captured: { owner?: string; schedId?: string; body?: StartTask } = {}
  // RFC-165 §9b: the closure receives (kind, payload, actor); these run-now
  // tests only exercise workflow rows.
  const build: BuildScheduleLaunch = (owner, schedId) => async (_kind, payload) => {
    captured.owner = owner
    captured.schedId = schedId
    captured.body = payload as unknown as StartTask
    return { id: STUB_TASK_ID }
  }
  return { build, captured }
}

function actorFor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id}`, displayName: 'U', role, status: 'active' },
    source: 'session',
  })
}

describe('RFC-159 T7 — run-now service (pure-launch semantics)', () => {
  let db: DbClient
  let wfId = ''
  let bobId = ''
  let identityAccess: ReturnType<typeof withIntegrationTriggerResources>
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    identityAccess = withIntegrationTriggerResources(db, createIdentityAccessRuntime({ db }))
    const bob = await createUser(db, {
      username: 'bob',
      displayName: 'B',
      role: 'user',
      password: 'longEnoughPassword',
    })
    bobId = bob.id
    const wf = await createWorkflow(db, { name: 'wf', description: '', definition: DEF })
    // This suite specifically exercises later access revocation. Preserve that
    // premise explicitly now that ordinary creates default to private.
    await db.update(workflows).set({ visibility: 'public' }).where(eq(workflows.id, wf.id))
    wfId = wf.id
  })

  function launchBody(id = wfId) {
    return {
      workflowId: id,
      name: 'nightly',
      repoUrl: 'https://git.invalid/placeholder.git',
      ref: 'main',
      inputs: {},
    }
  }

  async function makeSchedule(enabled: boolean): Promise<string> {
    const created = await createScheduledTask(
      db,
      {
        name: 'daily audit',
        launchKind: 'workflow' as const,
        launchPayload: launchBody(),
        scheduleSpec: SPEC,
        enabled,
      },
      { actor: actorFor(bobId) },
    )
    return created.id
  }

  test('fires + returns taskId; stamps scheduled_task_id; decorates name', async () => {
    const id = await makeSchedule(true)
    const { build, captured } = stubLaunch()
    const res = await runScheduleNow(db, id, build, identityAccess)
    expect(res.taskId).toBe(STUB_TASK_ID)
    // Attribution: the launch is closed over the owner + this schedule's id, so the
    // spawned task carries scheduled_task_id and shows up in run history.
    expect(captured.owner).toBe(bobId)
    expect(captured.schedId).toBe(id)
    expect(captured.body?.name).toContain(' · ') // decorateTaskName suffix
  })

  test('does NOT touch next_run_at / last_* / consecutive_failures', async () => {
    const id = await makeSchedule(true)
    const before = await getScheduledTask(db, id)
    const { build } = stubLaunch()
    await runScheduleNow(db, id, build, identityAccess)
    const after = await getScheduledTask(db, id)
    expect(after?.nextRunAt).toBe(before?.nextRunAt ?? null)
    expect(after?.lastRunAt).toBe(before?.lastRunAt ?? null) // still null — never fired on cadence
    expect(after?.lastStatus).toBe(before?.lastStatus ?? null)
    expect(after?.lastTaskId).toBe(before?.lastTaskId ?? null)
    expect(after?.consecutiveFailures).toBe(before?.consecutiveFailures ?? 0)
  })

  test('works on a DISABLED schedule (manual override)', async () => {
    const id = await makeSchedule(false)
    const before = await getScheduledTask(db, id)
    expect(before?.enabled).toBe(false)
    const { build } = stubLaunch()
    const res = await runScheduleNow(db, id, build, identityAccess)
    expect(res.taskId).toBe(STUB_TASK_ID)
    const after = await getScheduledTask(db, id)
    expect(after?.enabled).toBe(false) // still disabled — run-now never flips it
    expect(after?.nextRunAt).toBe(null)
  })

  test('surfaces launch failure (workflow access revoked) + leaves row unchanged', async () => {
    const id = await makeSchedule(true)
    // Revoke: make the workflow private (owned by system, not bob) → gate fails.
    await db.update(workflows).set({ visibility: 'private' }).where(eq(workflows.id, wfId))
    const before = await getScheduledTask(db, id)
    const { build } = stubLaunch()
    await expect(runScheduleNow(db, id, build, identityAccess)).rejects.toThrow()
    const after = await getScheduledTask(db, id)
    expect(after?.consecutiveFailures).toBe(before?.consecutiveFailures ?? 0)
    expect(after?.lastStatus).toBe(before?.lastStatus ?? null)
  })

  test('RFC-292: run-now rechecks the live workflow and never dispatches without webhook context', async () => {
    const id = await makeSchedule(true)
    await db
      .update(workflows)
      .set({ definition: JSON.stringify(TRIGGER_DEF) })
      .where(eq(workflows.id, wfId))
    const { build, captured } = stubLaunch()
    await expect(runScheduleNow(db, id, build, identityAccess)).rejects.toMatchObject({
      code: 'trigger-context-missing',
    })
    expect(captured.body).toBeUndefined()
  })

  test('unknown id → NotFoundError', async () => {
    const { build } = stubLaunch()
    await expect(runScheduleNow(db, 'nope', build, identityAccess)).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('corrupt launch kind is rejected before a payload is dispatched through the wrong launcher', async () => {
    const id = await makeSchedule(true)
    await db
      .update(scheduledTasks)
      .set({
        launchKind: 'corrupt-kind' as never,
        // Before the guard, every unknown kind selected the workgroup schema,
        // then buildScheduleLaunch fell through to the workflow launcher.
        launchPayload: JSON.stringify({
          workgroupName: 'squad',
          name: 'nightly',
          goal: 'g',
          scratch: true,
        }),
      })
      .where(eq(scheduledTasks.id, id))
    const { build } = stubLaunch()
    await expect(runScheduleNow(db, id, build, identityAccess)).rejects.toMatchObject({
      code: 'schedule-kind-invalid',
    })
  })
})

// RFC-359 AC-6：路由门这一档两个引擎各跑一遍。
//
// 唯一需要动的口子是 `buildScheduleLaunch` 桩（免得 run-now 真去 spawn opencode）：
// SQLite 根本来就有这个可选覆盖，**PG 根没有**，本轮把 PG 根补成同形
// （`postgresqlDaemonApplication.ts` 的 `input.buildScheduleLaunch ?? …`）——两个组合根
// 的装配签名对齐，而不是在测试里给 PG 开特例。详见 plan §5bg。
//
// 桩要按用例新建（它记录调用），而覆盖口是**注册期**参数，所以这里注册一个转发闭包，
// 指向 `beforeEach` 每次换掉的那个 `currentLaunch`。
let currentLaunch: BuildScheduleLaunch | undefined
describeEachProviderHttpApplication(
  'RFC-159 T7 — run-now route gate',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    tempPrefix: 'aw-run-now-',
    buildScheduleLaunch:
      (owner, schedId) =>
      async (...args) => {
        if (currentLaunch === undefined) throw new Error('run-now launch stub not installed')
        return currentLaunch(owner, schedId)(...args)
      },
  },
  (scope) => {
    let app: Hono
    let db: ProviderNeutralDatabase
    let bobToken = ''
    let carolToken = ''
    let adminToken = ''
    let schedId = ''

    beforeEach(async () => {
      db = scope.harness.db
      currentLaunch = stubLaunch().build
      app = (await scope.open()).app
      const bob = await createUser(db, {
        username: 'bob',
        displayName: 'B',
        role: 'user',
        password: 'longEnoughPassword',
      })
      const carol = await createUser(db, {
        username: 'carol',
        displayName: 'C',
        role: 'user',
        password: 'longEnoughPassword',
      })
      const admin = await createUser(db, {
        username: 'admin1',
        displayName: 'A',
        role: 'admin',
        password: 'longEnoughPassword',
      })
      const wf = await createWorkflow(
        db,
        { name: 'wf', description: '', definition: DEF },
        { ownerUserId: bob.id, actor: actorFor(bob.id) },
      )
      // RFC-359 AC-6：种子改成中立 insert。原来走的
      // `createScheduledTaskWithIntegrationTriggerResources` 里是
      // `composeSqliteScheduledTaskRuntime` / `composeSqliteResourceCatalog`——bun:sqlite
      // 专有，中立句柄传不进去。而本 describe 的被测对象是 **run-now 路由门**
      // （owner 201 / admin 201 / 陌生人 404 / 坏载荷 422），不是「创建定时任务」那条路；
      // 用服务层去建种子只是顺手，不是判据的一部分。直接落行既中立又更贴题。
      schedId = ulid()
      await db.insert(scheduledTasks).values({
        id: schedId,
        name: 'nightly',
        ownerUserId: bob.id,
        launchKind: 'workflow',
        launchPayload: JSON.stringify({
          workflowId: wf.id,
          name: 'nightly',
          // RFC-165: wire is URL-only; run-now injects a launch stub so the
          // URL is never resolved — any parseable form works (RFC-287 G5: not file://).
          repoUrl: 'https://git.invalid/placeholder.git',
          inputs: {},
        }),
        scheduleSpec: JSON.stringify(SPEC),
        enabled: true,
      })
      bobToken = (await createSession({ db, userId: bob.id })).token
      carolToken = (await createSession({ db, userId: carol.id })).token
      adminToken = (await createSession({ db, userId: admin.id })).token
    })

    async function runNow(token: string): Promise<Response> {
      return app.request(`/api/scheduled-tasks/${schedId}/run-now`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      })
    }

    test('owner → 201 { taskId }', async () => {
      const res = await runNow(bobToken)
      expect(res.status).toBe(201)
      expect(((await res.json()) as { taskId: string }).taskId).toBe(STUB_TASK_ID)
    })

    test('legacy/corrupt launch payload is a structured 422, not a raw Zod 500', async () => {
      await db
        .update(scheduledTasks)
        .set({ launchPayload: '{}' })
        .where(eq(scheduledTasks.id, schedId))
      const res = await runNow(bobToken)
      expect(res.status).toBe(422)
      expect((await res.json()) as { code: string }).toMatchObject({
        code: 'schedule-payload-invalid',
      })
    })

    test('admin → 201', async () => {
      expect((await runNow(adminToken)).status).toBe(201)
    })

    test('stranger → 404 (invisible == missing)', async () => {
      expect((await runNow(carolToken)).status).toBe(404)
    })
  },
)
