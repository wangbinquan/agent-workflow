// RFC-436 —— 事件中心与数字员工的 HTTP 绑定归入各自模块（RFC-294 W4 E9）。
//
// 锁住四件事：
//   1. 两个绑定在各自模块的 `inbound/http`，旧的 `routes/eventCenter.ts`、`routes/digitalEmployees.ts`
//      与 `services/employeeCaseMembers.ts` 不再存在；
//   2. 数字员工绑定不依赖 development-automation / identity-access / `services/` / 操作路由助手——
//      context DAG 只允许 development-automation → digital-employee，绑定入模块后任何反向导入都是环；
//   3. 原先托管在数字员工路由里的图设计路由与活动操作由 development-automation 自己挂载
//      （`server.ts` 路由组 `developmentCases` 紧随 `digitalEmployees`），图设计路由的案例授权
//      仍是数字员工的案例访问判据（HTTP 断言：404 同形的 `employee-case-not-found` 只可能来自它）；
//   4. 案例访问与平台工具只读判据整段搬迁，分支、错误码与文案不变。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { lookupRouteMeta } from '@/routes/registry'
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Permission } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import {
  canManageCaseMembers,
  canOperateCase,
  canViewCase,
  employeeCaseRouteAccess,
  loadVisibleCase,
  requireCaseOperator,
  requireCaseOwner,
  type CaseAclRow,
  type CaseMemberRole,
  type EmployeeCaseRuntime,
  type EmployeeCaseViewer,
} from '../src/modules/digital-employee/application/caseAccess'
import { assertEmployeeToolWritable } from '../src/modules/digital-employee/application/toolAccess'
import { createSession } from './helpers/auth/sessionStore'
import {
  describeEachProviderHttpApplication,
  type ProviderHttpApplicationScope,
} from './helpers/providerHttpApplicationScope'
import { createUser } from './helpers/userFixture'

const SRC = resolve(import.meta.dir, '..', 'src')
const DE_BINDING = 'modules/digital-employee/inbound/http/digitalEmployeeRoutes.ts'
const EC_BINDING = 'modules/event-center/inbound/http/eventCenterRoutes.ts'
const DA_CASE_ROUTES = 'modules/development-automation/inbound/http/employeeCaseRoutes.ts'

function source(relative: string): string {
  return readFileSync(resolve(SRC, relative), 'utf8')
}

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*?from\s+'([^']+)'/g)].map(
    (match) => match[1]!,
  )
}

describe('RFC-436 —— HTTP 绑定的位置与依赖', () => {
  test('两个绑定在各自模块的 inbound/http，旧文件不再存在', () => {
    for (const gone of [
      'routes/eventCenter.ts',
      'routes/digitalEmployees.ts',
      'services/employeeCaseMembers.ts',
    ]) {
      expect(existsSync(resolve(SRC, gone)), gone).toBe(false)
    }
    for (const present of [DE_BINDING, EC_BINDING, DA_CASE_ROUTES]) {
      expect(existsSync(resolve(SRC, present)), present).toBe(true)
    }
  })

  test('数字员工绑定只依赖本模块与传输工具，不反向依赖 development-automation', () => {
    const specifiers = importSpecifiers(source(DE_BINDING))
    expect(specifiers.length).toBeGreaterThan(5)
    expect(specifiers.filter((specifier) => specifier.startsWith('@/modules/'))).toEqual([])
    expect(specifiers.filter((specifier) => specifier.startsWith('@/services/'))).toEqual([])
    expect(specifiers.filter((specifier) => specifier.startsWith('@/routes/operation'))).toEqual([])
    // 相对导入只指向本模块（`../../application/...`）。
    expect(
      specifiers.filter(
        (specifier) => specifier.startsWith('.') && !specifier.startsWith('../../application/'),
      ),
    ).toEqual([])
    const text = source(DE_BINDING)
    expect(text).not.toContain('/api/employee-cases/worker/run-one')
    expect(text).not.toContain('mountRoutes(')
  })

  test('事件中心绑定只依赖本模块与传输工具', () => {
    const specifiers = importSpecifiers(source(EC_BINDING))
    expect(specifiers.filter((specifier) => specifier.startsWith('@/modules/'))).toEqual([])
    expect(specifiers.filter((specifier) => specifier.startsWith('@/services/'))).toEqual([])
    expect(
      specifiers.filter(
        (specifier) => specifier.startsWith('.') && !specifier.startsWith('../../application/'),
      ),
    ).toEqual([])
  })

  test('development-automation 自己挂载案例范围路由，server 紧随数字员工路由调用', () => {
    const caseRoutes = source(DA_CASE_ROUTES)
    expect(caseRoutes).toContain("path: '/api/employee-cases/worker/run-one'")
    expect(caseRoutes).toContain('routes.graph.mountRoutes(app, routes.caseAccess)')
    expect(
      importSpecifiers(caseRoutes).filter((s) => s.startsWith('@/modules/digital-employee')),
    ).toEqual([])
    expect(source('server.ts')).toMatch(
      /routes\.digitalEmployees\(app\)\n\s*routes\.developmentCases\(app\)/,
    )
    expect(source('bootstrap/daemonHttpComposition.ts')).toContain(
      'caseAccess: employeeCaseRouteAccess(digitalEmployee.runtime)',
    )
  })
})

