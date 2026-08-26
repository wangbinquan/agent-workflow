// /tasks 列表在 WS 推送下的**就地更新**契约（用户反馈 2026-08-26：
// 「每次任务状态更新都会刷新整个任务列表，导致任务列表一直在闪」）。
//
// 旧实现（RFC-244 §5.3）收到帧后置脏、15 秒 `resetQueries` 整表重建：缓存清空
// ⇒ `query.isLoading` 翻 true ⇒ 整屏换成 `tasks-loading`，`TaskOperationsList`
// 连同 `VirtualList` 卸载重挂（滚动位置回顶），展开着的子分支塌成 spinner。
//
// 下面两条用例把「不许再这样」钉成 DOM 层判据：
//   ① 更新前给行元素打一个标记属性——重建会换掉 DOM 节点，标记随之消失；
//   ② 全程用 MutationObserver 盯 `tasks-loading` 是否被插入过一次。
// 两条断言在旧实现下都会红，且是用户真正在屏幕上看到的那件事。

import type {
  TaskOperationsChildPage,
  TaskOperationsListItem,
  TaskOperationsRootPage,
  TaskStatus,
} from '@agent-workflow/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

let captured: ((message: unknown) => void) | null = null

vi.mock('../src/hooks/useWebSocket', () => ({
  useWebSocket: ({ onMessage }: { onMessage: (message: unknown) => void }) => {
    captured = onMessage
    return { connected: true, connectionEpoch: 1 }
  },
}))

import '../src/i18n'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { catalogPageFromOperations } from './task-catalog-fixtures'

