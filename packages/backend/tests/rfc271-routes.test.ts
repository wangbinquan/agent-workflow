// RFC-271 T32/T33 —— 配置包路由的准入契约。
//
// 这里锁的是**声明**，不是 handler 逻辑（那些在 export/preview/commit 各自的测试
// 里）。理由是这几条声明本身就是授权契约的一部分，而它们最容易在后续「顺手补齐
// 权限校验」时被改坏：
//
//  ① 导入两条**不挂资源类型权限点**（AC-30c）。挂六类 `*:read` 的 AND 会与逐条
//     预检自相矛盾——一个只含 agent 的包，凭什么要求调用方同时有 `mcps:read`？
//  ② 但**身份仍是必需的**：路径不在 multiAuth 的 `PUBLIC_PATH_PREFIXES` 里。
//     `publicReason` 在这里的含义是「无权限点」，不是「无需登录」——两者混淆会开出
//     一个匿名可用的导入端点。
//  ③ 六条导出**必须是字面量路径**：契约覆盖守卫按 `path: '<字面量>'` 抓取，写成
//     `for` 循环 + 模板字符串会让它们静静躺在守卫之外。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(import.meta.dir, '..', 'src', 'routes', 'resourcePackages.ts'),
  'utf8',
)
const SESSION = readFileSync(resolve(import.meta.dir, '..', 'src', 'auth', 'session.ts'), 'utf8')

const EXPORT_PATHS = [
  '/api/agents/:id/export-package',
  '/api/skills/:id/export-package',
  '/api/mcps/:id/export-package',
  '/api/plugins/:id/export-package',
  '/api/workflows/:id/export-package',
  '/api/workgroups/:id/export-package',
]

describe('③ 六条导出端点各自挂自己那一类的读权限点，且路径是字面量', () => {
  for (const path of EXPORT_PATHS) {
    test(`${path} 以字面量注册`, () => {
      expect(SRC).toContain(`path: '${path}'`)
    })
  }

  test('权限点与资源类型一一对应，没有串台', () => {
    for (const [segment, point] of [
      ['agents', 'agents:read'],
      ['skills', 'skills:read'],
      ['mcps', 'mcps:read'],
      ['plugins', 'plugins:read'],
      ['workflows', 'workflows:read'],
      ['workgroups', 'workgroups:read'],
    ] as const) {
      const idx = SRC.indexOf(`path: '/api/${segment}/:id/export-package'`)
      expect(idx).toBeGreaterThan(0)
      expect(SRC.slice(idx, idx + 200)).toContain(`permissions: ['${point}']`)
    }
  })

  test('**没有** `for` 循环 + 模板路径（那样会绕开契约覆盖守卫）', () => {
    expect(SRC).not.toMatch(/path: `\/api\/\$\{/)
  })
})

describe('① 导入两条不挂资源类型权限点', () => {
  test('preview / commit 的 permissions 都是空数组', () => {
    for (const path of ['/api/resource-packages/preview', '/api/resource-packages/commit']) {
      const idx = SRC.indexOf(`path: '${path}'`)
      expect(idx).toBeGreaterThan(0)
      const block = SRC.slice(idx, idx + 900)
      expect(block).toContain('permissions: [],')
      // 反向锁：挂上任何一类 `*:read` 都会与逐条预检自相矛盾。
      expect(block).not.toMatch(/permissions: \['[a-z-]+:read'\]/)
    }
  })
})

describe('② 身份仍是必需的 —— `publicReason` 不等于免登录', () => {
  test('两条导入路径都**不在** multiAuth 的公开前缀里', () => {
    // 公开前缀是真正「在任何身份存在之前应答」的那些（登录流程）。配置包不在其中，
    // 所以未认证调用方在 handler 之前就被 401 拒掉。
    expect(SESSION).toContain('/api/auth/login')
    expect(SESSION).not.toContain('/api/resource-packages')
  })

  test('publicReason 明说了「身份仍是必需的」，免得下一个人误读', () => {
    const count = SRC.split('publicReason:').length - 1
    expect(count).toBe(2)
    expect(SRC).toContain('Identity is still REQUIRED')
    expect(SRC).toContain('PUBLIC_PATH_PREFIXES')
  })
})

describe('导出响应是 zip 附件', () => {
  test('content-type 与 content-disposition 都在', () => {
    expect(SRC).toContain("'content-type': 'application/zip'")
    expect(SRC).toContain('attachment; filename=')
  })
})

describe('decisions 走 Zod，不用 `as T` 绕过校验', () => {
  test('有一个严格 schema 且被 safeParse 使用', () => {
    expect(SRC).toContain('ImportDecisionsSchema')
    expect(SRC).toContain('.strict()')
    expect(SRC).toContain('ImportDecisionsSchema.safeParse(')
    expect(SRC).not.toContain('as ImportDecision[]')
  })
})