// 判据级：合成查看者 + 纯函数，一行 DB 都不碰——不套双引擎 harness。
describe('RFC-436 —— 案例访问判据随迁移保持原分支', () => {
  const viewer = (id: string, ...permissions: Permission[]): EmployeeCaseViewer => ({
    user: { id },
    permissions: new Set(permissions),
  })
  const row: CaseAclRow = { id: 'case-1', ownerUserId: 'owner', employeeId: 'employee-1' }
  const owner = viewer('owner')
  const stranger = viewer('stranger')
  const auditor = viewer('auditor', 'tasks:read:all')
  const bypass = viewer('root', 'resource-acl:bypass')

  test('可见：发起人 ∪ 成员 ∪ tasks:read:all ∪ bypass', () => {
    expect(canViewCase(owner, row, null)).toBe(true)
    expect(canViewCase(stranger, row, 'observer')).toBe(true)
    expect(canViewCase(stranger, row, 'collaborator')).toBe(true)
    expect(canViewCase(auditor, row, null)).toBe(true)
    expect(canViewCase(bypass, row, null)).toBe(true)
    expect(canViewCase(stranger, row, null)).toBe(false)
    expect(canViewCase(owner, { ...row, ownerUserId: null }, null)).toBe(false)
  })

  test('操作：发起人 ∪ collaborator ∪ bypass；observer 与 tasks:read:all 只能看', () => {
    expect(canOperateCase(owner, row, null)).toBe(true)
    expect(canOperateCase(stranger, row, 'collaborator')).toBe(true)
    expect(canOperateCase(bypass, row, null)).toBe(true)
    expect(canOperateCase(stranger, row, 'observer')).toBe(false)
    expect(canOperateCase(auditor, row, null)).toBe(false)
  })

  test('管理成员：发起人 ∪ bypass', () => {
    expect(canManageCaseMembers(owner, row)).toBe(true)
    expect(canManageCaseMembers(bypass, row)).toBe(true)
    expect(canManageCaseMembers(auditor, row)).toBe(false)
    expect(canManageCaseMembers(stranger, row)).toBe(false)
  })

  const runtimeWith = (roles: Readonly<Record<string, CaseMemberRole>>): EmployeeCaseRuntime => ({
    queries: {
      getCaseAcl: async (caseId) => (caseId === row.id ? row : null),
      getCaseMemberRole: async (_caseId, userId) => roles[userId] ?? null,
      listCaseMembers: async () => [],
    },
    commands: {
      replaceCaseMembers: async () => ({ previousOwnerUserId: null, previousMemberUserIds: [] }),
    },
  })

  async function failure(
    run: () => Promise<unknown>,
  ): Promise<{ code?: string; message?: string }> {
    try {
      await run()
    } catch (error) {
      return error as { code?: string; message?: string }
    }
    throw new Error('expected the rule to refuse')
  }

  test('不可见与不存在同形 404；observer 操作 403；非 owner 管理成员 403——错误码与文案不变', async () => {
    const runtime = runtimeWith({ watcher: 'observer', helper: 'collaborator' })
    const missing = await failure(() => loadVisibleCase(runtime, owner, 'nope'))
    const invisible = await failure(() => loadVisibleCase(runtime, stranger, row.id))
    expect(missing.code).toBe('employee-case-not-found')
    expect(invisible.code).toBe('employee-case-not-found')
    expect(invisible.message).toBe(missing.message)

    const observer = await failure(() => requireCaseOperator(runtime, viewer('watcher'), row.id))
    expect(observer.code).toBe('employee-case-observer-read-only')
    expect(observer.message).toBe(
      'you can only watch this employee case; resuming, terminating and policy upgrades are reserved for its owner and collaborators',
    )
    expect(await requireCaseOperator(runtime, viewer('helper'), row.id)).toEqual(row)

    const notOwner = await failure(() => requireCaseOwner(runtime, viewer('helper'), row.id))
    expect(notOwner.code).toBe('forbidden')
    expect(notOwner.message).toBe(
      'only the employee case owner or an actor with resource-acl:bypass can manage members',
    )
    expect(await requireCaseOwner(runtime, owner, row.id)).toEqual(row)
  })

  test('图设计路由的授权：edit 走操作判据，读走可见判据', async () => {
    const access = employeeCaseRouteAccess(runtimeWith({ watcher: 'observer' }))
    expect(await access.authorize(viewer('watcher'), row.id, false)).toEqual(row)
    expect((await failure(() => access.authorize(viewer('watcher'), row.id, true))).code).toBe(
      'employee-case-observer-read-only',
    )
    expect((await failure(() => access.authorize(stranger, row.id, false))).code).toBe(
      'employee-case-not-found',
    )
  })

  test('平台目录工具只读：同一个 403 与逐字相同的文案', () => {
    expect(() => assertEmployeeToolWritable({ builtin: false })).not.toThrow()
    let refused: { code?: string; message?: string; status?: number } = {}
    try {
      assertEmployeeToolWritable({ builtin: true })
    } catch (error) {
      refused = error as typeof refused
    }
    expect(refused.code).toBe('builtin-readonly')
    expect(refused.message).toBe(
      'this employee_tool is a built-in framework resource and is read-only',
    )
    expect(refused.status).toBe(403)
  })
})

