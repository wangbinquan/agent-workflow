// RFC-317 T8 / findings.md ACL-02 —— 员工定义的可见性与写门。
//
// 事故形态
// --------
// `employee_definitions` 自建表起就带完整的行级 ACL 列（`owner_user_id` +
// `visibility NOT NULL DEFAULT 'private'` + `acl_revision` + owner×name 唯一索引），
// 但 `'employee_definition'` 从未进 `ACL_RESOURCE_TYPES` ⇒ 没有任何 ACL 内核函数
// 能作用到它：三列**完全惰性**，`listEmployeeDefinitions` 只按 `archivedAt` 过滤，
// **全员可见全部员工定义**，写路径也只有粗粒度的 `digital-employees:update` 点。
//
// 比「忘了加过滤」更坏：列的存在会让下一个读代码的人以为可见性已经受控。
//
// 本文件锁修复后的语义。**红→绿对**：把 `routes/digitalEmployees.ts` 里的
// `loadVisibleEmployee` / `requireOwnedEmployee` 拆掉，403/404 组必须立刻红。
//
// 关于用例形状的两点说明
// ----------------------
// ① 种子直接写表（与 rfc099 矩阵同口径）。这样种出的行 `current_revision` 为 NULL，
//    是**存在但尚未产出可执行修订**的半成品——授权判据必须对它可答，这正是
//    `getEmployeeDefinitionAcl` 窄查询存在的理由（不解析配置内容）。
// ② 正向用例只断言「写门放行」（非 403/404）。放行之后 `updateEmployee` 会因为
//    半成品内容各自失败，那是领域规则，不该由本文件绑架。
// ③ 三个列表面的过滤用 AST 断言（见文件末尾）：列表渲染要求完整的 current
//    revision，用真实员工做种子需要注册类型包，成本与被测边界不成比例；而
//    `filterVisibleRows` 本身的行为已由 rfc099 矩阵逐类覆盖。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import ts from 'typescript'
import { ulid } from 'ulid'

import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { employeeDefinitions } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ROUTE_FILE = resolve(import.meta.dir, '..', 'src', 'routes', 'digitalEmployees.ts')
const NOW = 1_700_000_000_000

interface Actor {
  id: string
  token: string
}

