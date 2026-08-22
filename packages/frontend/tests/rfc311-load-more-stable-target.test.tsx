// RFC-311 —— 「Load more」按钮在加载期间必须是**同一个、可点的** DOM 节点。
//
// 为什么存在：PR-5 把 /tasks 与 /repos 窗口化后，VirtualList 带了一个距底 400px
// 的滚动哨兵（`onReachEnd`），而 Load more 按钮就挂在最底部的 `tail` 槽位。两者写
// 的是**同一份状态**，于是任何人（Playwright 或真人）为了点它把它滚进视口，那一下
// 就触发了哨兵：最后一页到达后 `hasNextPage` 转 false，按钮在指针底下**合法卸载**。
// 浏览器侧的症状是 `element was detached from the DOM, retrying` 循环到超时：
//   e2e-webkit-nightly 32229170740（sha d4e7e514）shard 2/4，
//   rfc244-task-operations.spec.ts:162 与 :267 双双 15s 超时。
//   chromium 侥幸没复现——它常常不需要滚动就点到了，所以主 CI 一直是绿的。
//
// 锁死三条不变量（第 3 条才是浏览器真正需要的那条）：
//   1. 可及名（accessible name）在加载前后**不变**；
//   2. 加载中**不 disabled**——disabled 会吞掉点击，且键盘用户焦点会被弹走；
//   3. 加载前后是**同一个 DOM 节点**（identity 相等）——这正是「detached」的反面。
//
// 定案：**显式按钮在场时不再挂哨兵**（本地 webkit 实跑 8/8 绿，且零视觉基线变更）；
// 加载状态改由按钮的 `aria-busy` + 一条 sr-only 旁白承载，不再靠改文案 / disabled。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    spaceKind: 'remote' as const,
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

const actorPayload = {
  user: { id: 'admin', username: 'admin', displayName: 'Admin', role: 'admin', status: 'active' },
  source: 'session',
  permissions: ['tasks:read', 'tasks:read:all'],
  linkedIdentities: [],
  pats: [],
}

function rootPage(
  items: TaskOperationsListItem[],
  nextCursor: string | null,
): TaskOperationsRootPage {
  return {
    kind: 'root',
    items,
    nextCursor,
    facets: { all: items.length, active: 0, attention: 0, finished: items.length },
  }
}

/**
 * cursor 请求全部由测试**手动放行**——只有让 `isFetchingNextPage` 稳定停在 true，
 * 才能观察「加载中」那一帧的按钮形态；用真实 resolve 的 fetch 会瞬间跳过它。
 *
 * 注意 jsdom 里所有尺寸都是 0，于是 VirtualList 距底 400px 的哨兵**挂载即触发**——
 * 这恰好复现了 webkit 上的现场：页面一出来第二页就已经在飞。
 */
function installFetch(first: TaskOperationsRootPage, second: TaskOperationsRootPage) {
  const pending: Array<() => void> = []
  const cursorRequests = { count: 0 }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = new URL(req.toString())
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (url.pathname === '/api/auth/me') return json(actorPayload)
    if (!url.searchParams.has('cursor')) return json(catalogPageFromOperations(first))
    cursorRequests.count += 1
    await new Promise<void>((resolve) => pending.push(resolve))
    return json(catalogPageFromOperations(second))
  })
  return {
    cursorRequests,
    releaseAll: () => {
      while (pending.length > 0) pending.shift()!()
    },
  }
}

async function renderTasks() {
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

describe('RFC-311 — the Load more target survives its own loading state', () => {
  test('stable name, never disabled, and the very same node across the load', async () => {
    const gate = installFetch(
      rootPage([item('a'), item('b')], 'cursor-page-2'),
      rootPage([item('a'), item('b'), item('c')], 'cursor-page-3'),
    )
    await renderTasks()

    // 没有哨兵抢跑：按钮以**空闲**形态出现，翻页只由这一次点击驱动。
    const button = await screen.findByRole('button', { name: 'Load more tasks' })
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.getAttribute('aria-busy')).toBeNull()
    // 尾部必须是 listitem：容器是 role="list"，塞一个非 listitem 的可聚焦子元素
    // 会触发 axe `aria-required-children`（critical）。此前哨兵抢先加载完、尾部
    // 早已卸载，反而把这条违规**遮住**了，webkit 实跑才暴露出来。
    expect(button.closest('[role="listitem"]'), '翻页尾部必须是 listitem').not.toBeNull()

    fireEvent.click(button)
    await waitFor(() => expect(gate.cursorRequests.count).toBe(1))

    // 加载中：名字不变、仍可点、且**还是同一个节点**。
    const during = screen.getByRole('button', { name: 'Load more tasks' })
    expect(during, 'DOM 身份必须保持——换节点就是浏览器侧的 element detached').toBe(button)
    expect(during.getAttribute('aria-busy'), '加载态应由 aria-busy 承载').toBe('true')
    expect(during.hasAttribute('disabled'), 'disabled 会吞掉点击并弹走键盘焦点').toBe(false)

    // 加载中再点是安全的空操作（不重复发页）。
    fireEvent.click(during)
    expect(gate.cursorRequests.count).toBe(1)

    // 旁白**不能**是可命中的相邻节点：第一版把它落成 <span class="muted">，
    // webkit 当场报 `<span role="status" …> intercepts pointer events`，点击照样
    // 落不下去。它只该说给屏幕阅读器听，所以必须是 sr-only（且 sr-only 全局
    // pointer-events:none，见下面的样式判据）。
    const tail = button.closest('.task-operations__more')!
    const status = within(tail as HTMLElement).getByRole('status')
    expect(status.className, '加载旁白必须 sr-only，否则会挡住它旁边的按钮').toContain('sr-only')

    gate.releaseAll()
    await waitFor(() => expect(screen.getByTestId('task-row-t_c')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Load more tasks' })).toBe(button)
  })
})

// 上面那条只能断言「用了 sr-only」；sr-only 本身**必须**不吃指针事件，否则同样的
// 拦截会换个地方复发（它是绝对定位元素，包含块是最近的定位祖先，可能正好压在按钮
// 的命中点上）。jsdom 不做命中测试，所以这里退到源码层判据兜底。
describe('RFC-311 — sr-only 永不作为指针目标', () => {
  test('the sr-only primitive declares pointer-events: none', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
    const rule = /\.sr-only\s*\{[^}]*\}/.exec(css)
    expect(rule, '.sr-only 规则找不到了——判据失效比断言失败更危险').not.toBeNull()
    expect(rule![0]).toContain('pointer-events: none')
  })
})