const DAEMON_TOKEN = 'b'.repeat(64)
const NOW = 1_700_000_000_000

async function seedCase(db: PersistenceDb, ownerUserId: string): Promise<string> {
  const id = ulid()
  const { employeeCases } = tablesOf(db)
  await insertOne(db, employeeCases, {
    id,
    name: `case-${id.slice(-6)}`,
    employeeId: 'employee-1',
    employeeRevision: 1,
    typeId: 'development',
    typeRevision: 10,
    primaryContextId: `context-${id}`,
    executionPolicyRevision: 1,
    ownerUserId,
    state: 'active',
    revision: 1,
    writerGeneration: 1,
    createdAt: NOW,
    updatedAt: NOW,
  })
  return id
}

async function sessionFor(
  db: PersistenceDb,
  username: string,
): Promise<{ id: string; token: string }> {
  const user = await createUser(db, {
    username,
    displayName: username,
    role: 'user',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: user.id })
  return { id: user.id, token }
}

async function get(app: Hono, token: string, path: string): Promise<Response> {
  return await app.request(path, { headers: { Authorization: `Bearer ${token}` } })
}

describeEachProviderHttpApplication(
  'RFC-436 —— development-automation 的案例范围路由仍由数字员工的案例访问授权',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    tempPrefix: 'aw-rfc436-case-routes-',
  },
  (scope: ProviderHttpApplicationScope) => {
    test('设计路由：陌生人与不存在同形 404；活动操作原样注册', async () => {
      const db = scope.harness.db
      const app = (await scope.open()).app
      const owner = await sessionFor(db, 'rfc436-owner')
      const stranger = await sessionFor(db, 'rfc436-stranger')
      const caseId = await seedCase(db, owner.id)

      const invisible = await get(app, stranger.token, `/api/employee-cases/${caseId}/design`)
      const missing = await get(app, stranger.token, `/api/employee-cases/${ulid()}/design`)
      expect(invisible.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(((await invisible.clone().json()) as { code?: string }).code).toBe(
        'employee-case-not-found',
      )
      expect(await invisible.text()).toBe(await missing.text())
      // 发起人通过判据；之后是图查询自己的结果（可能是空设计），只断言门不再拦。
      const visible = await get(app, owner.token, `/api/employee-cases/${caseId}/design`)
      const visibleBody = (await visible
        .clone()
        .json()
        .catch(() => null)) as { code?: string } | null
      expect(visibleBody?.code).not.toBe('employee-case-not-found')

      const activity = lookupRouteMeta('POST', '/api/employee-cases/worker/run-one')
      expect(activity?.permissions).toEqual(['development-missions:retry'])
      expect(activity?.tokenAccess).toBe('never')
      expect(activity?.executionGroup).toBe('digital-employee')
      expect(lookupRouteMeta('GET', '/api/employee-cases/:caseId/design')).toBeDefined()
      const anonymous = await app.request('/api/employee-cases/worker/run-one', { method: 'POST' })
      expect(anonymous.status).toBe(401)
    })
  },
)
