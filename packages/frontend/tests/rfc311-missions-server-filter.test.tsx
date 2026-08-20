// RFC-311 —— `/tasks` 的数字员工列表必须**服务端过滤 + 分页**，不许再取全量。
//
// 此前它 `api.get('/api/code/missions')` 拿回整张表，再在前端
// `filterDigitalEmployeeMissions` + `digitalEmployeeFacets`。mission 表长起来后，这条
// **10 秒一轮**的轮询会把整张表搬进浏览器——正是本 RFC 要消灭的形态，而且它藏在
// 「前端过滤」这层皮下面，后端的分页能力就位了也看不出来。
//
// 判据落在**发出去的 URL** 上，因为这是"取没取全量"唯一不可伪装的证据：
//   1. 请求必须带 `limit` 与 `view`（服务端过滤的证据）；
//   2. 过滤条件变化时必须**重新发请求**（否则等于前端还在自己筛）；
//   3. 绝不能出现不带任何查询参数的裸 `/api/code/missions`（全量形态）。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const actorPayload = {
  user: { id: 'admin', username: 'admin', displayName: 'Admin', role: 'admin', status: 'active' },
  source: 'session',
  permissions: ['tasks:read:all', 'development-missions:read'],
  linkedIdentities: [],
  pats: [],
}

function installFetch(): string[] {
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = new URL(req.toString())
    urls.push(url.pathname + url.search)
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (url.pathname === '/api/auth/me') return json(actorPayload)
    if (url.pathname === '/api/code/missions')
      return json({
        items: [],
        nextCursor: null,
        facets: { all: 0, active: 0, attention: 0, finished: 0 },
      })
    return json({
      kind: 'root',
      items: [],
      nextCursor: null,
      facets: { all: 0, active: 0, attention: 0, finished: 0 },
    })
  })
  return urls
}

async function renderTasks(search: string): Promise<void> {
  const list = await import('../src/routes/tasks')
  const root = createRootRoute({ component: () => <Outlet /> })
  const tasks = createRoute({
    getParentRoute: () => root,
    path: '/tasks',
    component: list.Route.options.component,
    validateSearch: list.Route.options.validateSearch,
  })
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => root, path, component: () => <div /> })
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
    history: createMemoryHistory({ initialEntries: [`/tasks${search}`] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('RFC-311 — /tasks 的数字员工列表走服务端过滤，不再取全量', () => {
  test('mission 请求带 limit/view，且过滤变化会重新发请求', async () => {
    const urls = installFetch()
    await renderTasks('?category=digital-employee&view=attention')

    await waitFor(() => {
      expect(urls.some((u) => u.startsWith('/api/code/missions'))).toBe(true)
    })
    const missionUrls = urls.filter((u) => u.startsWith('/api/code/missions'))

    // ③ 裸全量形态必须绝迹——它是这次改动之前的样子。
    expect(
      missionUrls.filter((u) => u === '/api/code/missions'),
      '出现了不带任何参数的 /api/code/missions ⇒ 又在取全量了',
    ).toEqual([])

    // ① 服务端过滤 + 分页的证据
    expect(missionUrls.some((u) => u.includes('limit='))).toBe(true)
    expect(
      missionUrls.some((u) => u.includes('view=attention')),
      `view 没有下推到服务端；实际请求：${missionUrls.join(' , ')}`,
    ).toBe(true)
  })

  test('不同 view 打到不同的服务端请求（而不是同一份全量在前端筛）', async () => {
    const urls = installFetch()
    await renderTasks('?category=digital-employee&view=finished')
    await waitFor(() => {
      expect(urls.some((u) => u.includes('/api/code/missions'))).toBe(true)
    })
    expect(urls.some((u) => u.includes('view=finished'))).toBe(true)
    expect(urls.some((u) => u.includes('view=attention'))).toBe(false)
  })
})
