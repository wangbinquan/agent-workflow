// RFC-244 — native nested task-list behavior and bounded child pagination.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  TaskOperationsChildPage,
  TaskOperationsListItem,
  TaskOperationsRootPage,
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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function item(
  name: string,
  overrides: Partial<TaskOperationsListItem> = {},
): TaskOperationsListItem {
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
    ...overrides,
  }
}

const actorPayload = {
  user: {
    id: 'admin',
    username: 'admin',
    displayName: 'Admin',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
  permissions: ['tasks:read:all'],
  linkedIdentities: [],
  pats: [],
}

function rootPage(items: TaskOperationsListItem[]): TaskOperationsRootPage {
  return {
    kind: 'root',
    items,
    nextCursor: null,
    facets: { all: items.length, active: 0, attention: 0, finished: items.length },
  }
}

function childPage(
  parentId: string,
  items: TaskOperationsListItem[],
  nextCursor: string | null = null,
): TaskOperationsChildPage {
  return { kind: 'children', parentId, items, nextCursor }
}

function installFetch(
  root: TaskOperationsRootPage,
  resolveChildren: (url: URL) => TaskOperationsChildPage,
) {
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = new URL(req.toString())
    urls.push(url.toString())
    const payload =
      url.pathname === '/api/auth/me'
        ? actorPayload
        : url.searchParams.has('parent_id')
          ? resolveChildren(url)
          : root
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return urls
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
  // RFC-311：把 QueryClient 也交出去。两跳（根页 → 自动展开 → 子页）的用例不能靠
  // `findByTestId` 的**默认 1000ms** 兜底——那是固定超时竞争，在最慢的 runner 上必然
  // 越线（实撞：windows shard 2/3 唯一红，8225ms；本机 12/12 全过，越快的机器越照不出）。
  // 有了 client 就能等「请求已发出 + 所有查询空闲」这个确定性锚点。
  return { router, client }
}

describe('/tasks — bounded child branches (RFC-244)', () => {
  test('expand affordances follow qualifying children and keep native list semantics', async () => {
    const urls = installFetch(
      rootPage([
        item('visible', {
          childCount: 4,
          listContext: {
            matchKind: 'self',
            parentAvailability: 'none',
            qualifyingChildCount: 2,
            matchingDescendantCount: 2,
            branchStartedAt: Date.now(),
          },
        }),
        item('filtered-out', { childCount: 4 }),
      ]),
      (url) => childPage(url.searchParams.get('parent_id')!, []),
    )
    await renderPage()
    const row = await screen.findByTestId('task-row-t_visible')

    expect(screen.getByTestId('task-expand-t_visible')).toBeTruthy()
    expect(screen.queryByTestId('task-expand-t_filtered-out')).toBeNull()
    // RFC-311：顶层进 VirtualList 窗口化后,行是 div[role=listitem](sizer div
    // 不能作 <ol> 子元素),list 语义靠 role 断言——与 §Frontend UI consistency
    // 「优先 role 锚点」一致。
    const branch = row
      .closest('[role="listitem"]')
      ?.querySelector<HTMLElement>(':scope > [role="list"]')
    expect(branch?.hidden).toBe(true)
    expect(row.closest('table')).toBeNull()
    expect(urls.every((url) => !url.includes('include_children'))).toBe(true)
    expect(urls.some((url) => url.includes('parent_id='))).toBe(false)
  })

  test('expanding lazily fetches a bounded child page and the arrow never navigates', async () => {
    const parent = item('parent', {
      childCount: 1,
      listContext: {
        matchKind: 'self',
        parentAvailability: 'none',
        qualifyingChildCount: 1,
        matchingDescendantCount: 1,
        branchStartedAt: Date.now(),
      },
    })
    const kid = item('kid', {
      parentTaskId: parent.id,
      invocationDepth: 1,
      listContext: {
        matchKind: 'self',
        parentAvailability: 'visible',
        qualifyingChildCount: 0,
        matchingDescendantCount: 0,
        branchStartedAt: Date.now(),
      },
    })
    const urls = installFetch(rootPage([parent]), (_url) => childPage(parent.id, [kid]))
    const { router } = await renderPage()
    const arrow = await screen.findByTestId('task-expand-t_parent')

    fireEvent.click(arrow)
    const childRow = await screen.findByTestId('task-row-t_kid')
    expect(urls.some((url) => url.includes('parent_id=t_parent'))).toBe(true)
    expect(childRow.classList.contains('task-operations__row--child')).toBe(true)
    expect(childRow.closest('[role="listitem"]')?.getAttribute('data-depth')).toBe('1')
    expect(childRow.closest('[role="list"].task-operations__children')).not.toBeNull()
    expect(arrow.getAttribute('aria-expanded')).toBe('true')
    expect(router.state.location.pathname).toBe('/tasks')

    fireEvent.click(arrow)
    expect(screen.queryByTestId('task-row-t_kid')).toBeNull()
    expect(arrow.getAttribute('aria-expanded')).toBe('false')
  })

  test('context roots auto-expand, then honor a manual collapse', async () => {
    const context = item('context', {
      childCount: 1,
      listContext: {
        matchKind: 'context',
        parentAvailability: 'none',
        qualifyingChildCount: 1,
        matchingDescendantCount: 1,
        branchStartedAt: Date.now(),
      },
    })
    const urls = installFetch(rootPage([context]), () =>
      childPage(context.id, [item('matching-child', { parentTaskId: context.id })]),
    )
    const { client } = await renderPage()

    // 这条用例在 windows shard 上红过一次（8225ms，ubuntu/macos 同 shard 全绿，job 96341991820）。
    // CI 的 DOM dump 显示根行、展开箭头、`aria-expanded="true"` 全都对——自动展开确实发生了，
    // 只是子页数据没在全局 `asyncUtilTimeout: 5000`（tests/setup.ts）内到达。
    //
    // 真因是**预算分配**，不是这条用例本身慢：同文件手动展开那条的等待天然分成两段——
    // 先 `findByTestId(arrow)` 等根数据（吃一份 5s），click 之后再 `findByTestId(child)`
    // 等子数据（再吃一份 5s）。而自动展开这条只有一次 `findByTestId`，却要用**同一份 5s**
    // 覆盖「根查询 → 识别 context root → 自动展开 → 子查询」整条三跳链。windows runner 实测
    // 慢约 10x，于是只有它撞墙，其余用例（95–272ms）都够用。
    //
    // 两件事一起做，缺一不可：
    //   1. **确定性锚点**——先等子页请求真的发出去（证明展开发生了），再等所有查询空闲
    //      （证明数据已到位）。这同时把三跳链拆回多段，与同文件其他用例的结构对齐。
    //   2. **显式预算**——锚点本身仍走 waitFor，默认吃的就是那 5 秒；不显式抬高，锚点再确定
    //      也照样在同一堵墙上撞死。testTimeout 是 30s，这里留 15s 余量。
    const SLOW_RUNNER_BUDGET = { timeout: 15_000 }
    await waitFor(() => {
      expect(urls.some((u) => u.includes(`parent_id=${context.id}`))).toBe(true)
    }, SLOW_RUNNER_BUDGET)
    await waitFor(() => {
      expect(client.isFetching()).toBe(0)
    }, SLOW_RUNNER_BUDGET)
    const child = await screen.findByTestId('task-row-t_matching-child', {}, SLOW_RUNNER_BUDGET)
    expect(child).toBeTruthy()
    const arrow = screen.getByTestId('task-expand-t_context')
    expect(arrow.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(arrow)
    expect(screen.queryByTestId('task-row-t_matching-child')).toBeNull()
    expect(arrow.getAttribute('aria-expanded')).toBe('false')
  })

  test('child cursors paginate independently and append rows', async () => {
    const parent = item('paged-parent', {
      childCount: 2,
      listContext: {
        matchKind: 'self',
        parentAvailability: 'none',
        qualifyingChildCount: 2,
        matchingDescendantCount: 2,
        branchStartedAt: Date.now(),
      },
    })
    const urls = installFetch(rootPage([parent]), (url) =>
      url.searchParams.get('cursor') === 'next-child'
        ? childPage(parent.id, [item('child-two', { parentTaskId: parent.id })])
        : childPage(parent.id, [item('child-one', { parentTaskId: parent.id })], 'next-child'),
    )
    await renderPage()
    fireEvent.click(await screen.findByTestId('task-expand-t_paged-parent'))
    await screen.findByTestId('task-row-t_child-one')
    fireEvent.click(screen.getByRole('button', { name: /load more child tasks/i }))

    await screen.findByTestId('task-row-t_child-two')
    expect(
      urls.some(
        (url) => url.includes('parent_id=t_paged-parent') && url.includes('cursor=next-child'),
      ),
    ).toBe(true)
  })

  test('unavailable ancestry is rendered from the list contract without a detail probe', async () => {
    const urls = installFetch(
      rootPage([
        item('orphan', {
          parentTaskId: 't_hidden',
          invocationDepth: 1,
          listContext: {
            matchKind: 'self',
            parentAvailability: 'unavailable',
            qualifyingChildCount: 0,
            matchingDescendantCount: 0,
            branchStartedAt: Date.now(),
          },
        }),
      ]),
      (url) => childPage(url.searchParams.get('parent_id')!, []),
    )
    await renderPage()
    const chip = await screen.findByTestId('task-parent-unavailable-t_orphan')
    expect(chip.tagName).toBe('SPAN')
    expect(urls.some((url) => new URL(url).pathname === '/api/tasks/t_hidden')).toBe(false)
  })

  test('cached filter changes reset the result scroll while pagination preserves it', async () => {
    const page = rootPage([item('scroll-anchor')])
    page.nextCursor = 'next-root'
    const urls = installFetch(page, (url) => childPage(url.searchParams.get('parent_id')!, []))
    const { router } = await renderPage()
    await screen.findByTestId('task-row-t_scroll-anchor')

    // Populate the second filter's cache first. Returning to the already-cached
    // all view reuses the same <ol>, which is the production failure mode.
    await router.navigate({ to: '/tasks', search: { view: 'active' } })
    await waitFor(() =>
      expect(urls.some((url) => new URL(url).searchParams.get('view') === 'active')).toBe(true),
    )
    const list = document.querySelector<HTMLOListElement>('.task-operations__list')!
    list.scrollTop = 480
    await router.navigate({ to: '/tasks', search: {} })
    await waitFor(() => expect(list.scrollTop).toBe(0))

    // Appending another page is the same result set and must not throw the
    // reader back to the beginning.
    list.scrollTop = 275
    fireEvent.click(screen.getByRole('button', { name: /load more tasks/i }))
    await waitFor(() =>
      expect(urls.some((url) => new URL(url).searchParams.get('cursor') === 'next-root')).toBe(
        true,
      ),
    )
    expect(list.scrollTop).toBe(275)
  })

  test('desktop density stays at 56px for roots and 48px for children', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
    expect(css).toMatch(/\.task-operations__row\s*\{[^}]*min-height:\s*56px/s)
    expect(css).toMatch(/\.task-operations__row--child\s*\{[^}]*min-height:\s*48px/s)
  })
})
