// RFC-324 §7 —— 定时任务的授权面。
//
// 定时任务此前只有 owner 一个人能写、`tasks:read:all` 全局能读，中间没有任何东西。
// 本 RFC 让它借用 `resource_grants`（`resource_type='scheduled_task'`）拿到两档授权，
// 但**没有**把它列进 `ACL_RESOURCE_TYPES`：它没有 visibility、没有 builtin、没有
// owner×name 唯一域，也不进配置包或 Intent（design.md §7.1）。
//
// 本文件锁 proposal.md §7 的 AC-9 / AC-10，外加一条实现期才浮出来的边界：
//
//   **改绑启动目标不是内容写。** 定时任务到点是以 **owner 的身份**发起的
//   （`buildInheritedActor(db, row.ownerUserId, 'schedule')`），所以「谁能改
//   launchKind / launchPayload」等于「谁能借 owner 的身份跑任意东西」。这正是
//   `db/schema.ts:1267-1269` 记的设计门 F-9 当初把定时任务与 ACL grants 划开的
//   理由。RFC-324 保留那条结论：write 档只拿到节奏与启停，改绑目标仍归 owner。
//
// 红→绿对：把 routes/scheduledTasks.ts 里 launchKind/launchPayload 的
// `requireScheduleGovern` 分支删掉，「write 档不得改绑目标」立刻红。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { resourceGrants, scheduledTasks } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import type { ResourceGrantLevel } from '@agent-workflow/shared'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

interface Principal {
  id: string
  token: string
}

interface Harness {
  db: DbClient
  app: Hono
  owner: Principal
  reader: Principal
  editor: Principal
  stranger: Principal
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc324-schedule-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const mk = async (username: string): Promise<Principal> => {
    const user = await createUser(db, {
      username,
      displayName: username,
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: user.id })
    return { id: user.id, token }
  }
  return {
    db,
    app,
    owner: await mk('owner'),
    reader: await mk('reader'),
    editor: await mk('editor'),
    stranger: await mk('stranger'),
  }
}