interface Harness {
  db: DbClient
  app: Hono
  owner: Actor
  stranger: Actor
  admin: Actor
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc317-employee-acl-config-never-used.json',
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
    owner: await mkUser('emp-owner', 'user'),
    stranger: await mkUser('emp-stranger', 'user'),
    admin: await mkUser('emp-root', 'admin'),
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

async function seedEmployee(
  db: DbClient,
  ownerUserId: string,
  visibility: 'private' | 'public',
): Promise<string> {
  const id = ulid()
  await db
    .insert(employeeDefinitions)
    .values({
      id,
      name: `rfc317-employee-${id.slice(-6)}`,
      typeId: 'rfc317-type',
      typeRevision: 1,
      configurationJson: '{}',
      currentRevision: null,
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

async function snapshot(db: DbClient, id: string): Promise<unknown> {
  const rows = await db
    .select()
    .from(employeeDefinitions)
    .where(eq(employeeDefinitions.id, id))
    .all()
  return rows[0]
}

const DETAIL = (id: string): string => `/api/digital-employees/${id}`

describe('RFC-317 T8 —— 员工定义的可见性', () => {
  test('陌生人读别人的 private 员工定义 ⇒ 404，与不存在同形', async () => {
    const h = await buildHarness()
    const id = await seedEmployee(h.db, h.owner.id, 'private')

    const invisible = await req(h.app, h.stranger.token, DETAIL(id))
    const missing = await req(h.app, h.stranger.token, DETAIL(ulid()))
    expect(invisible.status, '不可见必须 404 而不是 403：403 本身就是存在性预言机').toBe(404)
    expect(missing.status).toBe(404)
    // 点名错误码：既是契约断言，也满足 route-error-code-coverage 的
    // 「新错误码必须被某条测试点名」棘轮——两个 404 必须是**同一个**码，否则
    // 「存在但看不见」与「不存在」仍能被区分出来。
    const invisibleBody = (await invisible.clone().json()) as { code?: string }
    const missingBody = (await missing.clone().json()) as { code?: string }
    expect(invisibleBody.code).toBe('employee-definition-not-found')
    expect(missingBody.code).toBe('employee-definition-not-found')
    expect(await invisible.text(), '两者响应体必须逐字一致，否则仍能区分「存在但看不见」').toBe(
      await missing.text(),
    )
  })

  test('陌生人能看见 public 的那一行（收紧没有把 public 也关掉）', async () => {
    const h = await buildHarness()
    const id = await seedEmployee(h.db, h.owner.id, 'public')
    // 前提复核：可见性判据放行后才轮到详情渲染。种子行没有 current revision，渲染
    // 会失败——但**不会是 404**，那正是本用例要区分的。
    const res = await req(h.app, h.stranger.token, DETAIL(id))
    expect([403, 404], 'public 行对任何登录用户都应当通过可见性判据').not.toContain(res.status)
  })
})

describe('RFC-317 T8 —— 员工定义的写门', () => {
  const writes = (
    id: string,
  ): ReadonlyArray<{ label: string; path: string; init: RequestInit }> => [
    {
      label: 'PUT /api/digital-employees/:id',
      path: DETAIL(id),
      init: { method: 'PUT', body: JSON.stringify({ name: 'intruded' }) },
    },
  ]

  test('可见但非 owner（public 行）⇒ 403 且零写入', async () => {
    const h = await buildHarness()
    const id = await seedEmployee(h.db, h.owner.id, 'public')
    const before = await snapshot(h.db, id)

    for (const attempt of writes(id)) {
      const res = await req(h.app, h.stranger.token, attempt.path, attempt.init)
      expect(res.status, `${attempt.label}：可见但非 owner 必须 403`).toBe(403)
      expect(await snapshot(h.db, id), `${attempt.label}：被拒后不得留下任何持久写入`).toEqual(
        before,
      )
    }
  })

  test('不可见（private 行）⇒ 404 而非 403，且零写入', async () => {
    const h = await buildHarness()
    const id = await seedEmployee(h.db, h.owner.id, 'private')
    const before = await snapshot(h.db, id)

    for (const attempt of writes(id)) {
      const res = await req(h.app, h.stranger.token, attempt.path, attempt.init)
      expect(res.status, `${attempt.label}：不可见必须 404`).toBe(404)
      expect(await snapshot(h.db, id)).toEqual(before)
    }
  })

  test('owner 与 admin 被写门放行（收紧没有误伤正向路径，逃生阀仍在）', async () => {
    const h = await buildHarness()
    const id = await seedEmployee(h.db, h.owner.id, 'private')

    for (const who of ['owner', 'admin'] as const) {
      const res = await req(h.app, h[who].token, DETAIL(id), {
        method: 'PUT',
        body: JSON.stringify({ name: `by-${who}` }),
      })
      expect([403, 404], `${who} 必须通过写门（放行后的领域校验失败不算写门问题）`).not.toContain(
        res.status,
      )
    }
  })
})

describe('RFC-317 T8 —— 三个列表面都接了可见性过滤（AST 断言）', () => {
  // 为什么是 AST 而不是集成断言：列表渲染要求完整的 current revision，用真实员工
  // 做种子需要注册类型包，成本与被测边界不成比例；而 `filterVisibleRows` 本身的
  // 行为已由 rfc099 矩阵逐类覆盖。这里要证的是**接线**：三个列表 handler 都真的
  // 过了那道过滤，而不是漏掉一个。
  const source = ts.createSourceFile(
    'digitalEmployees.ts',
    readFileSync(ROUTE_FILE, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )

  /** 收集所有 `X(...)` 形态里出现的被调用标识符名。 */
  function calledNames(node: ts.Node): Set<string> {
    const names = new Set<string>()
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) names.add(n.expression.text)
      ts.forEachChild(n, visit)
    }
    visit(node)
    return names
  }

  /**
   * 找到 `registerRoute(app, { method, path }, handler)` 的 handler 实参。
   *
   * **必须按 method + path 定位**：同一 path 上常有两条路由（GET 列表 / POST 创建、
   * GET 详情 / PUT 更新）。第一版只按 path 匹配，于是永远取到最后注册的那条——
   * 断言看的是创建 / 更新 handler，而不是它以为在看的列表 / 详情 handler。这类
   * 「锚错了但恒定错在同一处」的断言比漏测更坏，因为它看起来一直在工作。
   */
  function handlerFor(method: string, path: string): ts.Node | null {
    let found: ts.Node | null = null
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'registerRoute' &&
        n.arguments.length >= 3
      ) {
        const meta = n.arguments[1]
        if (meta !== undefined && ts.isObjectLiteralExpression(meta)) {
          const read = (key: string): string | null => {
            for (const prop of meta.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isIdentifier(prop.name) &&
                prop.name.text === key &&
                ts.isStringLiteralLike(prop.initializer)
              ) {
                return prop.initializer.text
              }
            }
            return null
          }
          if (read('method') === method && read('path') === path) found = n.arguments[2] ?? null
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(source)
    return found
  }

  const LIST_ROUTES = [
    ['GET', '/api/digital-employees'],
    ['GET', '/api/digital-employees/launchable'],
    ['GET', '/api/digital-employee-types/:typeRef/employees'],
  ] as const

  test('语料非空：三条列表路由都能在源码里定位到（定位不到即本用例零预言力）', () => {
    for (const [method, path] of LIST_ROUTES) {
      expect(handlerFor(method, path), `找不到路由 ${method} ${path} 的 handler`).not.toBeNull()
    }
  })

  test('三个列表 handler 都调用了 visibleEmployees', () => {
    const missing = LIST_ROUTES.filter(([method, path]) => {
      const handler = handlerFor(method, path)
      return handler === null || !calledNames(handler).has('visibleEmployees')
    }).map(([method, path]) => `${method} ${path}`)
    expect(
      missing,
      '这些列表面没有过可见性过滤——员工定义会对所有登录用户可见（findings.md ACL-02）',
    ).toEqual([])
  })

  test('详情走可见性门，保留的写入口走 owner 门', () => {
    const detail = handlerFor('GET', '/api/digital-employees/:id')
    expect(detail, '找不到详情 handler').not.toBeNull()
    expect(calledNames(detail!).has('loadVisibleEmployee')).toBe(true)

    for (const [method, path] of [['PUT', '/api/digital-employees/:id']] as const) {
      const handler = handlerFor(method, path)
      expect(handler, `找不到写入口 ${method} ${path}`).not.toBeNull()
      expect(
        calledNames(handler!).has('requireOwnedEmployee'),
        `${method} ${path} 没有过 owner 门`,
      ).toBe(true)
    }
  })
})
