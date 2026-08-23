// RFC-317 T55 · findings TP-05 —— 通用面不得引用「以某个员工类型命名」的权限点。
//
// `composeDigitalEmployee` 收的是 `typePackages: [...]` —— 一个**列表**；
// `routes/digitalEmployees.ts` 也泛型地列举员工**类型**。可是这个通用模块挂出来的路由，
// 授权词表里硬编码着**今天唯一存在的那个类型**的名字：`development-missions:*`。
//
// 为什么这是个问题而不只是命名难看：加第二个员工类型时，它的路由要么被迫复用
// `development-missions:launch`（于是一个 token 拿到「开发任务」的权限就同时拿到了
// 新类型的权限），要么另起一个点、而通用路由已经写死了前者——两条路都不通。
// 授权词表是**产品合同**，它一旦长进通用面就很难再拔出来。
//
// 本文件不改语义（改权限点是 breaking change，得单独裁决），只把现状钉成
// **只减不增**的账本：今天 8 条，第 9 条会红。
//
// ⚠️ 判据为什么不是「路径域 == 点域」：那条更"通用"的判据在真实语料上报出 **53 种**
// 错配组合，其中绝大多数是正当的（`reviews ← tasks`：评审路由由任务权限守门；
// `memories ← memory`：单复数）。一条会报出五十几处误报的规则，最终只会被人加一堆
// 豁免糊住。这里只钉住 finding 真正指认的那一件事。

import { describe, expect, test } from 'bun:test'
import { allRouteMeta } from '@/routes/registry'
import { buildContractHarness } from '../contracts/harness'

/** 通用（类型无关）的 Digital Employee OS 路由前缀。 */
const GENERIC_EMPLOYEE_PREFIXES = [
  '/api/digital-employee',
  '/api/employee-cases',
  '/api/execution-contracts',
] as const

/**
 * 以**某个员工类型**命名的权限点前缀。
 *
 * `development-missions` 得名于 `development` 这个员工类型。新增类型时它的点会叫别的
 * 名字，而通用路由不该认识其中任何一个。
 */
const TYPE_SPECIFIC_POINT_PREFIXES = ['development-missions:', 'development-adapters:'] as const

/** 开账当天（RFC-317 T55）的真实存量：8 条。 */
const TYPE_LEAK_LEDGER: readonly string[] = [
  'POST /api/digital-employee-input-uploads → development-missions:launch',
  'DELETE /api/digital-employee-input-uploads/:uploadRef → development-missions:launch',
  'POST /api/digital-employees/:id/cases → development-missions:launch',
  'POST /api/employee-cases/:id/policy-upgrade-preview → development-missions:interact',
  'POST /api/employee-cases/policy-upgrade-apply → development-missions:interact',
  'POST /api/employee-cases/:id/resume → development-missions:retry',
  'POST /api/employee-cases/:id/terminate → development-missions:cancel',
  'POST /api/employee-cases/worker/run-one → development-missions:retry',
]

describe('RFC-317 T55 —— 通用员工面引用类型专属权限点的账本（只减不增）', () => {
  test('运行期核对：泄漏清单与账本逐条相等', async () => {
    // 走真实 `createApp` 而不是扫源码：计算出来的路径与 helper 挂载正则看不见
    // （TP-01 记录的正是那种失明）。
    await buildContractHarness()
    const leaks: string[] = []
    for (const meta of allRouteMeta()) {
      if (!GENERIC_EMPLOYEE_PREFIXES.some((prefix) => meta.path.startsWith(prefix))) continue
      for (const point of meta.permissions) {
        if (!TYPE_SPECIFIC_POINT_PREFIXES.some((prefix) => point.startsWith(prefix))) continue
        leaks.push(`${meta.method} ${meta.path} → ${point}`)
      }
    }
    expect(
      leaks.sort(),
      '通用员工面又引用了一个类型专属权限点——加第二个员工类型时这会变成一道拔不出来的合同；' +
        '反过来，修掉一条却没销账也会红',
    ).toEqual([...TYPE_LEAK_LEDGER].sort())
  })

  test('语料非空：确实取到了路由元数据（取空即假绿）', async () => {
    await buildContractHarness()
    expect(allRouteMeta().length).toBeGreaterThan(300)
    // 且通用前缀下确实有路由——否则「泄漏清单」为空可能只是因为一条都没匹到。
    const generic = allRouteMeta().filter((meta) =>
      GENERIC_EMPLOYEE_PREFIXES.some((prefix) => meta.path.startsWith(prefix)),
    )
    expect(generic.length).toBeGreaterThan(10)
  })
})
