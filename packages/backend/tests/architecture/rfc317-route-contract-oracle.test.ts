// RFC-317 T52 · findings TP-01 —— 契约覆盖改用**运行期预言**。
//
// `api-contract-coverage.test.ts` 用两条正则扫 `src/routes/*.ts` 找路由。两条正则都要求
// `path: '<字面量>'`，于是**计算出来的路径整族看不见**：`developmentConfig.ts` 用
// `path: cfg.base` / `path: \`${cfg.base}/:id/publish\`` 注册一个六路由家族，
// 而这个家族被挂了 **5 次**（action-templates / verification-profiles / digital-employees /
// automation-policies / development-adapters），外加一次计算路径的 `mountAclEndpoints`。
//
// 最坏的部分是**它自己的元守卫也看不见**：盲点检测器的 `[^}]*?` 跨不过
// `${cfg.base}` 里的那个 `}`，所以「所有盲点都已登记」那条断言照绿——一边报告
// 「全部已注册」，一边有四十来个端点从未进入视野。那个文件的头注释自己写着这种失败模式：
// 「A guard that cannot see a route reports 'all registered' — the failure mode is
// silent completeness.」
//
// 本文件换一个提问对象：**问框架**。`createApp` 之后 `allRouteMeta()` 是框架实际持有的
// 声明表，计算路径、helper 挂载、`src/routes/` 之外的文件都逃不掉。
//
// 现状：462 条声明 vs 420 条契约条目，**43 条挂了却没有契约条目**（finding 估的 ~41
// 精确命中）。补齐 43 条契约（每条要写请求/响应规格）是另一件独立工程，本次先把差距
// 变成**只减不增**的账本——今天谁都说不出「我们有多少端点没有契约」。

import { describe, expect, test } from 'bun:test'
import { allRouteMeta } from '@/routes/registry'
import { buildContractHarness } from '../contracts/harness'
import { ENDPOINTS } from '../contracts/registry'

/**
 * 挂载了、但 `tests/contracts/registry.ts` 里没有契约条目的端点。
 *
 * **只减不增**：新增一条 ⇒ 红（新路由必须带契约）；补上一条却不销账 ⇒ 也红
 * （差额会变成下一个人的免费槽位）。
 *
 * 这 43 条的成因高度集中：`developmentConfig.ts` 的六路由通用家族被挂了 5 次，
 * 每次带一对 ACL 端点——正则扫描器对 `path: cfg.base` 这种计算路径整族失明。
 */
const ENDPOINTS_WITHOUT_CONTRACT: readonly string[] = [
  'GET /api/code/action-templates',
  'GET /api/code/action-templates/:id',
  'GET /api/code/action-templates/:id/acl',
  'GET /api/code/automation-policies',
  'GET /api/code/automation-policies/:id',
  'GET /api/code/automation-policies/:id/acl',
  'GET /api/code/digital-employees',
  'GET /api/code/digital-employees/:id',
  'GET /api/code/digital-employees/:id/acl',
  'GET /api/code/verification-profiles',
  'GET /api/code/verification-profiles/:id',
  'GET /api/code/verification-profiles/:id/acl',
  'GET /api/integrations/development-adapters',
  'GET /api/integrations/development-adapters/:id',
  'GET /api/integrations/development-adapters/:id/acl',
  'GET /api/whoami',
  'POST /api/code/action-templates',
  'POST /api/code/action-templates/:id/archive',
  'POST /api/code/action-templates/:id/publish',
  'POST /api/code/automation-policies',
  'POST /api/code/automation-policies/:id/archive',
  'POST /api/code/automation-policies/:id/publish',
  'POST /api/code/digital-employees',
  'POST /api/code/digital-employees/:id/archive',
  'POST /api/code/digital-employees/:id/publish',
  'POST /api/code/verification-profiles',
  'POST /api/code/verification-profiles/:id/archive',
  'POST /api/code/verification-profiles/:id/publish',
  'POST /api/digital-employee-types/:typeRef/work-items/:workItemRef/tools/:toolId/publish',
  'POST /api/digital-employee-types/:typeRef/work-items/:workItemRef/tools/:toolId/validate',
  'POST /api/integrations/development-adapters',
  'POST /api/integrations/development-adapters/:id/archive',
  'POST /api/integrations/development-adapters/:id/publish',
  'PUT /api/code/action-templates/:id',
  'PUT /api/code/action-templates/:id/acl',
  'PUT /api/code/automation-policies/:id',
  'PUT /api/code/automation-policies/:id/acl',
  'PUT /api/code/digital-employees/:id',
  'PUT /api/code/digital-employees/:id/acl',
  'PUT /api/code/verification-profiles/:id',
  'PUT /api/code/verification-profiles/:id/acl',
  'PUT /api/integrations/development-adapters/:id',
  'PUT /api/integrations/development-adapters/:id/acl',
]

describe('RFC-317 T52 —— 每个挂载的端点都该有契约条目（运行期预言）', () => {
  test('语料非空：确实取到了框架的声明表（取空即假绿）', async () => {
    await buildContractHarness()
    expect(allRouteMeta().length).toBeGreaterThan(400)
    expect(ENDPOINTS.length).toBeGreaterThan(400)
  })

  test('缺契约的端点与账本**逐条相等**', async () => {
    await buildContractHarness()
    const contracts = new Set(ENDPOINTS.map((entry) => `${entry.method} ${entry.path}`))
    const uncovered = allRouteMeta()
      .map((meta) => `${meta.method} ${meta.path}`)
      .filter((key) => !contracts.has(key))
      .sort()
    expect(
      uncovered,
      '新挂了一个没有契约条目的端点（去 tests/contracts/registry.ts 补一条），' +
        '或者补上了一条却没把账本一起改小',
    ).toEqual([...ENDPOINTS_WITHOUT_CONTRACT].sort())
  })

  test('账本里的每一条**今天确实挂着**（写错路径的条目会永久占坑）', async () => {
    await buildContractHarness()
    const mounted = new Set(allRouteMeta().map((meta) => `${meta.method} ${meta.path}`))
    const phantom = ENDPOINTS_WITHOUT_CONTRACT.filter((entry) => !mounted.has(entry))
    expect(phantom, '账本里有已经不存在的端点——它占着一个永远不会被销的坑').toEqual([])
  })

  test('正则扫描器的失明是**可复现的**：计算路径家族一条都扫不到', () => {
    // 这条把 TP-01 的成因钉住，免得有人把上面的账本误读成「契约写漏了」。
    // 两条扫描正则都要求 `path: '<字面量>'`；`developmentConfig.ts` 用的是 `cfg.base`。
    const computedFamilies = ENDPOINTS_WITHOUT_CONTRACT.filter(
      (entry) =>
        entry.includes('/api/code/action-templates') ||
        entry.includes('/api/code/verification-profiles') ||
        entry.includes('/api/code/automation-policies') ||
        entry.includes('/api/integrations/development-adapters'),
    )
    expect(
      computedFamilies.length,
      '账本里那批「计算路径家族」不见了——如果是补齐了契约，把这条断言一起改；' +
        '如果是路由被删了，同样要改。两种都不该静默通过',
    ).toBeGreaterThan(20)
  })
})
