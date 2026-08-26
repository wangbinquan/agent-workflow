// RFC-330 T6～T8 —— 工具注册（第 14 类）与岗位模版（第 15 类）的行级判据矩阵。
//
// 事故形态（proposal §1）：两张表自 RFC-310 起只有一列 `owner_user_id` 做记录，
// 不参与任何判定——持有 `digital-employees:update` 的任何账户都能改 / 校验 / 发布
// 别人的工具与模版，`:archive` 能退休别人的工具，也不存在私有工具。
//
// 本文件锁修复后的语义（proposal AC-2 / AC-3 / AC-4 / AC-6）。**红→绿对**：把
// `routes/digitalEmployees.ts` 里的 `requireEditableTool` / `requireGovernableTool` /
// `requireEditableJobTemplate` / `loadVisibleTool` 拆掉，403/404 组必须立刻红。
//
// 用例形状与 rfc317-employee-definition-acl 同口径：行直接种进表（不注册类型包，
// 种出的是「存在但无可执行修订」的半成品），正向用例只断言「写门放行」——放行之后
// 领域校验会因半成品内容各自失败，那不是本文件绑架的边界。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor } from '../src/auth/actor'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  employeeJobTemplates,
  employeeToolRegistrations,
  resourceGrants,
  users,
} from '../src/db/schema'
import { createApp } from '../src/server'
import { projectVisibleRowsWithAccess } from '../src/services/resourceAcl'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ROUTE_FILE = resolve(import.meta.dir, '..', 'src', 'routes', 'digitalEmployees.ts')
const NOW = 1_700_000_000_000
const TYPE_REF = 'development@10'
const WORK_ITEM = 'analyze-implement'

interface Actor {
  id: string
  token: string
}

