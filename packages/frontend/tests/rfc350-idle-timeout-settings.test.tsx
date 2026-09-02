// RFC-350 —— 设置 → GC tab 的「任务不活跃超时」卡片。
//
// 这张卡背后是一个**会自动取消任务**的开关，所以锁的是它有没有被真正接出来、
// 以及那句最容易被漏掉的磁盘提示：
//   1. 开关与阈值输入框都在（且用的是共享 SettingsNumberInput，由 bounds parity
//      测试另行钉死）；
//   2. 打开收割但 worktreeAutoGc 关着时，必须提示磁盘不会自动释放（I-5 / AC-13）；
//      两个都开、或者收割没开时，这句提示不出现——它是条件性的，不是常驻噪音；
//   3. 翻开关会把 taskIdleTimeout 写进配置草稿（阈值保持不变）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { DEFAULT_CONFIG, type Config } from '@agent-workflow/shared'

import { GcTab } from '../src/routes/settings'
import i18n from '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    const root = createRootRoute({ component: Outlet })
    const index = createRoute({
      getParentRoute: () => root,
      path: '/',
      component: () => <>{children}</>,
    })
    const router = createRouter({
      routeTree: root.addChildren([index]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
    })
    return (
      <QueryClientProvider client={qc}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>
    )
  }
}

let configPuts: Array<Record<string, unknown>> = []

function install(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      const json = (value: unknown) =>
        new Response(JSON.stringify(value), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (s.includes('/api/auth/me')) {
        return json({
          user: { id: 'u1', username: 'u1', displayName: 'u1', role: 'admin', status: 'active' },
          source: 'session',
          permissions: ['settings:write'],
          linkedIdentities: [],
          pats: [],
        })
      }
      if (s.includes('/api/config') && init?.method === 'PUT') {
        configPuts.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return json(DEFAULT_CONFIG)
      }
      if (s.includes('/api/restore/pending')) return json({ pending: null, failed: [] })
      if (s.includes('/api/maintenance/disk')) {
        return json({ items: [], dbFreelistBytes: 0, dbFileBytes: 1024 })
      }
      return json({})
    },
  )
}

beforeEach(async () => {
  configPuts = []
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://rfc350-idle-${crypto.randomUUID()}.test`)
  setToken('tok')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderGc(overrides: Partial<Config> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapped = wrap(qc)
  return render(
    <Wrapped>
      <GcTab config={{ ...DEFAULT_CONFIG, ...overrides }} />
    </Wrapped>,
  )
}

describe('RFC-350 · 任务不活跃超时设置卡', () => {
  test('默认关闭：开关未选中，阈值默认 168 小时（7 天）', async () => {
    install()
    renderGc()

    const toggle = (await waitFor(() =>
      screen.getByTestId('settings-task-idle-timeout-enabled'),
    )) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    // 开关的可及名字就是它的中/英文标签——role 断言是公共组件契约的一部分。
    expect(screen.getByRole('checkbox', { name: /reap idle tasks automatically/i })).toBe(toggle)
    expect(DEFAULT_CONFIG.taskIdleTimeout).toEqual({ enabled: false, idleHours: 168 })

    const threshold = screen.getByTestId('settings-task-idle-timeout-hours') as HTMLInputElement
    expect(threshold.value).toBe('168')
  })

  test('AC-13：开了收割但工作区回收关着 ⇒ 提示磁盘不会自动释放', async () => {
    install()
    renderGc({
      taskIdleTimeout: { enabled: true, idleHours: 168 },
      worktreeAutoGc: { enabled: false },
    })
    expect(await waitFor(() => screen.getByText(/workspace auto-reclaim is off/i))).toBeTruthy()
  })

  test('两个都开 ⇒ 不提示；收割没开 ⇒ 也不提示（条件性提示，不是常驻噪音）', async () => {
    install()
    const { unmount } = renderGc({
      taskIdleTimeout: { enabled: true, idleHours: 168 },
      worktreeAutoGc: { enabled: true, olderThanDays: 7 },
    })
    await waitFor(() => screen.getByTestId('settings-task-idle-timeout-enabled'))
    expect(screen.queryByText(/workspace auto-reclaim is off/i)).toBeNull()
    unmount()

    renderGc({
      taskIdleTimeout: { enabled: false, idleHours: 168 },
      worktreeAutoGc: { enabled: false },
    })
    await waitFor(() => screen.getByTestId('settings-task-idle-timeout-enabled'))
    expect(screen.queryByText(/workspace auto-reclaim is off/i)).toBeNull()
  })

  test('翻开关把 taskIdleTimeout 写进保存的配置（阈值保持不变）', async () => {
    install()
    renderGc()

    const toggle = (await waitFor(() =>
      screen.getByTestId('settings-task-idle-timeout-enabled'),
    )) as HTMLInputElement
    fireEvent.click(toggle)
    expect(toggle.checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(configPuts).toHaveLength(1))
    expect(configPuts[0]!.taskIdleTimeout).toEqual({ enabled: true, idleHours: 168 })
  })
})
