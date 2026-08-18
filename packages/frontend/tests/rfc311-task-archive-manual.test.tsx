// RFC-311 T19 — 设置 → GC tab 的「按条件批量归档」手动入口(design §7.1)。
//
// 这个按钮背后是本 RFC 唯一不可逆的删除动作,所以锁的是流程而不是样式:
//   1. 第一次点击只发 **dryRun** 预览,一行都不能删;
//   2. 预览有结果才弹二次确认,确认后才发 `dryRun:false`;
//   3. 预览为空时不弹「确认删除」对话框(无事可确认),只给一句说明;
//   4. 没有 settings:write 的人根本看不到这个入口。

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

let archiveBodies: Array<Record<string, unknown>> = []
let configPuts: Array<Record<string, unknown>> = []

function install(opts: { permissions: string[]; treeCount: number; taskCount: number }): void {
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
          user: {
            id: 'u1',
            username: 'u1',
            displayName: 'u1',
            role: 'admin',
            status: 'active',
          },
          source: 'session',
          permissions: opts.permissions,
          linkedIdentities: [],
          pats: [],
        })
      }
      if (s.includes('/api/config') && init?.method === 'PUT') {
        configPuts.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return json(DEFAULT_CONFIG)
      }
      if (s.includes('/api/tasks/archive')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
        archiveBodies.push(body)
        return json({
          dryRun: body.dryRun !== false,
          retentionDays: body.retentionDays ?? 90,
          treeCount: opts.treeCount,
          taskCount: opts.taskCount,
        })
      }
      // BackupCard(GcTab 内嵌)解构 data.failed[0]。
      if (s.includes('/api/restore/pending')) return json({ pending: null, failed: [] })
      return json({})
    },
  )
}

beforeEach(async () => {
  archiveBodies = []
  configPuts = []
  await i18n.changeLanguage('en-US')
  setBaseUrl(`http://rfc311-archive-${crypto.randomUUID()}.test`)
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
      <GcTab config={{ ...DEFAULT_CONFIG, taskArchive: { ...DEFAULT_CONFIG.taskArchive } }} />
    </Wrapped>,
  )
}

describe('RFC-311 T19 · 手动批量归档入口', () => {
  test('第一次点击只预览,二次确认后才真正归档', async () => {
    install({ permissions: ['settings:write'], treeCount: 2, taskCount: 5 })
    renderGc()

    const run = await waitFor(() => screen.getByTestId('task-archive-run'))
    fireEvent.click(run)

    // 预览:dryRun 必须为 true,且这一步不允许出现任何删除请求。
    await waitFor(() => expect(archiveBodies).toHaveLength(1))
    expect(archiveBodies[0]!.dryRun).toBe(true)
    expect(archiveBodies[0]!.retentionDays).toBe(DEFAULT_CONFIG.taskArchive.retentionDays)

    // 二次确认对话框带上「几棵树 / 几个任务」的数量。
    const dialog = await waitFor(() => screen.getByRole('dialog'))
    expect(dialog.textContent).toMatch(/2 task tree/i)
    expect(dialog.textContent).toMatch(/5 task/i)

    fireEvent.click(screen.getByRole('button', { name: /archive and delete/i }))
    await waitFor(() => expect(archiveBodies).toHaveLength(2))
    expect(archiveBodies[1]!.dryRun).toBe(false)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByText(/Archived 2 task tree/i)).toBeTruthy()
  })

  test('没有可归档的树时不弹确认框,只给一句说明', async () => {
    install({ permissions: ['settings:write'], treeCount: 0, taskCount: 0 })
    renderGc()

    fireEvent.click(await waitFor(() => screen.getByTestId('task-archive-run')))
    await waitFor(() => expect(archiveBodies).toHaveLength(1))
    expect(await screen.findByText(/No task tree is old enough/i)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    // 预览之后没有任何后续请求 —— 尤其不能有 dryRun:false。
    expect(archiveBodies).toHaveLength(1)
  })

  test('归档开关能真的存下去(GC scope 白名单漏登记会被这条抓住)', async () => {
    // 回归锁:这两个键最初没进 SETTINGS_CONFIG_SCOPE_KEYS.gc,于是保存请求里
    // 根本没有 taskArchive——界面显示已开、点保存无报错、后台仍然是关的。
    install({ permissions: ['settings:write'], treeCount: 0, taskCount: 0 })
    renderGc()

    const toggle = (await waitFor(() =>
      screen.getByRole('checkbox', { name: /archive settled tasks automatically/i }),
    )) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => expect(configPuts).toHaveLength(1))
    expect(configPuts[0]).toMatchObject({
      taskArchive: { enabled: true, retentionDays: DEFAULT_CONFIG.taskArchive.retentionDays },
    })
  })

  test('没有 settings:write 的人看不到这个入口', async () => {
    install({ permissions: ['settings:read'], treeCount: 3, taskCount: 9 })
    renderGc()

    // 等 GC tab 自己渲染出来,再断言入口缺席(否则断言的是「还没渲染」)。
    await waitFor(() => expect(screen.getByTestId('settings-webhook-row-retention')).toBeTruthy())
    expect(screen.queryByTestId('task-archive-run')).toBeNull()
    expect(archiveBodies).toHaveLength(0)
  })
})
