// RFC-109 — HTTP layer for workflow re-sync: GET workflow-sync-preview + POST
// sync-workflow. Service logic is locked in rfc109-sync-task-workflow.test.ts;
// this file pins the route-layer concerns:
//   - preview shape + syncable branches (differs / task-active / not-visible)
//   - task-membership gate (visibility middleware) → 403 for outsiders
//   - workflow visibility (RFC-099) → 404-shaped on sync
//   - built-in guard (RFC-104) → 403
//   - version TOCTOU (Codex F5) → 409
//   - success → 200 + task flips pending

import { beforeEach, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'

import { createSession } from './helpers/auth/sessionStore'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { taskCollaborators, tasks, workflows } from '../src/db/schema'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { createUser } from '../src/services/users'
import type { WorkflowSyncPreview } from '@agent-workflow/shared'

const DAEMON_TOKEN = 'a'.repeat(64)

const DEF_A = '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[]}'
const DEF_B =
  '{"$schema_version":4,"inputs":[{"kind":"text","key":"k","label":"k"}],"nodes":[{"id":"n","kind":"input","inputKey":"k"}],"edges":[]}'

interface Harness {
  db: ProviderNeutralDatabase
  app: Hono
  bobToken: string
  carolToken: string
  daveToken: string
  wfId: string
  taskId: string
}

// 一个用例里可能要**两套数据**（见「running task」那条：同一时刻既要一个 failed 任务又要一个
// running 任务）。两套现在共用同一个 provider 库，用户名与固定行 id 的唯一约束会撞，所以每次
// seed 带一个序号后缀；判据本身不看名字也不看 id 字面量，全部从返回值里取。
//
// 注意这里**只 seed 数据、不再各建一个应用**：应用由作用域在 `beforeEach` 里开一次，整条用例
// 共用。原先每套 harness 各 `createInMemoryDb` + `createApp`，一个用例里开两个应用毫无代价；
// 到了共用一个 provider 库，第二次装配是实打实地再起一套运行时，没有必要。
let harnessSeq = 0

async function seedHarness(
  scope: ProviderHttpApplicationScope,
  app: Hono,
  taskStatus: 'failed' | 'running' = 'failed',
): Promise<Harness> {
  const seq = ++harnessSeq
  const db = scope.harness.db
  const bob = await createUser(db, {
    username: `bob-${seq}`,
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const carol = await createUser(db, {
    username: `carol-${seq}`,
    displayName: 'Carol',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const dave = await createUser(db, {
    username: `dave-${seq}`,
    displayName: 'Dave',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const bobToken = (await createSession({ db, userId: bob.id })).token
  const carolToken = (await createSession({ db, userId: carol.id })).token
  const daveToken = (await createSession({ db, userId: dave.id })).token

  const wfId = `wf-109-${seq}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    definition: DEF_A,
    version: 1,
    ownerUserId: bob.id,
    visibility: 'public',
  })
  const taskId = `task-109-${seq}`
  const now = Date.now()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: DEF_A,
    workflowVersion: 1,
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: taskStatus,
    inputs: '{}',
    startedAt: now,
    ownerUserId: bob.id,
  })
  await db.insert(taskCollaborators).values([
    { taskId, userId: bob.id, role: 'owner', addedBy: bob.id, addedAt: now },
    { taskId, userId: carol.id, role: 'collaborator', addedBy: bob.id, addedAt: now },
  ])
  return { db, app, bobToken, carolToken, daveToken, wfId, taskId }
}

async function get(app: Hono, token: string, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${token}` } })
}
async function postJson(app: Hono, token: string, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
async function bump(
  db: ProviderNeutralDatabase,
  wfId: string,
  def: string,
  version: number,
): Promise<void> {
  await db.update(workflows).set({ definition: def, version }).where(eq(workflows.id, wfId))
}

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-109 GET /workflow-sync-preview',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    tempPrefix: 'aw-sync-route-',
  },
  (scope) => {
    let h: Harness
    beforeEach(async () => {
      const { app } = await scope.open()
      h = await seedHarness(scope, app, 'failed')
    })

    test('owner sees a syncable preview with version delta when the workflow advanced', async () => {
      await bump(h.db, h.wfId, DEF_B, 2)
      const r = await get(h.app, h.bobToken, `/api/tasks/${h.taskId}/workflow-sync-preview`)
      expect(r.status).toBe(200)
      const p = (await r.json()) as WorkflowSyncPreview
      expect(p).toMatchObject({
        syncable: true,
        reason: 'ok',
        differs: true,
        currentVersion: 1,
        latestVersion: 2,
        invalid: false,
      })
      expect(p.diff.added.map((a) => a.nodeId)).toEqual(['n'])
    })

    test('collaborator can preview too (task membership)', async () => {
      await bump(h.db, h.wfId, DEF_B, 2)
      const r = await get(h.app, h.carolToken, `/api/tasks/${h.taskId}/workflow-sync-preview`)
      expect(r.status).toBe(200)
    })

    test('running task → syncable:false reason task-active', async () => {
      const hh = await seedHarness(scope, h.app, 'running')
      await bump(hh.db, hh.wfId, DEF_B, 2)
      const r = await get(hh.app, hh.bobToken, `/api/tasks/${hh.taskId}/workflow-sync-preview`)
      const p = (await r.json()) as WorkflowSyncPreview
      expect(p.syncable).toBe(false)
      expect(p.reason).toBe('task-active')
    })

    test('identical definition (version bumped) → differs:false (banner hidden)', async () => {
      await bump(h.db, h.wfId, DEF_A, 2) // same content, new version
      const r = await get(h.app, h.bobToken, `/api/tasks/${h.taskId}/workflow-sync-preview`)
      const p = (await r.json()) as WorkflowSyncPreview
      expect(p.syncable).toBe(true)
      expect(p.differs).toBe(false)
    })

    // RFC-285 B1：外人不再拿 403（那会确认任务存在）——与不存在同形 404。
    test('outsider → 404 task-not-found（B1 同形；旧 403 task-not-visible 已退役）', async () => {
      const r = await get(h.app, h.daveToken, `/api/tasks/${h.taskId}/workflow-sync-preview`)
      expect(r.status).toBe(404)
      expect(((await r.json()) as { code: string }).code).toBe('task-not-found')
    })

    test('built-in workflow → syncable:false reason builtin-workflow (Codex F4: banner hidden)', async () => {
      await h.db.update(workflows).set({ builtin: true }).where(eq(workflows.id, h.wfId))
      await bump(h.db, h.wfId, DEF_B, 2)
      const r = await get(h.app, h.bobToken, `/api/tasks/${h.taskId}/workflow-sync-preview`)
      const p = (await r.json()) as WorkflowSyncPreview
      expect(p.syncable).toBe(false)
      expect(p.reason).toBe('builtin-workflow')
    })
  },
)

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-109 POST /sync-workflow',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    tempPrefix: 'aw-sync-route-',
  },
  (scope) => {
    let h: Harness
    beforeEach(async () => {
      const { app } = await scope.open()
      h = await seedHarness(scope, app, 'failed')
    })

    test('owner sync success → 200 + task flips pending', async () => {
      await bump(h.db, h.wfId, DEF_B, 2)
      const r = await postJson(h.app, h.bobToken, `/api/tasks/${h.taskId}/sync-workflow`, {
        expectedVersion: 2,
      })
      expect(r.status, await r.clone().text()).toBe(200)
      const t = (await r.json()) as { status: string; workflowVersion: number }
      expect(t.status).toBe('pending')
      expect(t.workflowVersion).toBe(2)
    })

    test('stale expectedVersion → 409 workflow-sync-preview-stale', async () => {
      await bump(h.db, h.wfId, DEF_B, 2)
      const r = await postJson(h.app, h.bobToken, `/api/tasks/${h.taskId}/sync-workflow`, {
        expectedVersion: 1,
      })
      expect(r.status).toBe(409)
      expect(((await r.json()) as { code: string }).code).toBe('workflow-sync-preview-stale')
    })

    test('missing expectedVersion → 422', async () => {
      await bump(h.db, h.wfId, DEF_B, 2)
      const r = await postJson(h.app, h.bobToken, `/api/tasks/${h.taskId}/sync-workflow`, {})
      expect(r.status).toBe(422)
    })

    test('built-in workflow → 403 (RFC-104)', async () => {
      await h.db.update(workflows).set({ builtin: true }).where(eq(workflows.id, h.wfId))
      await bump(h.db, h.wfId, DEF_B, 2)
      const r = await postJson(h.app, h.bobToken, `/api/tasks/${h.taskId}/sync-workflow`, {
        expectedVersion: 2,
      })
      expect(r.status).toBe(403)
    })

    // RFC-285 B1：写入口的外人同样先撞可见性门 → 404 同形（成员制 403 只对
    // 「看得见但非成员」的角色成立，外人连存在性都不该探到）。
    test('outsider → 404 task-not-found（B1：可见性门先于成员门）', async () => {
      await bump(h.db, h.wfId, DEF_B, 2)
      const r = await postJson(h.app, h.daveToken, `/api/tasks/${h.taskId}/sync-workflow`, {
        expectedVersion: 2,
      })
      expect(r.status).toBe(404)
      expect(((await r.json()) as { code: string }).code).toBe('task-not-found')
    })
  },
)