interface Harness {
  db: DbClient
  app: Hono
  owner: Actor
  reader: Actor
  writer: Actor
  stranger: Actor
  admin: Actor
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc330-matrix-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const mkUser = async (username: string, role: 'admin' | 'user'): Promise<Actor> => {
    const user = await createUser(db, {
      username,
      displayName: username,
      role,
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: user.id })
    return { id: user.id, token }
  }
  return {
    db,
    app,
    owner: await mkUser('t-owner', 'user'),
    reader: await mkUser('t-reader', 'user'),
    writer: await mkUser('t-writer', 'user'),
    stranger: await mkUser('t-stranger', 'user'),
    admin: await mkUser('t-root', 'admin'),
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

async function seedTool(
  db: DbClient,
  ownerUserId: string,
  visibility: 'private' | 'public',
  name = 'Analyzer',
): Promise<string> {
  const id = ulid()
  await db
    .insert(employeeToolRegistrations)
    .values({
      id,
      typeId: 'development',
      typeRevision: 10,
      workItemRef: WORK_ITEM,
      draftJson: JSON.stringify({
        content: { displayName: name },
        validationReceipt: { status: 'invalid', checks: [] },
      }),
      publishedRevision: null,
      ownerUserId,
      name,
      visibility,
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
      retiredAt: null,
    })
    .run()
  return id
}

async function seedTemplate(
  db: DbClient,
  ownerUserId: string,
  visibility: 'private' | 'public',
  name = 'Reviewer',
): Promise<string> {
  const id = ulid()
  await db
    .insert(employeeJobTemplates)
    .values({
      id,
      typeId: 'development',
      typeRevision: 10,
      name,
      draftJson: '{}',
      publishedRevision: null,
      ownerUserId,
      visibility,
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
    })
    .run()
  return id
}

async function grant(
  db: DbClient,
  type: 'employee_tool' | 'employee_job_template',
  resourceId: string,
  userId: string,
  level: 'read' | 'write',
): Promise<void> {
  await db
    .insert(resourceGrants)
    .values({ resourceType: type, resourceId, userId, level, addedBy: 'seed', addedAt: NOW })
    .run()
}

async function toolSnapshot(db: DbClient, id: string): Promise<unknown> {
  return (
    await db
      .select()
      .from(employeeToolRegistrations)
      .where(eq(employeeToolRegistrations.id, id))
      .all()
  )[0]
}

async function templateSnapshot(db: DbClient, id: string): Promise<unknown> {
  return (
    await db.select().from(employeeJobTemplates).where(eq(employeeJobTemplates.id, id)).all()
  )[0]
}

const TOOL = (id: string): string =>
  `/api/digital-employee-types/${TYPE_REF}/work-items/${WORK_ITEM}/tools/${id}`
const TOOL_BODY = (displayName: string): string =>
  JSON.stringify({
    displayName,
    description: 'x',
    roleRef: 'primary',
    implementation: { kind: 'agent', agentRef: { id: 'agent-1', revision: 1 } },
  })
const TEMPLATE = (id: string): string => `/api/digital-employee-job-templates/${id}`

async function code(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { code?: string }).code
}

const GATE_CODES = new Set([
  'employee-tool-not-found',
  'employee-job-template-not-found',
  'resource-read-only',
  'resource-govern-owner-only',
  'resource-rename-owner-only',
  'forbidden',
])

describe('RFC-330 —— 工具注册的可见性与写门', () => {
  test('陌生人读别人的 private 工具（authoring body）⇒ 404，与不存在同形', async () => {
    const h = await buildHarness()
    const id = await seedTool(h.db, h.owner.id, 'private')
    const invisible = await req(h.app, h.stranger.token, TOOL(id))
    const missing = await req(h.app, h.stranger.token, TOOL(ulid()))
    expect(invisible.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await code(invisible)).toBe('employee-tool-not-found')
    expect(await invisible.text()).toBe(await missing.text())
  })

  test('public 工具对陌生人通过可见性判据；private 工具对 read 授权者亦可见', async () => {
    const h = await buildHarness()
    const pub = await seedTool(h.db, h.owner.id, 'public')
    const priv = await seedTool(h.db, h.owner.id, 'private')
    await grant(h.db, 'employee_tool', priv, h.reader.id, 'read')
    for (const [who, id] of [
      ['stranger', pub],
      ['reader', priv],
    ] as const) {
      const res = await req(h.app, h[who].token, TOOL(id))
      expect(await code(res), `${who} 必须通过可见性判据`).not.toBe('employee-tool-not-found')
    }
  })

  test('read 档 / 未授权公开读者：PUT / validate / publish ⇒ 403 resource-read-only；retire ⇒ 403 govern；零写入', async () => {
    const h = await buildHarness()
    const priv = await seedTool(h.db, h.owner.id, 'private')
    await grant(h.db, 'employee_tool', priv, h.reader.id, 'read')
    const pub = await seedTool(h.db, h.owner.id, 'public')
    for (const [who, id] of [
      ['reader', priv],
      ['stranger', pub],
    ] as const) {
      const before = await toolSnapshot(h.db, id)
      for (const [path, init] of [
        [TOOL(id), { method: 'PUT', body: TOOL_BODY('Analyzer') }],
        [`${TOOL(id)}/validate`, { method: 'POST' }],
        [`${TOOL(id)}/publish`, { method: 'POST' }],
      ] as const) {
        const res = await req(h.app, h[who].token, path, init)
        expect(res.status, `${who} ${init.method} ${path}`).toBe(403)
        expect(await code(res)).toBe('resource-read-only')
      }
      const retire = await req(h.app, h[who].token, `${TOOL(id)}/retire`, { method: 'POST' })
      expect(retire.status).toBe(403)
      expect(await code(retire)).toBe('resource-govern-owner-only')
      expect(await toolSnapshot(h.db, id), `${who}：被拒后不得留下持久写入`).toEqual(before)
    }
  })

  test('write 档：PUT / validate / publish 放行；改 displayName ⇒ 403 rename；retire / ACL PUT ⇒ 403 govern', async () => {
    const h = await buildHarness()
    const id = await seedTool(h.db, h.owner.id, 'private')
    await grant(h.db, 'employee_tool', id, h.writer.id, 'write')
    for (const [path, init] of [
      [TOOL(id), { method: 'PUT', body: TOOL_BODY('Analyzer') }],
      [`${TOOL(id)}/validate`, { method: 'POST' }],
      [`${TOOL(id)}/publish`, { method: 'POST' }],
    ] as const) {
      const res = await req(h.app, h.writer.token, path, init)
      expect(GATE_CODES.has((await code(res)) ?? ''), `writer 必须通过写门：${path}`).toBe(false)
    }
    const before = await toolSnapshot(h.db, id)
    const rename = await req(h.app, h.writer.token, TOOL(id), {
      method: 'PUT',
      body: TOOL_BODY('Renamed by editor'),
    })
    expect(rename.status).toBe(403)
    expect(await code(rename)).toBe('resource-rename-owner-only')
    expect(await toolSnapshot(h.db, id)).toEqual(before)
    const retire = await req(h.app, h.writer.token, `${TOOL(id)}/retire`, { method: 'POST' })
    expect(await code(retire)).toBe('resource-govern-owner-only')
    const acl = await req(h.app, h.writer.token, `/api/digital-employee-tools/${id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: id,
        expectedAclRevision: 0,
      }),
    })
    expect(acl.status).toBe(403)
    expect(await code(acl)).toBe('resource-govern-owner-only')
  })

  test('owner 与 admin（bypass）被写门放行，retire 亦放行', async () => {
    const h = await buildHarness()
    for (const who of ['owner', 'admin'] as const) {
      const id = await seedTool(h.db, h.owner.id, 'private')
      const put = await req(h.app, h[who].token, TOOL(id), {
        method: 'PUT',
        body: TOOL_BODY('Renamed by owner'),
      })
      expect(GATE_CODES.has((await code(put)) ?? ''), `${who} PUT`).toBe(false)
      const retire = await req(h.app, h[who].token, `${TOOL(id)}/retire`, { method: 'POST' })
      expect(GATE_CODES.has((await code(retire)) ?? ''), `${who} retire`).toBe(false)
    }
  })

  test('/acl：GET 对所有可见者开放（read 档可读），PUT 只有 owner / bypass；陌生人 404', async () => {
    const h = await buildHarness()
    const id = await seedTool(h.db, h.owner.id, 'private')
    await grant(h.db, 'employee_tool', id, h.reader.id, 'read')
    const base = `/api/digital-employee-tools/${id}/acl`
    const readerGet = await req(h.app, h.reader.token, base)
    expect(readerGet.status).toBe(200)
    expect((await readerGet.json()) as { resourceType: string }).toMatchObject({
      resourceType: 'employee_tool',
      resourceId: id,
      visibility: 'private',
    })
    const readerPut = await req(h.app, h.reader.token, base, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: id,
        expectedAclRevision: 0,
      }),
    })
    expect(readerPut.status).toBe(403)
    const strangerGet = await req(h.app, h.stranger.token, base)
    expect(strangerGet.status).toBe(404)
    expect(await code(strangerGet)).toBe('employee-tool-not-found')
    const ownerPut = await req(h.app, h.owner.token, base, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        grants: [{ userId: h.writer.id, level: 'write' }],
        expectedResourceId: id,
        expectedAclRevision: 0,
      }),
    })
    expect(ownerPut.status).toBe(200)
    expect((await ownerPut.json()) as { aclRevision: number }).toMatchObject({
      aclRevision: 1,
      visibility: 'public',
    })
    // 设 public 后陌生人可见。
    expect((await req(h.app, h.stranger.token, base)).status).toBe(200)
  })
})

describe('RFC-330 —— 平台内置工具没有 ACL 行（D9）', () => {
  test('GET 与 PUT /acl 对 owner / admin 都是 404（与不存在同形）', async () => {
    const h = await buildHarness()
    // 平台目录工具的 id 前缀来自 composeDigitalEmployeeBuiltinToolCatalog；模块的
    // getToolAcl 对该前缀投影 builtin，挂载器的 load 对 builtin 返回 null。
    const base =
      '/api/digital-employee-tools/platform:employee-tool:development:10:analyze:agent-1/acl'
    for (const who of ['owner', 'admin'] as const) {
      const get = await req(h.app, h[who].token, base)
      expect(get.status, `${who} GET`).toBe(404)
      expect(await code(get)).toBe('employee-tool-not-found')
      const put = await req(h.app, h[who].token, base, {
        method: 'PUT',
        body: JSON.stringify({
          visibility: 'private',
          expectedResourceId: 'x',
          expectedAclRevision: 0,
        }),
      })
      expect(put.status, `${who} PUT`).toBe(404)
    }
  })
})

describe('RFC-330 —— 岗位模版的可见性与写门', () => {
  test('陌生人对 private 模版的 PUT / publish / acl ⇒ 404 与不存在同形，零写入', async () => {
    const h = await buildHarness()
    const id = await seedTemplate(h.db, h.owner.id, 'private')
    const before = await templateSnapshot(h.db, id)
    for (const [path, init, expectedCode] of [
      [
        TEMPLATE(id),
        { method: 'PUT', body: JSON.stringify({ name: 'Reviewer' }) },
        'employee-job-template-not-found',
      ],
      [`${TEMPLATE(id)}/publish`, { method: 'POST' }, 'employee-job-template-not-found'],
      // mountAclEndpoints 走 notFoundCode：与其它模版路由同一个连字符码（D14）。
      [`${TEMPLATE(id)}/acl`, {}, 'employee-job-template-not-found'],
    ] as const) {
      const res = await req(h.app, h.stranger.token, path, init)
      expect(res.status, `${init.method ?? 'GET'} ${path}`).toBe(404)
      expect(await code(res)).toBe(expectedCode)
    }
    expect(await templateSnapshot(h.db, id)).toEqual(before)
  })

  test('read 档：PUT / publish ⇒ 403 resource-read-only；write 档：放行但改名 ⇒ 403 rename', async () => {
    const h = await buildHarness()
    const id = await seedTemplate(h.db, h.owner.id, 'private')
    await grant(h.db, 'employee_job_template', id, h.reader.id, 'read')
    await grant(h.db, 'employee_job_template', id, h.writer.id, 'write')
    for (const [path, init] of [
      [TEMPLATE(id), { method: 'PUT', body: JSON.stringify({ name: 'Reviewer' }) }],
      [`${TEMPLATE(id)}/publish`, { method: 'POST' }],
    ] as const) {
      const denied = await req(h.app, h.reader.token, path, init)
      expect(denied.status).toBe(403)
      expect(await code(denied)).toBe('resource-read-only')
      const allowed = await req(h.app, h.writer.token, path, init)
      expect(GATE_CODES.has((await code(allowed)) ?? ''), `writer ${path}`).toBe(false)
    }
    const rename = await req(h.app, h.writer.token, TEMPLATE(id), {
      method: 'PUT',
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(rename.status).toBe(403)
    expect(await code(rename)).toBe('resource-rename-owner-only')
  })

  test('/acl 四条路由挂在 mountAclEndpoints 上：owner 200 / CAS 409 / 陌生人 404', async () => {
    const h = await buildHarness()
    const id = await seedTemplate(h.db, h.owner.id, 'private')
    const base = `${TEMPLATE(id)}/acl`
    const get = await req(h.app, h.owner.token, base)
    expect(get.status).toBe(200)
    expect((await get.json()) as { resourceType: string }).toMatchObject({
      resourceType: 'employee_job_template',
      aclRevision: 0,
    })
    const stale = await req(h.app, h.owner.token, base, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'public',
        expectedResourceId: id,
        expectedAclRevision: 7,
      }),
    })
    expect(stale.status).toBe(409)
    expect((await req(h.app, h.stranger.token, base)).status).toBe(404)
  })
})

describe('RFC-330 —— 列表按可见性过滤并带档位（kernel 单元 + 接线断言）', () => {
  test('projectVisibleRowsWithAccess：own / write / read / public-read / 不可见剔除 / bypass 恒 own', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const mk = async (id: string, role: 'admin' | 'user') => {
      // 直接种 users 行（固定 id），grants 的外键要指向它。
      await db
        .insert(users)
        .values({
          id,
          username: id,
          displayName: id,
          role,
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        })
        .run()
      return buildActor({
        user: { id, username: id, displayName: id, role, status: 'active' },
        source: 'session',
      })
    }
    const owner = await mk('k-owner', 'user')
    const viewer = await mk('k-viewer', 'user')
    const admin = await mk('k-admin', 'admin')
    const mine = await seedTool(db, owner.user.id, 'private', 'mine')
    const shared = await seedTool(db, owner.user.id, 'private', 'shared')
    const editable = await seedTool(db, owner.user.id, 'private', 'editable')
    const open = await seedTool(db, owner.user.id, 'public', 'open')
    const hidden = await seedTool(db, owner.user.id, 'private', 'hidden')
    await grant(db, 'employee_tool', shared, viewer.user.id, 'read')
    await grant(db, 'employee_tool', editable, viewer.user.id, 'write')
    const rows = await db.select().from(employeeToolRegistrations).all()
    const byId = (out: Array<{ id: string; access: string }>): Record<string, string> =>
      Object.fromEntries(out.map((row) => [row.id, row.access]))

    expect(byId(await projectVisibleRowsWithAccess(db, viewer, 'employee_tool', rows))).toEqual({
      [shared]: 'read',
      [editable]: 'write',
      [open]: 'read',
    })
    expect(byId(await projectVisibleRowsWithAccess(db, owner, 'employee_tool', rows))).toEqual({
      [mine]: 'own',
      [shared]: 'own',
      [editable]: 'own',
      [open]: 'own',
      [hidden]: 'own',
    })
    const asAdmin = byId(await projectVisibleRowsWithAccess(db, admin, 'employee_tool', rows))
    expect(Object.keys(asAdmin).length).toBe(5)
    expect(new Set(Object.values(asAdmin))).toEqual(new Set(['own']))
  })

  test('接线：工具 / 模版 / 员工三张列表都经 projectVisibleRowsWithAccess 投影', () => {
    const source = readFileSync(ROUTE_FILE, 'utf8')
    const occurrences = source.split('projectVisibleRowsWithAccess(').length - 1
    // 工具列表（自定义半边）+ 模版列表 + visibleEmployees 助手（三个员工列表共用）。
    expect(occurrences).toBeGreaterThanOrEqual(3)
    expect(source).toMatch(
      /'employee_tool',\s*\n?\s*items\.filter\(\(tool\) => tool\.origin !== 'platform'\)/,
    )
    expect(source).toContain("'employee_job_template',\n          module.queries.listJobTemplates(")
  })
})
