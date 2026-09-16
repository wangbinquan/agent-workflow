// RFC-359 AC-6（plan §5gk）—— 两个组合根挂载出来的 HTTP 路由面必须**逐字相等**。
//
// 为什么要有这条守卫：仓里有一批单引擎守卫（`rfc329-mcp-surface-guard`、
// `rfc305-architecture-lock` 等）只为了拿到「路由 → 权限」这张声明表而装一个应用，装的是
// `createApp`——也就是 **SQLite 组合根**。它们把量到的那张表当成「框架的路由面」来审，
// 可它们量到的其实是**一个引擎的**路由面。
//
// 读源码能论证两侧应该一样：两个根都汇进同一个 `createComposedApp` → 同一个 `mountApiRoutes`，
// 而 `mountApiRoutes` 里唯一条件挂载的一组是 `routes.databaseMigration?.(app)`
// （`AppRouteMount` 里唯一带 `?` 的字段）。但「读源码论证过」和「有判据钉着」是两件事：
// 今天只要有人给某个根多挂一组路由、或给同一条路由在两个根上配不同的权限，
// 上面那批守卫**一格都不会红**——它们只看得见 SQLite 那一侧。
//
// 于是这里不写账本、不列 470 条路由（那会让此后每个加路由的 RFC 都欠一笔维护），
// 而是**把两个根都装出来，直接比**：两条 lane 各自把自己量到的面记进模块级 map，
// 末尾那个 describe 再做一次逐字比对。失败时打印的是对称差，指名道姓是哪条路由/哪个权限不一样。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { allRouteMeta, resetRouteMetaRegistry } from '@/routes/registry'
import type { WebhookDispatcher } from '@/services/webhook/dispatcherTypes'

import { resolveTestProviders, type TestProvider } from '../helpers/eachProvider'
import { describeEachProviderHttpApplication } from '../helpers/providerHttpApplicationScope'

/** 两条 lane 各写一格；末尾的 describe 读它。同文件同进程，所以 map 是通的。 */
const mountedSurfaces = new Map<TestProvider, readonly string[]>()

/**
 * 一条路由的**可比较形态**：不只比路径，连权限与 token 准入一起比。
 * 「两个根挂了同一批路径、但某条路径在一侧要的权限更松」正是本 RFC 要挡的那种
 * 「一个好一个不好」的分叉，只比 key 看不见它。
 */
function surfaceOf(): readonly string[] {
  return allRouteMeta()
    .map((meta) => {
      const permissions = [...meta.permissions].sort().join('+')
      return `${meta.method} ${meta.path} :: token=${meta.tokenAccess} :: ${permissions === '' ? '(public)' : permissions}`
    })
    .sort()
}

describeEachProviderHttpApplication(
  'RFC-359 W5 —— 组合根路由面',
  {
    token: 'r'.repeat(64),
    opencodeVersion: 'test',
    dbVersion: 1,
    tempPrefix: 'aw-rfc359-root-surface-',
    // 必须显式给：webhook 入站面是**两个根所有权不同**的那一组——PG 根自己构造 dispatcher，
    // SQLite 根当依赖收（生产里由 `cli/start.ts:2806-2808` 注入）。不给的话
    // `mountWebhookIngressRoutes` 在 SQLite 那侧自我跳过，比出来的差异是**夹具**造成的、
    // 不是两个根真的不一样——第一次跑本守卫时正是这么假红了一次。
    // 只需满足 `supportsEventCenterCodeHostDelivery`（即带 `dispatchSubscription`）；
    // 事件中心两个根都按缺省装，不用注入。
    webhookDispatcher: {
      dispatch: async () => {},
      dispatchSubscription: async () => {},
    } satisfies WebhookDispatcher as WebhookDispatcher,
  },
  (scope) => {
    // 路由注册表是**模块级**的，而 `bun test` 把多个测试文件跑在**同一个进程**里——
    // 本文件装完应用不还原，后面文件量到的就是「它自己的面 + 我们留下的」。
    // 实撞：本守卫刚加上时，`rfc329-mcp-surface-guard` 在同一次 `bun test tests/architecture/`
    // 里红了一格 `uncovered`，多出来的正是本文件挂上去的 webhook 入站路由（它单独跑是绿的）。
    // 与 `rfc305-architecture-lock` 的做法一致：前后各清一次。
    beforeEach(resetRouteMetaRegistry)
    afterEach(resetRouteMetaRegistry)

    test('这个引擎的组合根装出来的路由面被记下来（非空）', async () => {
      await scope.open()
      const surface = surfaceOf()
      mountedSurfaces.set(scope.harness.capabilities.provider as TestProvider, surface)
      expect(
        surface.length,
        '组合根装完一条路由都没挂上——说明这次量的根本不是真应用的路由面，后面的比对也就没有意义',
      ).toBeGreaterThan(0)
    })
  },
)

describe('RFC-359 W5 —— 两个组合根的路由面', () => {
  test('逐字相等（多挂一组路由、或同一条路由两侧权限不同，都在这里现形）', () => {
    const selected = resolveTestProviders(process.env)
    if (selected.length < 2) {
      // 单引擎模式（`AW_TEST_PROVIDERS=sqlite`）下比不了——**说清楚**而不是假装比过了。
      expect(
        mountedSurfaces.size,
        '单引擎模式下至少要记下所选那一个引擎的面，否则记录这条路径本身就是坏的',
      ).toBe(1)
      return
    }

    const sqlite = mountedSurfaces.get('sqlite')
    const postgresql = mountedSurfaces.get('postgresql')
    expect(
      { sqlite: sqlite !== undefined, postgresql: postgresql !== undefined },
      '两条 lane 都该跑过并各记一格；缺一格说明那一侧的应用压根没装起来',
    ).toEqual({ sqlite: true, postgresql: true })

    const inSqliteOnly = (sqlite ?? []).filter((entry) => !(postgresql ?? []).includes(entry))
    const inPostgresqlOnly = (postgresql ?? []).filter((entry) => !(sqlite ?? []).includes(entry))
    expect(
      { inSqliteOnly, inPostgresqlOnly },
      '两个组合根挂出来的路由面不一样。**这正是本 RFC 要根除的那种分叉**：' +
        '一批只装 `createApp`（SQLite 根）的守卫会把它们量到的那张表当成「框架的路由面」来审，' +
        '于是只有一侧被钉住。要么把多出来/少掉的那一组补齐，' +
        '要么说明它为什么天然只属于一个引擎（并让它在两侧都有判据钉着）。',
    ).toEqual({ inSqliteOnly: [], inPostgresqlOnly: [] })
  })
})
