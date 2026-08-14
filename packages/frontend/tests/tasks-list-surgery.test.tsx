// RFC-244 — dense task operations page behavior.
//
// 2026-08-14 regression: after visiting /tasks, a navigation to the Memory
// deep link (/memory?tab=all) must commit instead of being mistaken for raw
// task-search state and canonicalized back to /tasks.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  Link,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import type { TaskOperationsListItem, TaskOperationsRootPage } from '@agent-workflow/shared'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    owner: { id: 'u1', username: 'alice', displayName: 'Alice Owner' },
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

function rootPage(
  items: TaskOperationsListItem[],
  facets?: Partial<TaskOperationsRootPage['facets']>,
) {
  return {
    kind: 'root' as const,
    items,
    nextCursor: null,
    facets: {
      all: items.length,
      active: items.filter((row) => row.status === 'running').length,
      attention: items.filter((row) => row.status === 'failed').length,
      finished: items.filter((row) => row.status === 'done' || row.status === 'failed').length,
      ...facets,
    },
  }
}

function installFetch(resolvePage: (url: URL) => TaskOperationsRootPage) {
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = new URL(req.toString())
    urls.push(url.toString())
    const payload = url.pathname === '/api/auth/me' ? actorPayload : resolvePage(url)
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return urls
}

async function renderPage(initialEntry = '/tasks') {
  const list = await import('../src/routes/tasks')
  const root = createRootRoute({
    component: () => (
      <>
        <Link to="/memory" search={{ tab: 'all' }} data-testid="memory-nav-probe">
          Memory
        </Link>
        <Outlet />
      </>
    ),
  })
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
      stub('/memory'),
    ]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { router, client }
}

describe('/tasks — dense operations list (RFC-244)', () => {
  test('uses the page endpoint and native nested-list semantics with full Owner text', async () => {
    const urls = installFetch(() =>
      rootPage([
        item('failed task', {
          status: 'failed',
          errorSummary: 'node exec failed: exited 1',
          owner: {
            id: 'u1',
            username: 'alice-with-a-long-username',
            displayName: 'Alice Owner With A Long Display Name',
          },
        }),
      ]),
    )
    await renderPage()

    const row = await screen.findByTestId('task-row-t_failed task')
    expect(urls.some((url) => url.includes('/api/tasks/page') && url.includes('limit=50'))).toBe(
      true,
    )
    expect(row.closest('ol.task-operations__list')).not.toBeNull()
    expect(row.closest('table')).toBeNull()
    expect(row.textContent).toContain('Alice Owner With A Long Display Name')
    expect(row.textContent).toContain('@alice-with-a-long-username')
    expect(row.querySelector('.owner-label--wrap')).not.toBeNull()
    expect(row.querySelector('.task-operations__name')?.getAttribute('title')).toBe('failed task')
    expect(row.querySelector('.task-operations__detail')?.getAttribute('title')).toBe(
      'node exec failed: exited 1',
    )
    await waitFor(() =>
      expect(screen.getByTestId('managed-live-region').textContent).toContain(
        '1 task branches shown',
      ),
    )
  })

  test('legacy/default/unknown search params are replaced by the canonical shareable URL', async () => {
    installFetch(() => rootPage([item('canonical')]))
    const { router } = await renderPage(
      '/tasks?view=all&status=running&scope=all&bogus=x&q=%20needle%20',
    )
    await screen.findByTestId('task-row-t_canonical')

    await waitFor(() => expect(router.state.location.href).toBe('/tasks?q=needle&statuses=running'))
    expect(router.state.location.search).toEqual({ q: 'needle', statuses: 'running' })
  })

  test('a searched destination can commit after the task page has settled', async () => {
    installFetch(() => rootPage([item('navigation')]))
    const { router } = await renderPage()
    await screen.findByTestId('task-row-t_navigation')

    fireEvent.click(screen.getByTestId('memory-nav-probe'))

    await waitFor(() => expect(router.state.location.href).toBe('/memory?tab=all'))
  })

  test('business views use server facets and change the URL/request', async () => {
    const urls = installFetch((url) => {
      const view = url.searchParams.get('view')
      return rootPage(view === 'active' ? [item('live', { status: 'running' })] : [item('all')], {
        all: 9,
        active: 3,
        attention: 2,
        finished: 6,
      })
    })
    const { router } = await renderPage()
    await screen.findByTestId('task-row-t_all')
    expect(screen.getByTestId('tasks-view-active').textContent).toContain('3')

    fireEvent.click(screen.getByTestId('tasks-view-active'))
    await screen.findByTestId('task-row-t_live')
    expect(router.state.location.search).toMatchObject({ view: 'active' })
    expect(urls.some((url) => url.includes('view=active'))).toBe(true)
  })

  test('advanced filters use the shared Dialog and MultiSelect then round-trip in URL', async () => {
    installFetch(() => rootPage([item('filterable')]))
    const { router } = await renderPage()
    await screen.findByTestId('task-row-t_filterable')
    fireEvent.click(screen.getByTestId('tasks-filter-button'))
    const dialog = await screen.findByTestId('tasks-filter-dialog')
    expect(within(dialog).getByRole('dialog')).toBeTruthy()
    expect(screen.queryByRole('listbox', { name: /exact status/i })).toBeNull()
    const originGroup = within(dialog).getByRole('radiogroup', { name: /launch origin/i })
    expect(
      within(originGroup)
        .getAllByRole('radio')
        .map((radio) => radio.textContent),
    ).toEqual(['All origins', 'Manual', 'Scheduled', 'Webhook', 'API'])

    const statusInput = within(dialog).getByRole('combobox', { name: /exact status/i })
    fireEvent.focus(statusInput)
    fireEvent.keyDown(statusInput, { key: 'Enter' })
    await screen.findByRole('option', { name: /pending/i })
    fireEvent.keyDown(statusInput, { key: 'Enter' })
    fireEvent.click(within(dialog).getByRole('radio', { name: /workgroup/i }))
    fireEvent.click(within(originGroup).getByRole('radio', { name: /^API$/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: /apply filters/i }))

    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        statuses: 'pending',
        subject: 'workgroup',
        origin: 'api',
      }),
    )
    expect(screen.getByTestId('tasks-filter-button').textContent).toContain('3')
  })

  test('row body navigates while an inner scheduled link remains independent', async () => {
    installFetch(() => rootPage([item('nav', { scheduledTaskId: 'sched-1' })]))
    const { router } = await renderPage()
    const scheduledLink = await screen.findByTestId('task-scheduled-chip-t_nav')

    fireEvent.click(scheduledLink)
    await waitFor(() => expect(router.state.location.pathname).toBe('/scheduled/sched-1'))
    router.history.back()
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'))
    fireEvent.click(screen.getByTestId('task-row-t_nav'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/tasks/t_nav'))
  })

  test('true empty state keeps one guided create action; filtered empty clears to search', async () => {
    installFetch(() => rootPage([]))
    await renderPage()
    const empty = await screen.findByTestId('tasks-empty')
    expect(screen.getAllByTestId('tasks-new-button')).toHaveLength(1)
    expect(empty.contains(screen.getByTestId('tasks-new-button'))).toBe(true)
    expect(screen.queryByTestId('tasks-search')).toBeNull()

    cleanup()
    document.body.innerHTML = ''
    await renderPage('/tasks?q=none')
    const noMatches = await screen.findByTestId('tasks-no-matches')
    fireEvent.click(within(noMatches).getByRole('button', { name: /clear filters/i }))
    await waitFor(() => expect(screen.getByTestId('tasks-empty')).toBeTruthy())
  })
})