async function req(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

async function codeOf(res: Response): Promise<string> {
  return ((await res.json()) as { code?: string }).code ?? '<no code>'
}

async function seedSchedule(db: DbClient, ownerUserId: string): Promise<string> {
  const id = ulid()
  await db
    .insert(scheduledTasks)
    .values({
      id,
      name: `rfc324-schedule-${id.slice(-6)}`,
      ownerUserId,
      launchKind: 'workflow',
      launchPayload: JSON.stringify({ workflowName: 'nightly', inputs: {} }),
      scheduleSpec: JSON.stringify({ kind: 'interval', every: 6, unit: 'hours' }),
      enabled: true,
      nextRunAt: NOW + 3_600_000,
      consecutiveFailures: 0,
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  return id
}

async function scheduleRow(
  db: DbClient,
  id: string,
): Promise<{ name: string; enabled: boolean; launchPayload: string; aclRevision: number }> {
  const rows = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).all()
  const row = rows[0]
  expect(row, '种子定时任务必须存在，否则本文件零预言力').toBeDefined()
  return {
    name: row!.name,
    enabled: row!.enabled,
    launchPayload: row!.launchPayload,
    aclRevision: row!.aclRevision,
  }
}

async function grant(
  db: DbClient,
  resourceId: string,
  userId: string,
  level: ResourceGrantLevel,
): Promise<void> {
  await db
    .insert(resourceGrants)
    .values({
      resourceType: 'scheduled_task',
      resourceId,
      userId,
      level,
      addedBy: 'seed',
      addedAt: NOW,
    })
    .run()
}

describe('RFC-324 §7 —— 定时任务两档授权', () => {
  test('未授权：私有到底——详情 404，与不存在同形（AC-10）', async () => {
    const h = await buildHarness()
    const id = await seedSchedule(h.db, h.owner.id)
    const res = await req(h.app, h.stranger.token, `/api/scheduled-tasks/${id}`)
    expect(res.status, '定时任务没有 public 这一档；未授权者不该知道它存在').toBe(404)
  })

  test('read 档：看得见；改节奏 / 启停 / 立即运行全部 403 resource-read-only', async () => {
    const h = await buildHarness()
    const id = await seedSchedule(h.db, h.owner.id)
    await grant(h.db, id, h.reader.id, 'read')
    const before = await scheduleRow(h.db, id)

    const detail = await req(h.app, h.reader.token, `/api/scheduled-tasks/${id}`)
    expect(detail.status, '前提不成立：read 档必须看得见调度').toBe(200)

    const toggle = await req(h.app, h.reader.token, `/api/scheduled-tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
    })
    expect(toggle.status).toBe(403)
    expect(await codeOf(toggle)).toBe('resource-read-only')

    const runNow = await req(h.app, h.reader.token, `/api/scheduled-tasks/${id}/run-now`, {
      method: 'POST',
    })
    expect(runNow.status, 'run-now 也是写面').toBe(403)

    expect(await scheduleRow(h.db, id), '被拒后不得留下任何持久写入').toEqual(before)
  })

  test('write 档：能改节奏与启停', async () => {
    const h = await buildHarness()
    const id = await seedSchedule(h.db, h.owner.id)
    await grant(h.db, id, h.editor.id, 'write')

    const res = await req(h.app, h.editor.token, `/api/scheduled-tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        enabled: false,
        scheduleSpec: { kind: 'interval', every: 12, unit: 'hours' },
      }),
    })
    expect([403, 404], 'write 档必须能改节奏与启停').not.toContain(res.status)
    expect(res.status).toBe(200)
    expect((await scheduleRow(h.db, id)).enabled, '放行后的写必须真的落库').toBe(false)
  })

  test('write 档不得改绑启动目标——那等于借 owner 身份跑任意东西（设计门 F-9）', async () => {
    const h = await buildHarness()
    const id = await seedSchedule(h.db, h.owner.id)
    await grant(h.db, id, h.editor.id, 'write')
    const before = await scheduleRow(h.db, id)

    const retarget = await req(h.app, h.editor.token, `/api/scheduled-tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ launchPayload: { workflowName: 'exfiltrate', inputs: {} } }),
    })
    expect(retarget.status).toBe(403)
    expect(await codeOf(retarget)).toBe('resource-govern-owner-only')

    const rename = await req(h.app, h.editor.token, `/api/scheduled-tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'renamed-by-grantee' }),
    })
    expect(rename.status, '改名同样是治理面').toBe(403)

    expect(await scheduleRow(h.db, id), '治理字段被拒后零写入').toEqual(before)
  })

  test('write 档：删除仍 403（治理面）', async () => {
    const h = await buildHarness()
    const id = await seedSchedule(h.db, h.owner.id)
    await grant(h.db, id, h.editor.id, 'write')

    const res = await req(h.app, h.editor.token, `/api/scheduled-tasks/${id}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('resource-govern-owner-only')
    expect((await scheduleRow(h.db, id)).name, '删除被拒后行仍在').toBeTruthy()
  })

  test('owner 照常：改节奏、改绑目标、删除都放行', async () => {
    const h = await buildHarness()
    const id = await seedSchedule(h.db, h.owner.id)

    // 本文件测的是**门**，不是定时任务自己的 patch 语义：放行后是 200 还是该类型
    // 的内容校验 422，属它自己的领域规则，不该由授权测试绑架。
    const retarget = await req(h.app, h.owner.token, `/api/scheduled-tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'renamed-by-owner' }),
    })
    expect([403, 404], 'owner 的治理写必须被门放行').not.toContain(retarget.status)
    if (retarget.status === 200) {
      expect((await scheduleRow(h.db, id)).name).toBe('renamed-by-owner')
    }

    const del = await req(h.app, h.owner.token, `/api/scheduled-tasks/${id}`, { method: 'DELETE' })
    expect([403, 404]).not.toContain(del.status)
  })

  test('/acl 端点：读回 grants 与 canEdit；PUT 全量替换并走 aclRevision CAS', async () => {
    const h = await buildHarness()
    const id = await seedSchedule(h.db, h.owner.id)

    const empty = await req(h.app, h.owner.token, `/api/scheduled-tasks/${id}/acl`)
    expect(empty.status).toBe(200)
    const initial = (await empty.json()) as {
      resourceType: string
      grants: unknown[]
      canManage: boolean
      canEdit: boolean
      aclRevision: number
    }
    expect(initial.resourceType).toBe('scheduled_task')
    expect(initial).not.toHaveProperty('visibility') // 定时任务没有 public 这一档
    expect(initial.grants).toEqual([])
    expect(initial.canManage).toBe(true)

    const put = await req(h.app, h.owner.token, `/api/scheduled-tasks/${id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        grants: [
          { userId: h.reader.id, level: 'read' },
          { userId: h.editor.id, level: 'write' },
        ],
        expectedResourceId: id,
        expectedAclRevision: initial.aclRevision,
      }),
    })
    expect(put.status).toBe(200)
    const saved = (await put.json()) as {
      grants: Array<{ user: { id: string }; level: string }>
      aclRevision: number
    }
    expect(
      saved.grants.map((g) => [g.user.id, g.level]).sort(),
      '两档要各自落库，不能被压成同一档',
    ).toEqual(
      [
        [h.reader.id, 'read'],
        [h.editor.id, 'write'],
      ].sort(),
    )
    expect(saved.aclRevision, '每次成功 PUT 必须自增 revision').toBe(initial.aclRevision + 1)

    // 陈旧 revision 必须被 CAS 拒绝——否则一个停在编辑态的面板能把撤销过的授权写回来。
    const stale = await req(h.app, h.owner.token, `/api/scheduled-tasks/${id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        grants: [],
        expectedResourceId: id,
        expectedAclRevision: initial.aclRevision,
      }),
    })
    expect(stale.status).toBe(409)
    expect(await codeOf(stale)).toBe('acl-revision-conflict')

    // 被授权者读得到自己的档位判定。
    const asEditor = await req(h.app, h.editor.token, `/api/scheduled-tasks/${id}/acl`)
    const editorView = (await asEditor.json()) as { canEdit: boolean; canManage: boolean }
    expect(editorView.canEdit).toBe(true)
    expect(editorView.canManage, '可编辑不含改授权').toBe(false)

    const asReader = await req(h.app, h.reader.token, `/api/scheduled-tasks/${id}/acl`)
    const readerView = (await asReader.json()) as { canEdit: boolean; canManage: boolean }
    expect(readerView.canEdit).toBe(false)
  })

  test('/acl PUT 是治理面：write 档改不动授权名单', async () => {
    const h = await buildHarness()
    const id = await seedSchedule(h.db, h.owner.id)
    await grant(h.db, id, h.editor.id, 'write')

    const res = await req(h.app, h.editor.token, `/api/scheduled-tasks/${id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        grants: [{ userId: h.editor.id, level: 'write' }],
        expectedResourceId: id,
        expectedAclRevision: 0,
      }),
    })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe('resource-govern-owner-only')
  })
})
