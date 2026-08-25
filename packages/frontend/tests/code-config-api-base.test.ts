// RFC-310 —— 前端 `CONFIG_KIND_SPECS.apiBase` 与后端 `mountConfigResource` 的
// base 逐条对账。
//
// 为什么需要这条：五类配置资源的 CRUD 端点是**计算路径**（一个
// `mountConfigResource(app, deps, { base })` 模板生成 list/get/create/update/
// publish/archive/acl 全套），所以：
//
//   · 后端的 API 契约注册表按字面路径扫描，看不见它们；
//   · 前端把 base 存在自己的常量表里，与后端那份没有任何机械联系；
//   · 页面测试 mock 掉 fetch，用例自己写 URL 匹配 —— **前后端写不一致时
//     测试照样绿**。
//
// 结果是 PR-8 把 adapters 的 base 写成 `/api/code/development-adapters`
// （真实路径是 `/api/integrations/development-adapters`——adapter 属
// integration bounded context，前缀随归属而非随页面），`/code/config/adapters`
// 整页 404，一路穿过所有本地门禁与 CI，最后由用户报出来。
//
// 这条测试就是那个缺失的机械联系：直接读后端源码里的 base 字面量对账。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { DEVELOPMENT_CONFIG_API_BASE } from '@agent-workflow/shared'

import { CONFIG_KIND_SPECS } from '../src/routes/code.config'

const BACKEND_ROUTES = resolve(
  import.meta.dirname,
  '..',
  '..',
  'backend',
  'src',
  'routes',
  'developmentConfig.ts',
)

/** 后端 `mountConfigResource(..., { base: '...', permissionPrefix: '...' })` 的实参对。 */
function backendResources(): { base: string; permissionPrefix: string }[] {
  const src = readFileSync(BACKEND_ROUTES, 'utf8')
  const out: { base: string; permissionPrefix: string }[] = []
  for (const m of src.matchAll(/base:\s*'([^']+)',\s*\n\s*permissionPrefix:\s*'([^']+)'/g)) {
    out.push({ base: m[1]!, permissionPrefix: m[2]! })
  }
  return out
}

describe('RFC-310 — the config pages call the endpoints the backend actually mounts', () => {
  test('every frontend apiBase is a base the backend mounts, with the same permission prefix', () => {
    const backend = backendResources()
    // 先证明扫描器没扫空——否则本测试会在源码重构后静默变成恒真。
    expect(backend.length).toBeGreaterThanOrEqual(5)

    const mismatches: string[] = []
    for (const [kind, spec] of Object.entries(CONFIG_KIND_SPECS)) {
      const match = backend.find((r) => r.base === spec.apiBase)
      if (match === undefined) {
        mismatches.push(
          `${kind}: apiBase '${spec.apiBase}' is mounted nowhere; backend has ${backend
            .map((r) => r.base)
            .join(', ')}`,
        )
        continue
      }
      if (match.permissionPrefix !== spec.permissionPrefix) {
        mismatches.push(
          `${kind}: permissionPrefix '${spec.permissionPrefix}' ≠ backend '${match.permissionPrefix}'`,
        )
      }
    }
    expect(mismatches).toEqual([])
  })

  test('adapters keep their integration API but are absent from the retired config UI', () => {
    expect('adapters' in CONFIG_KIND_SPECS).toBe(false)
    expect(DEVELOPMENT_CONFIG_API_BASE.adapters).toBe('/api/integrations/development-adapters')
  })
})