beforeEach(() => {
  captured = null
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

const actorPayload = {
  user: {
    id: 'admin',
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
  permissions: ['tasks:read', 'tasks:read:all'],
  linkedIdentities: [],
  pats: [],
}

function item(
  name: string,
  overrides: Partial<TaskOperationsListItem> = {},
): TaskOperationsListItem {
  const status: TaskStatus = overrides.status ?? 'done'
  return {
    id: `t_${name}`,
    name,
    workflowId: 'wf1',
    workflowName: 'Workflow one',
    repoPath: '/Users/w/proj/agent-workflow',
    repoUrl: null,
    cachedRepoId: null,
    status,
    startedAt: 1_700_000_000_000,
    finishedAt: status === 'running' ? null : 1_700_000_600_000,
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
    executionClock: {
      runningMs: 600_000,
      runningSince: status === 'running' ? 1_700_000_000_000 : null,
    },
    listContext: {
      matchKind: 'self',
      parentAvailability: 'none',
      qualifyingChildCount: 0,
      matchingDescendantCount: 0,
      branchStartedAt: 1_700_000_000_000,
    },
    ...overrides,
  }
}

function rootPage(items: TaskOperationsListItem[]): TaskOperationsRootPage {
  return {
    kind: 'root',
    items,
    nextCursor: null,
    facets: { all: items.length, active: 0, attention: 0, finished: items.length },
  }
}

function childPage(parentId: string, items: TaskOperationsListItem[]): TaskOperationsChildPage {
  return { kind: 'children', parentId, items, nextCursor: null }
}

/**
 * 每次请求都现读 `pages`，于是用例可以在推帧之前把服务端的答案换掉。
 *
 * `hold()` 之后目录请求**挂着不返回**，直到 `release()`——这一段就是真实网络的
 * 那几十到几百毫秒。旧实现正是在这段时间里把列表显示成空的：不复现延迟，
 * 清空与重填会在同一个 React 批次里合并掉，屏幕上那一闪在测试里根本不存在
 * （2026-08-26 实测：不带延迟时，把实现换回 resetQueries 这两条用例照样全绿）。
 */
function installFetch(pages: {
  root: () => TaskOperationsRootPage
  children?: (parentId: string) => TaskOperationsChildPage
}) {
  let holding = false
  const pending: Array<() => void> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = new URL(req.toString())
    if (url.pathname === '/api/auth/me') {
      return new Response(JSON.stringify(actorPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const parentId = url.searchParams.get('parent_id')
    const respond = () => {
      const page =
        parentId === null ? pages.root() : (pages.children?.(parentId) ?? childPage(parentId, []))
      return new Response(JSON.stringify(catalogPageFromOperations(page)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (!holding) return respond()
    return new Promise<Response>((resolve) => pending.push(() => resolve(respond())))
  })
  return {
    hold: () => {
      holding = true
    },
    inflight: () => pending.length,
    release: async () => {
      holding = false
      const queued = pending.splice(0, pending.length)
      await act(async () => {
        for (const resolve of queued) resolve()
      })
    },
  }
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
  return { client }
}

/** 记录整表 / 整分支 loading 是否在观察期内被插入过（重建的可见证据）。 */
function watchForFullReload(selector: string): { seen: () => number; stop: () => void } {
  let hits = 0
  const scan = (node: Node) => {
    if (!(node instanceof HTMLElement)) return
    if (node.matches(selector)) hits += 1
    else if (node.querySelector(selector) !== null) hits += 1
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(scan)
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return {
    seen: () => hits,
    stop: () => observer.disconnect(),
  }
}

const MARK = '__liveUpdateMark'

function mark(el: HTMLElement): void {
  ;(el as unknown as Record<string, unknown>)[MARK] = true
}

function stillTheSameNode(el: HTMLElement | null): boolean {
  return el !== null && (el as unknown as Record<string, unknown>)[MARK] === true
}

describe('/tasks — WS 推送就地更新，不整表重建', () => {
  test('状态帧就地把行改成 done，新任务自己进来，行的 DOM 节点全程不换', async () => {
    let root = rootPage([item('running-one', { status: 'running' }), item('older')])
    const net = installFetch({ root: () => root })
    await renderPage()

    const before = await screen.findByTestId('task-row-t_running-one')
    expect(
      before.querySelector('.status-chip--pulse'),
      '初始行不是运行态 ⇒ 这条用例后面的「状态就地翻面」无从谈起',
    ).not.toBeNull()
    mark(before)
    mark(screen.getByTestId('task-row-t_older'))
    const watcher = watchForFullReload('[data-testid="tasks-loading"]')

    // 服务端侧：那条任务跑完了，同时别处新建了一条（按开始时间倒序插在最前）。
    net.hold()
    root = rootPage([
      item('brand-new', { status: 'running', startedAt: 1_700_000_900_000 }),
      item('running-one'),
      item('older'),
    ])
    await act(async () => {
      captured?.({ type: 'task.status', taskId: 't_running-one', status: 'done' })
    })

    // ── 取数在途的这一刻，就是旧实现把屏幕清空的那一刻 ──────────────────
    await waitFor(() => expect(net.inflight(), '收到帧后压根没去取数').toBeGreaterThan(0))
    expect(
      screen.queryByTestId('tasks-loading'),
      '重取期间整张列表被 loading 顶替 ⇒ 用户看到的就是「闪一下」',
    ).toBeNull()
    expect(
      stillTheSameNode(screen.queryByTestId('task-row-t_running-one')),
      '重取期间既有行被拆掉了 ⇒ 滚动位置与展开态在这一刻就已经丢了',
    ).toBe(true)

    await net.release()

    // ① 新任务无需任何点击就进了列表（用户 2026-08-26 拍板「新行也自动进来」）。
    await screen.findByTestId('task-row-t_brand-new')
    // ② 那一行就地翻成了 done。
    await waitFor(() => {
      const row = screen.getByTestId('task-row-t_running-one')
      expect(row.querySelector('.status-chip--success'), '状态没有就地更新').not.toBeNull()
      expect(row.querySelector('.status-chip--pulse'), '运行态的呼吸点没有撤掉').toBeNull()
    })
    watcher.stop()

    // ③ 全程零整表 loading，既有行的 DOM 节点也一个没换。
    expect(watcher.seen(), '同步过程中出现过整表 loading').toBe(0)
    expect(
      stillTheSameNode(screen.queryByTestId('task-row-t_running-one')),
      '行被换成了新的 DOM 节点 ⇒ 列表是整表重建出来的，滚动位置和展开态都会丢',
    ).toBe(true)
    expect(
      stillTheSameNode(screen.queryByTestId('task-row-t_older')),
      '没被这条帧提到的行也被重建了 ⇒ 整张表被推倒重来',
    ).toBe(true)
  })

  test('展开着的子分支在同步后仍然展开，子行的 DOM 节点也不换', async () => {
    const parent = item('parent', {
      status: 'running',
      childCount: 1,
      listContext: {
        matchKind: 'self',
        parentAvailability: 'none',
        qualifyingChildCount: 1,
        matchingDescendantCount: 1,
        branchStartedAt: 1_700_000_000_000,
      },
    })
    const kid = item('kid', {
      status: 'running',
      parentTaskId: parent.id,
      invocationDepth: 1,
      listContext: {
        matchKind: 'self',
        parentAvailability: 'visible',
        qualifyingChildCount: 0,
        matchingDescendantCount: 0,
        branchStartedAt: 1_700_000_000_000,
      },
    })
    let kidStatus: TaskStatus = 'running'
    const net = installFetch({
      root: () => rootPage([parent]),
      children: () => childPage(parent.id, [{ ...kid, status: kidStatus }]),
    })
    await renderPage()

    fireEvent.click(await screen.findByTestId('task-expand-t_parent'))
    mark(await screen.findByTestId('task-row-t_kid'))
    const watcher = watchForFullReload(
      '[data-testid="tasks-loading"], [data-testid="task-children-loading-t_parent"]',
    )

    net.hold()
    kidStatus = 'done'
    await act(async () => {
      captured?.({ type: 'task.status', taskId: 't_kid', status: 'done' })
    })

    await waitFor(() => expect(net.inflight(), '收到帧后压根没去取数').toBeGreaterThan(0))
    expect(
      stillTheSameNode(screen.queryByTestId('task-row-t_kid')),
      '重取期间展开的分支被清空 ⇒ 用户正在看的子树塌成一个 spinner',
    ).toBe(true)

    await net.release()

    await waitFor(() => {
      expect(
        screen.getByTestId('task-row-t_kid').querySelector('.status-chip--success'),
        '子行的状态没有就地更新',
      ).not.toBeNull()
    })
    watcher.stop()

    expect(
      screen.getByTestId('task-expand-t_parent').getAttribute('aria-expanded'),
      '同步之后分支自己收起来了 ⇒ 用户每看一会儿就要重新展开一遍',
    ).toBe('true')
    expect(watcher.seen(), '子分支同步时出现过 loading 态').toBe(0)
    expect(
      stillTheSameNode(screen.queryByTestId('task-row-t_kid')),
      '子行被重建 ⇒ 展开的分支是被清空后重新取回来的',
    ).toBe(true)
  })
})
