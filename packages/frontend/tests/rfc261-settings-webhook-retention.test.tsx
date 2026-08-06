// RFC-261 (D9') — 设置 → GC tab 的 webhook 投递保留天数字段：
//   渲染默认值、修改后保存的 PUT /api/config patch 携带两个键（gc scope
//   最小写允许清单已登记——漏登记 = 保存时被静默丢弃，settings-drafts.ts 注释）。
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

let putBodies: unknown[] = []

beforeEach(async () => {
  putBodies = []
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://rfc261-retention-${crypto.randomUUID()}.test`)
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      if (s.includes('/api/config') && init?.method === 'PUT') {
        putBodies.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify(DEFAULT_CONFIG), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // BackupCard（GcTab 内嵌）解构 data.failed[0]，兜底 '{}' 会炸渲染树
      if (s.includes('/api/restore/pending')) {
        return new Response(JSON.stringify({ pending: null, failed: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function mkConfig(overrides: Partial<Config> = {}): Config {
  return { ...DEFAULT_CONFIG, ...overrides }
}

describe('RFC-261 · 设置 GC tab webhook 保留天数', () => {
  test('渲染 config 值；修改后保存的 patch 携带两个键', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const Wrapped = wrap(qc)
    render(
      <Wrapped>
        <GcTab config={mkConfig({ webhookDeliveryBodyRetentionDays: 14 })} />
      </Wrapped>,
    )
    const body = (await waitFor(() =>
      screen.getByTestId('settings-webhook-body-retention'),
    )) as HTMLInputElement
    const row = screen.getByTestId('settings-webhook-row-retention') as HTMLInputElement
    expect(body.value).toBe('14')
    expect(row.value).toBe('90')

    fireEvent.change(body, { target: { value: '7' } })
    fireEvent.change(row, { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(putBodies.length).toBe(1))
    expect(putBodies[0]).toMatchObject({
      webhookDeliveryBodyRetentionDays: 7,
      webhookDeliveryRowRetentionDays: 30,
    })
  })
})
