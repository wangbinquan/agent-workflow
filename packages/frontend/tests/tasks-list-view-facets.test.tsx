// 锁定 /tasks 页签计数的两条性质（用户 2026-09-04 报「点每个页签，其他页签数字都
// 会变，还每次变的都不一样」）：
//
//   1. 计数只由服务端 facets 决定，而 facets 与 view 无关（契约锁在
//      `packages/backend/tests/rfc244-task-operations.test.ts` 的
//      「facets ignore view」与 rfc349 的跨 provider 守卫里）——所以换页签后四个
//      数字必须原样不动；
//   2. 换页签会换 queryKey（`view` 在 key 里），新请求在飞行期间 `query.data` 是
//      undefined。此前那里直接回退 `EMPTY_FACETS`，于是四个数字**先一起归零再跳
//      回来**；现在沿用上一次已知的 facets，飞行期间不闪。
//
// 第 2 条是这个文件的主锚点：把第二次请求挂住不返回，计数仍须是原来那四个数。

import type { TaskOperationsListItem, TaskOperationsRootPage } from '@agent-workflow/shared'
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
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { catalogPageFromOperations } from './task-catalog-fixtures'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const FACETS = { all: 9, active: 4, attention: 3, finished: 5 } as const

function item(name: string): TaskOperationsListItem {
  return {
    id: `t_${name}`,
    name,
    workflowId: 'wf1',
    workflowName: 'Workflow one',
    repoPath: '/Users/w/proj/agent-workflow',
    repoUrl: null,
    cachedRepoId: null,
    status: 'done',
    startedAt: Date.now() - 3_600_000,
    finishedAt: Date.now() - 3_000_000,
    errorSummary: null,
    repoCount: 1,
    openAlertCount: 0,
    scheduledTaskId: null,
    workgroupId: null,
    workgroupName: null,
    spaceKind: 'remote',
    parentTaskId: null,
    invocationDepth: 0,
    sourceAgentName: null,
    sourceAgentId: null,
    childCount: 0,
    ownerUserId: 'u1',
    owner: { id: 'u1', username: 'alice', displayName: 'Alice' },
    executionClock: { runningMs: 600_000, runningSince: null },
    listContext: {
      matchKind: 'self',
      parentAvailability: 'none',
      qualifyingChildCount: 0,
      matchingDescendantCount: 0,
      branchStartedAt: Date.now() - 3_600_000,
    },
  }
}

function rootPage(items: TaskOperationsListItem[]): TaskOperationsRootPage {
  return { kind: 'root', items, nextCursor: null, facets: { ...FACETS } }
}

const actorPayload = {
  user: { id: 'admin', username: 'admin', displayName: 'Admin', role: 'admin', status: 'active' },
  source: 'session',
  permissions: ['tasks:read', 'tasks:read:all'],
  linkedIdentities: [],
  pats: [],
}

/** 服务端对每个 view 都回同一份 facets（这正是后端契约）。`holdView` 指定的那个
 *  view 的请求会被挂住，直到调用返回的 `release()`。 */
function installFetch(holdView: string) {
  let release: (() => void) | null = null
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const views: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = new URL(req.toString())
    if (url.pathname === '/api/auth/me') {
      return new Response(JSON.stringify(actorPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const view = url.searchParams.get('view') ?? 'all'
    views.push(view)
    if (view === holdView) await held
    return new Response(JSON.stringify(catalogPageFromOperations(rootPage([item('one')]))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return { views, release: () => release?.() }
}

async function renderPage() {
  const list = await import('../src/routes/tasks')
  const root = createRootRoute({ component: () => <Outlet /> })
  const tasks = createRoute({
    getParentRoute: () => root,
    path: '/tasks',
    component: list.Route.options.component,
    validateSearch: list.Route.options.validateSearch,
  })
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <div data-testid="stub" /> })
  const router = createRouter({
    routeTree: root.addChildren([
      tasks,
      stub('/tasks/$id'),
      stub('/tasks/new'),
      stub('/scheduled/$id'),
      stub('/workflows/$id'),
      stub('/workgroups/$id'),
      stub('/agents/$id'),
    ]),
    history: createMemoryHistory({ initialEntries: ['/tasks'] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

function tabCounts(): Record<string, string> {
  const counts: Record<string, string> = {}
  for (const view of ['all', 'active', 'attention', 'finished']) {
    const option = screen.getByTestId(`tasks-view-${view}`)
    counts[view] = option.querySelector('.operations-toolbar__count')?.textContent ?? ''
  }
  return counts
}

describe('/tasks — 页签计数', () => {
  test('切页签时保留上一次的 facets，不在请求飞行期间归零', async () => {
    const fetchMock = installFetch('active')
    await renderPage()
    await waitFor(() => expect(tabCounts().all).toBe('9'))
    expect(tabCounts()).toEqual({ all: '9', active: '4', attention: '3', finished: '5' })

    fireEvent.click(screen.getByTestId('tasks-view-active'))
    // 「进行中」这一次请求被挂住：此刻 query.data 是 undefined。
    await waitFor(() => expect(fetchMock.views).toContain('active'))
    expect(tabCounts()).toEqual({ all: '9', active: '4', attention: '3', finished: '5' })

    fetchMock.release()
    await waitFor(() => expect(screen.queryByTestId('tasks-loading')).toBeNull())
    expect(tabCounts()).toEqual({ all: '9', active: '4', attention: '3', finished: '5' })
  })

  test('四个页签轮着点，计数始终跟随服务端 facets（与 view 无关）', async () => {
    const fetchMock = installFetch('__none__')
    await renderPage()
    await waitFor(() => expect(tabCounts().all).toBe('9'))

    for (const view of ['attention', 'finished', 'active', 'all']) {
      fireEvent.click(screen.getByTestId(`tasks-view-${view}`))
      await waitFor(() => expect(fetchMock.views).toContain(view))
      await waitFor(() =>
        expect(tabCounts()).toEqual({ all: '9', active: '4', attention: '3', finished: '5' }),
      )
    }
  })
})
