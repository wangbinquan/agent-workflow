// RFC-311 T20 — 设置 → GC tab 的「可回收空间」卡片。
//
// 锁三件事:
//   1. 盘点数字如实显示,且「删除退役目录」在目录不存在时禁用(没有可删的东西时
//      不给一个会发请求的按钮);
//   2. 删除走二次确认,确认后才发 POST;
//   3. **载荷缺失/形状不对时只显示「无可回收」,不能炸整页**——这张卡片和归档入口
//      同处 GC tab,一次 `undefined.find` 会把整个设置页变成 error boundary
//      (同形态事故 2026-08-19 在 /code/assignments 上真实发生过)。

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
import { DEFAULT_CONFIG } from '@agent-workflow/shared'

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

let cleanupCalls = 0

function install(disk: unknown): void {
  cleanupCalls = 0
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
          permissions: ['settings:write', 'backup:run'],
          linkedIdentities: [],
          pats: [],
        })
      }
      if (s.includes('/api/maintenance/disk/cleanup') && init?.method === 'POST') {
        cleanupCalls += 1
        return json({ removedBytes: 6144 })
      }
      if (s.includes('/api/maintenance/disk')) return json(disk)
      if (s.includes('/api/restore/pending')) return json({ pending: null, failed: [] })
      return json({})
    },
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://rfc311-disk-${crypto.randomUUID()}.test`)
  setToken('tok')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderGc() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapped = wrap(qc)
  return render(
    <Wrapped>
      <GcTab config={DEFAULT_CONFIG} />
    </Wrapped>,
  )
}

const PRESENT = {
  items: [
    {
      id: 'retired-runtime-stores',
      path: '/home/u/.agent-workflow/opencode-stores',
      exists: true,
      bytes: 3_000_000_000,
      entries: 42,
    },
  ],
  dbFreelistBytes: 12_582_912,
  dbFileBytes: 3_800_000_000,
}

describe('RFC-311 T20 · 可回收空间卡片', () => {
  test('显示盘点数字,删除走二次确认', async () => {
    install(PRESENT)
    renderGc()

    // 卡片会先以**禁用态**挂出(数据未到 ⇒ 没有可删的东西),所以不能用
    // 「元素出现」当「数据到位」——那正是今天在 code-config 上诊断过的同一形态。
    const open = (await screen.findByTestId('disk-cleanup-open')) as HTMLButtonElement
    await waitFor(() => expect(open.disabled).toBe(false))
    expect(screen.getByText(/opencode-stores/)).toBeTruthy()
    // freelist 提示要给出数字(而不是只说"有空间可回收")。
    expect(screen.getByText(/Reclaimable inside the database/)).toBeTruthy()

    fireEvent.click(open)
    const dialog = await waitFor(() => screen.getByRole('dialog'))
    expect(dialog.textContent).toMatch(/permanently deletes/i)
    expect(cleanupCalls).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }))
    await waitFor(() => expect(cleanupCalls).toBe(1))
  })

  test('目录不存在时按钮禁用(不给一个只会白发请求的按钮)', async () => {
    install({ items: [{ ...PRESENT.items[0], exists: false, bytes: 0 }], dbFreelistBytes: 0, dbFileBytes: 10 })
    renderGc()
    const open = (await waitFor(() =>
      screen.getByTestId('disk-cleanup-open'),
    )) as HTMLButtonElement
    expect(open.disabled).toBe(true)
    expect(screen.getByText(/none \(directory absent\)/i)).toBeTruthy()
  })

  test('载荷形状不对时只显示「无可回收」,不炸整页', async () => {
    // 后端换形状 / 代理返回 {} —— 卡片必须降级,而不是让 undefined.find 把
    // 同一 tab 里的归档入口、备份卡片一起带走。
    install({})
    renderGc()
    const open = (await waitFor(() =>
      screen.getByTestId('disk-cleanup-open'),
    )) as HTMLButtonElement
    expect(open.disabled).toBe(true)
    // 同 tab 的其它卡片照常在(证明没有整页崩)。
    expect(screen.getByTestId('settings-webhook-row-retention')).toBeTruthy()
  })
})
