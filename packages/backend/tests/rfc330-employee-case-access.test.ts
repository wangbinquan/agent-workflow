// RFC-330 T9～T11 —— 数字员工案例的归属与成员制（D19 / D20），与编排任务完整同形。
//
// 事故形态（proposal §1）：`GET /api/employee-cases/:id` / resume / terminate /
// 策略升级全是权限点级——持有 `digital-employees:read` 的任何账户能读任何案例，
// 持有 `development-missions:*` 的任何账户能恢复 / 终止别人的案例；没有成员制。
//
// 本文件锁修复后的语义（proposal AC-8～AC-11）：
//   可见   = 发起人 ∪ 成员（observer / collaborator）∪ tasks:read:all ∪ bypass，否则 404 同形
//   操作   = 发起人 ∪ collaborator ∪ bypass；observer 与 tasks:read:all ⇒ 403
//            `employee-case-observer-read-only`
//   成员   = GET 对可见者开放；PUT 仅 owner / bypass；重复成员 last-wins；转移后前任降为
//            collaborator；WS 帧受众 = before ∪ after
//
// **红→绿对**：把 `routes/digitalEmployees.ts` 里的 `loadVisibleCase` / `requireCaseOperator`
// 拆掉，404/403 组必须立刻红。行直接种进 `employee_cases`（无上下文 / 轮次），所以正向
// 用例只断言「门放行」（响应码不是门的码），放行后的投影 / 状态机失败不归本文件管。

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { employeeCaseMembers, employeeCases } from '../src/db/schema'
import { createApp } from '../src/server'
import { buildActor } from '../src/auth/actor'
import { canOperateCase, canViewCase } from '../src/services/employeeCaseMembers'
import { createUser } from '../src/services/users'
import {
  TASKS_LIST_CHANNEL,
  tasksListBroadcaster,
  type TasksListBroadcastContext,
} from '../src/ws/broadcaster'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

interface Actor {
  id: string
  token: string
}

