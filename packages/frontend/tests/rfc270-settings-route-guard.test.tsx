// RFC-270 AC-13 — `/settings` 的路由守卫。
//
// 用户实报「普通用户可以打开配置页并且看到配置侧边栏」。此前藏起来的只有齿轮
// 入口（`AppShell.tsx` 的 `AdminGear` 判 `settings:read`），路由本身没有任何
// 守卫，`sectionGroups` 又是零过滤的硬编码字面量 —— 直接敲 URL 就能拿到完整
// 页面外壳与**全部 11 个分区**的名字和描述，等于一张平台管理面地图（含代码平台
// 凭据库与 OIDC 认证分区的存在性）。
//
// 三条分支都要锁，尤其是第三条：守卫在 `/me` 出错时**放行**，与本 RFC 其它面
// 「失败关闭」的方向相反。这是刻意的 —— 网络抖一下就把管理员弹出配置页，会让
// 他没法进去修 daemon；而所有 settings 端点在后端都是 `settings:read` /
// `settings:write` 强制的，这道守卫是 UX 不是边界。方向搞反了要来这里改断言。

import { QueryClient } from '@tanstack/react-query'
import { isRedirect } from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Permission } from '@agent-workflow/shared'
import { assertSettingsRouteAccess } from '../src/routes/settings'
import { ACTOR_QUERY_KEY } from '../src/hooks/useActor'
import { clearToken, setToken } from '../src/stores/auth'

const TOKEN = 'tok-rfc270'

function clientWith(permissions: readonly Permission[]): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData([...ACTOR_QUERY_KEY, TOKEN], {
    user: { id: 'u1', username: 'u1', displayName: 'u1', role: 'user', status: 'active' },
    source: 'session',
    permissions,
    linkedIdentities: [],
    pats: [],
  })
  return client
}

/**
 * 守卫用 `throw redirect(...)` 表达重定向；这里把它捕获成可断言的值。
 *
 * `redirect()` 返回的是一个 `Response`，目标藏在 `.options.to`（不是顶层 `.to`），
 * 读错地方会得到 `undefined` 并让断言假绿。
 */
async function outcomeOf(promise: Promise<void>): Promise<'allowed' | { to: unknown }> {
  try {
    await promise
    return 'allowed'
  } catch (thrown) {
    if (isRedirect(thrown)) return { to: (thrown as { options?: { to?: unknown } }).options?.to }
    throw thrown
  }
}

beforeEach(() => {
  setToken(TOKEN)
})

afterEach(() => {
  clearToken()
})

describe('RFC-270 AC-13 · /settings beforeLoad', () => {
  test('有 settings:read（admin）→ 放行', async () => {
    expect(await outcomeOf(assertSettingsRouteAccess(clientWith(['settings:read'])))).toBe(
      'allowed',
    )
  })

  test('无 settings:read（普通用户）→ 重定向回首页', async () => {
    const outcome = await outcomeOf(assertSettingsRouteAccess(clientWith(['workflows:read'])))
    expect(outcome).toEqual({ to: '/' })
  })

  test('缺 settings:read 的任意权限组合都会被挡', async () => {
    // 角色名不参与判定；即使已有多项高风险能力，缺具体页面权限仍不能进入。
    const outcome = await outcomeOf(
      assertSettingsRouteAccess(clientWith(['scripts:author', 'code-host-calls:author'])),
    )
    expect(outcome).toEqual({ to: '/' })
  })

  test('/me 取不到（断网 / daemon 重启）→ 放行，不把管理员弹出去', async () => {
    // 没有预置缓存，守卫会真去取 /me；这里让它失败，复现断网 / daemon 重启。
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    try {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      expect(await outcomeOf(assertSettingsRouteAccess(client))).toBe('allowed')
      expect(fetchMock).toHaveBeenCalled()
    } finally {
      fetchMock.mockRestore()
    }
  })

  test('未登录（无 token）→ 重定向；根路由的 token 守卫另有其职，这里不放空过', async () => {
    clearToken()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // 无 token 时 meQueryOptions 的 queryFn 直接 resolve(null)，不发请求。
    expect(await outcomeOf(assertSettingsRouteAccess(client))).toEqual({ to: '/' })
  })
})
