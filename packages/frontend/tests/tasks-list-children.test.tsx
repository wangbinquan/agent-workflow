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
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
  return router
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
    const branch = row.closest('li')?.querySelector<HTMLOListElement>(':scope > ol')
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
    const router = await renderPage()
    const arrow = await screen.findByTestId('task-expand-t_parent')

    fireEvent.click(arrow)
    const childRow = await screen.findByTestId('task-row-t_kid')
    expect(urls.some((url) => url.includes('parent_id=t_parent'))).toBe(true)
    expect(childRow.classList.contains('task-operations__row--child')).toBe(true)
    expect(childRow.closest('li')?.getAttribute('data-depth')).toBe('1')
    expect(childRow.closest('ol.task-operations__children')).not.toBeNull()
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
    installFetch(rootPage([context]), () =>
      childPage(context.id, [item('matching-child', { parentTaskId: context.id })]),
    )
    await renderPage()

    const child = await screen.findByTestId('task-row-t_matching-child')
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

  test('desktop density stays at 56px for roots and 48px for children', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf-8')
    expect(css).toMatch(/\.task-operations__row\s*\{[^}]*min-height:\s*56px/s)
    expect(css).toMatch(/\.task-operations__row--child\s*\{[^}]*min-height:\s*48px/s)
  })
})