interface Harness {
  db: DbClient
  app: Hono
  owner: Actor
  collaborator: Actor
  observer: Actor
  stranger: Actor
  admin: Actor
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc330-case-config-never-used.json',
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
    owner: await mkUser('c-owner', 'user'),
    collaborator: await mkUser('c-collab', 'user'),
    observer: await mkUser('c-observer', 'user'),
    stranger: await mkUser('c-stranger', 'user'),
    admin: await mkUser('c-root', 'admin'),
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

async function seedCase(
  db: DbClient,
  ownerUserId: string | null,
  state: 'active' | 'blocked' = 'active',
): Promise<string> {
  const id = ulid()
  await db
    .insert(employeeCases)
    .values({
      id,
      name: `case-${id.slice(-6)}`,
      employeeId: 'employee-1',
      employeeRevision: 1,
      typeId: 'development',
      typeRevision: 10,
      primaryContextId: `context-${id}`,
      executionPolicyRevision: 1,
      ownerUserId,
      state,
      revision: 1,
      writerGeneration: 1,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run()
  return id
}

async function seedMember(
  db: DbClient,
  caseId: string,
  userId: string,
  role: 'collaborator' | 'observer',
): Promise<void> {
  await db
    .insert(employeeCaseMembers)
    .values({ caseId, userId, role, addedBy: 'seed', addedAt: NOW })
    .run()
}

async function code(res: Response): Promise<string | undefined> {
  return ((await res.clone().json()) as { code?: string }).code
}

const GATE_CODES = new Set([
  'employee-case-not-found',
  'employee-case-observer-read-only',
  'forbidden',
])
const CASE = (id: string): string => `/api/employee-cases/${id}`

describe('RFC-330 D19 —— 案例可见性', () => {
  test('陌生人 GET 别人的案例 ⇒ 404，与不存在同形（逐字一致）', async () => {
    const h = await buildHarness()
    const id = await seedCase(h.db, h.owner.id)
    const invisible = await req(h.app, h.stranger.token, CASE(id))
    const missing = await req(h.app, h.stranger.token, CASE(ulid()))
    expect(invisible.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(await code(invisible)).toBe('employee-case-not-found')
    expect(await invisible.text()).toBe(await missing.text())
  })

  test('发起人 / observer / collaborator / tasks:read:all（admin）都通过可见性判据', async () => {
    const h = await buildHarness()
    const id = await seedCase(h.db, h.owner.id)
    await seedMember(h.db, id, h.observer.id, 'observer')
    await seedMember(h.db, id, h.collaborator.id, 'collaborator')
    for (const who of ['owner', 'observer', 'collaborator', 'admin'] as const) {
      const res = await req(h.app, h[who].token, CASE(id))
      expect(await code(res), `${who} 必须通过可见性判据`).not.toBe('employee-case-not-found')
    }
  })

  test('无 owner（系统发起）的案例只对 tasks:read:all / bypass 可见', async () => {
    const h = await buildHarness()
    const id = await seedCase(h.db, null)
    expect((await req(h.app, h.stranger.token, CASE(id))).status).toBe(404)
    expect(await code(await req(h.app, h.admin.token, CASE(id)))).not.toBe(
      'employee-case-not-found',
    )
  })
})

describe('RFC-330 D19 —— 案例操作面', () => {
  const OPERATIONS = (id: string) =>
    [
      [`${CASE(id)}/resume`, { method: 'POST' }],
      [
        `${CASE(id)}/terminate`,
        { method: 'POST', body: JSON.stringify({ terminalKind: 'canceled' }) },
      ],
      [
        `${CASE(id)}/policy-upgrade-preview`,
        { method: 'POST', body: JSON.stringify({ targetPolicyRevision: 1 }) },
      ],
    ] as const

  test('observer 与 tasks:read:all（非 bypass）⇒ 403 employee-case-observer-read-only；陌生人 ⇒ 404；零状态变化', async () => {
    const h = await buildHarness()
    const id = await seedCase(h.db, h.owner.id, 'blocked')
    await seedMember(h.db, id, h.observer.id, 'observer')
    const before = await h.db.select().from(employeeCases).where(eq(employeeCases.id, id)).get()
    for (const [path, init] of OPERATIONS(id)) {
      const observer = await req(h.app, h.observer.token, path, init)
      expect(observer.status, `observer ${path}`).toBe(403)
      expect(await code(observer)).toBe('employee-case-observer-read-only')
      const stranger = await req(h.app, h.stranger.token, path, init)
      expect(stranger.status, `stranger ${path}`).toBe(404)
      expect(await code(stranger)).toBe('employee-case-not-found')
    }
    expect(await h.db.select().from(employeeCases).where(eq(employeeCases.id, id)).get()).toEqual(
      before,
    )
  })

  test('发起人 / collaborator / bypass 通过操作门', async () => {
    const h = await buildHarness()
    const id = await seedCase(h.db, h.owner.id, 'blocked')
    await seedMember(h.db, id, h.collaborator.id, 'collaborator')
    for (const who of ['owner', 'collaborator', 'admin'] as const) {
      for (const [path, init] of OPERATIONS(id)) {
        const res = await req(h.app, h[who].token, path, init)
        expect(GATE_CODES.has((await code(res)) ?? ''), `${who} ${path} 必须通过操作门`).toBe(false)
      }
    }
  })

  test('policy-upgrade-apply 从 token 解出案例后同样过操作门', async () => {
    const h = await buildHarness()
    const id = await seedCase(h.db, h.owner.id)
    await seedMember(h.db, id, h.observer.id, 'observer')
    const token = Buffer.from(JSON.stringify({ caseId: id, garbage: true })).toString('base64url')
    const observer = await req(
      h.app,
      h.observer.token,
      '/api/employee-cases/policy-upgrade-apply',
      {
        method: 'POST',
        body: JSON.stringify({ previewToken: token }),
      },
    )
    expect(observer.status).toBe(403)
    expect(await code(observer)).toBe('employee-case-observer-read-only')
    const stranger = await req(
      h.app,
      h.stranger.token,
      '/api/employee-cases/policy-upgrade-apply',
      {
        method: 'POST',
        body: JSON.stringify({ previewToken: token }),
      },
    )
    expect(stranger.status).toBe(404)
    const malformed = await req(h.app, h.owner.token, '/api/employee-cases/policy-upgrade-apply', {
      method: 'POST',
      body: JSON.stringify({ previewToken: 'not-base64-json' }),
    })
    expect(await code(malformed)).toBe('employee-policy-preview-invalid')
  })
})

describe('RFC-330 D19/D20 —— 案例成员面', () => {
  const MEMBERS = (id: string): string => `${CASE(id)}/members`

  test('GET：可见者拿到 caseId 变体的成员 wire（canManage / canOperate 按角色）', async () => {
    const h = await buildHarness()
    const id = await seedCase(h.db, h.owner.id)
    await seedMember(h.db, id, h.observer.id, 'observer')
    await seedMember(h.db, id, h.collaborator.id, 'collaborator')
    const expectations = {
      owner: { canManage: true, canOperate: true },
      collaborator: { canManage: false, canOperate: true },
      observer: { canManage: false, canOperate: false },
      admin: { canManage: true, canOperate: true },
    } as const
    for (const who of ['owner', 'collaborator', 'observer', 'admin'] as const) {
      const res = await req(h.app, h[who].token, MEMBERS(id))
      expect(res.status, who).toBe(200)
      const body = (await res.json()) as {
        caseId: string
        ownerUserId: string | null
        members: Array<{ user: { id: string }; role: string }>
        canManage: boolean
        canOperate: boolean
      }
      expect(body.caseId).toBe(id)
      expect(body.ownerUserId).toBe(h.owner.id)
      expect(body.members.map((m) => [m.user.id, m.role]).sort()).toEqual(
        [
          [h.collaborator.id, 'collaborator'],
          [h.observer.id, 'observer'],
        ].sort(),
      )
      expect({ canManage: body.canManage, canOperate: body.canOperate }, who).toEqual(
        expectations[who],
      )
    }
    expect((await req(h.app, h.stranger.token, MEMBERS(id))).status).toBe(404)
  })

  test('PUT：仅 owner / bypass；collaborator ⇒ 403；非活跃 / 系统用户 ⇒ 422；重复成员 last-wins', async () => {
    const h = await buildHarness()
    const id = await seedCase(h.db, h.owner.id)
    await seedMember(h.db, id, h.collaborator.id, 'collaborator')
    const denied = await req(h.app, h.collaborator.token, MEMBERS(id), {
      method: 'PUT',
      body: JSON.stringify({ members: [] }),
    })
    expect(denied.status).toBe(403)
    expect(await code(denied)).toBe('forbidden')

    const invalid = await req(h.app, h.owner.token, MEMBERS(id), {
      method: 'PUT',
      body: JSON.stringify({ members: [{ userId: '__system__', role: 'observer' }] }),
    })
    expect(invalid.status).toBe(422)
    expect(await code(invalid)).toBe('members-user-invalid')

    const replaced = await req(h.app, h.owner.token, MEMBERS(id), {
      method: 'PUT',
      body: JSON.stringify({
        members: [
          { userId: h.observer.id, role: 'collaborator' },
          { userId: h.observer.id, role: 'observer' },
        ],
      }),
    })
    expect(replaced.status).toBe(200)
    const body = (await replaced.json()) as {
      members: Array<{ user: { id: string }; role: string }>
    }
    expect(body.members).toEqual([expect.objectContaining({ role: 'observer' })])
    expect(body.members[0]?.user.id).toBe(h.observer.id)
    // 旧 collaborator 被全量替换掉；observer 只剩最后一条。
    expect(
      (
        await h.db
          .select()
          .from(employeeCaseMembers)
          .where(eq(employeeCaseMembers.caseId, id))
          .all()
      ).map((row) => [row.userId, row.role]),
    ).toEqual([[h.observer.id, 'observer']])
  })

  test('D20 转移：新 owner 成为 owner、前任降为 collaborator（同一事务）；owner 永不进成员行', async () => {
    const h = await buildHarness()
    const id = await seedCase(h.db, h.owner.id)
    const seen: TasksListBroadcastContext[] = []
    const unsubscribe = tasksListBroadcaster.subscribe(TASKS_LIST_CHANNEL, (message, context) => {
      if (message.type === 'employee-case.members.changed' && context !== undefined) {
        seen.push(context)
      }
    })
    try {
      const res = await req(h.app, h.owner.token, MEMBERS(id), {
        method: 'PUT',
        body: JSON.stringify({ ownerUserId: h.collaborator.id }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ownerUserId: string | null
        members: Array<{ user: { id: string }; role: string }>
        canManage: boolean
      }
      expect(body.ownerUserId).toBe(h.collaborator.id)
      expect(body.members.map((m) => [m.user.id, m.role])).toEqual([[h.owner.id, 'collaborator']])
      // 前任仍能操作但不再能管理成员。
      expect(body.canManage).toBe(false)
      expect(
        await h.db
          .select({ ownerUserId: employeeCases.ownerUserId, revision: employeeCases.revision })
          .from(employeeCases)
          .where(eq(employeeCases.id, id))
          .get(),
      ).toEqual({ ownerUserId: h.collaborator.id, revision: 1 })
      expect(seen).toHaveLength(1)
      const context = seen[0]!
      expect(context.kind).toBe('employee-case.members-changed-audience')
      if (context.kind === 'employee-case.members-changed-audience') {
        expect(context.caseId).toBe(id)
        expect([...context.visibleUserIds].sort()).toEqual([h.owner.id, h.collaborator.id].sort())
      }
      // 转移后前任的 PUT 被拒，新 owner 放行。
      expect(
        (
          await req(h.app, h.owner.token, MEMBERS(id), {
            method: 'PUT',
            body: JSON.stringify({ members: [] }),
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await req(h.app, h.collaborator.token, MEMBERS(id), {
            method: 'PUT',
            body: JSON.stringify({ members: [] }),
          })
        ).status,
      ).toBe(200)
    } finally {
      unsubscribe()
    }
  })

  test('bypass（admin）在三个面上的判定与今天一致：可见、可操作、可管理', async () => {
    const h = await buildHarness()
    const id = await seedCase(h.db, h.owner.id)
    const members = await req(h.app, h.admin.token, MEMBERS(id), {
      method: 'PUT',
      body: JSON.stringify({ members: [{ userId: h.stranger.id, role: 'observer' }] }),
    })
    expect(members.status).toBe(200)
    expect(await code(await req(h.app, h.stranger.token, CASE(id)))).not.toBe(
      'employee-case-not-found',
    )
  })
})

describe('RFC-330 D19 —— tasks:read:all 而无 bypass 的账号（判据级）', () => {
  // 仓内没有一个角色预设是「有 tasks:read:all、无 resource-acl:bypass」（manager / admin 两者都有），
  // 所以这一档只能在判据层用合成 actor 锁定：看得见、但不能操作（与任务侧 requireTaskOperator 同形）。
  const base = buildActor({
    user: {
      id: 'auditor',
      username: 'auditor',
      displayName: 'auditor',
      role: 'user',
      status: 'active',
    },
    source: 'session',
  })
  const auditor = {
    ...base,
    permissions: new Set([...base.permissions, 'tasks:read:all' as const]),
  }
  const row = { id: 'case-1', ownerUserId: 'someone-else', employeeId: 'employee-1' }

  test('可见但不可操作', () => {
    expect(auditor.permissions.has('resource-acl:bypass')).toBe(false)
    expect(canViewCase(auditor, row, null)).toBe(true)
    expect(canOperateCase(auditor, row, null)).toBe(false)
    // 普通局外人两者都否；collaborator 两者都是。
    expect(canViewCase(base, row, null)).toBe(false)
    expect(canOperateCase(base, row, 'collaborator')).toBe(true)
    expect(canOperateCase(base, row, 'observer')).toBe(false)
  })
})
