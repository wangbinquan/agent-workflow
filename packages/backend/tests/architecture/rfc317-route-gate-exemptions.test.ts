// RFC-317 T53 · findings TP-02 —— 路由门自检的两个未上棘轮的豁免洞。
//
// `assertRouteMetaCoverage` 在启动时拒绝「挂了但没声明」的路由——那条自检存在的全部
// 意义是「未声明的路由会 UNGATED 运行」。它有两个洞：
//
//  ① **一刀切放行 `method === 'ALL'`**，理由写着「中间件不是端点」。但
//     `mcp/server.ts` 的 `app.all('/api/mcp', handler)` 就是一个真正处理请求的端点
//     ——作者当时也知道，所以又把它塞进 `EXEMPT_MOUNTS` 兜了一道。也就是说：任何未来的
//     `app.all('/api/x', handler)` 或 `app.use('/api/x', gate)` 都会**无声地**绕过声明检查。
//  ② **`EXEMPT_MOUNTS` 是模块私有 Set、零测试引用**。它每涨一条都是一个洞，
//     而涨它不需要任何人签字。
//
// T53 的处置：
//   · 判据从「按动词」换成「按路径」——`/api/` 下的**精确路径** ALL 挂载必须声明或入账；
//     通配挂载（`/api/*`、`/api/tasks/:id/*`）仍视为中间件，因为通配段本身就是
//     「我拦一片，不是我处理某个资源」的结构性表达。
//   · `EXEMPT_MOUNTS` 导出并在这里**冻结**：涨它变成一次有署名的编辑。

import { describe, expect, test } from 'bun:test'
import { EXEMPT_MOUNTS, allRouteMeta } from '@/routes/registry'
import { buildContractHarness } from '../contracts/harness'

describe('RFC-317 T53 —— 路由门豁免被冻结', () => {
  test('EXEMPT_MOUNTS 逐条相等（涨一条必须是一次有署名的编辑）', () => {
    expect(
      [...EXEMPT_MOUNTS].sort(),
      'EXEMPT_MOUNTS 变了——每一条都是「这条路由不必声明权限」的例外，' +
        '加一条等于在启动自检上开一个洞，必须在 review 里说清为什么',
    ).toEqual(['*', '/api/mcp', '/api/tasks/:id'].sort())
  })

  test('每条豁免都有理由写在源码里（判据是 registry.ts 的注释密度，不是这里的清单）', () => {
    // 只锁数量不锁理由，等于允许有人加一行空豁免。这里不解析注释（正则判注释是另一个
    // 坑），改为要求名单**足够小**——三条是「小到每条都会被 review 逐条读」的量级。
    expect(EXEMPT_MOUNTS.size).toBeLessThanOrEqual(3)
  })
})

describe('RFC-317 T53 —— /api 下的 ALL 挂载不再被动词豁免', () => {
  test('运行期核对：每条 /api 精确路径的 ALL 挂载要么有声明、要么已入账', async () => {
    // 用真实 `createApp` 而不是扫源码：计算出来的路径、helper 挂载、src/routes 之外的
    // 文件，正则一概看不见（这正是 TP-01 的失明方式）。Hono 的 `app.routes` 是它自己
    // 记录的挂载表，问它就等于问框架「你到底挂了什么」。
    const harness = await buildContractHarness()
    const declared = new Set(allRouteMeta().map((meta) => `${meta.method} ${meta.path}`))
    const offenders = harness.app.routes
      .filter((route) => route.method.toUpperCase() === 'ALL')
      .filter((route) => route.path.startsWith('/api/') || route.path === '/api')
      .filter((route) => !route.path.endsWith('*'))
      .filter((route) => !EXEMPT_MOUNTS.has(route.path))
      .filter((route) => !declared.has(`ALL ${route.path}`))
      .map((route) => `ALL ${route.path}`)
      .sort()
    expect(
      offenders,
      '有 /api 下的精确路径以 method=ALL 挂载且无声明——它会 UNGATED 运行。' +
        '要么 registerRoute() 声明它，要么在 EXEMPT_MOUNTS 里加一条带理由的条目',
    ).toEqual([])
  })

  test('语料非空：确实取到了挂载表（取空即假绿）', async () => {
    const harness = await buildContractHarness()
    expect(harness.app.routes.length).toBeGreaterThan(100)
    // 且其中确实有 ALL 挂载——否则上面那条「零违规」可能只是因为一条都没扫到。
    expect(
      harness.app.routes.filter((route) => route.method.toUpperCase() === 'ALL').length,
    ).toBeGreaterThan(0)
  })
})
