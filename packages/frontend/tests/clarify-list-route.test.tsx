// RFC-023 PR-C T22 — locks the /clarify list page contract.
//
// We test the page component directly (no RouterProvider) so we don't have
// to mount the full route tree. The Link components still render harmlessly
// inside a QueryClientProvider.
//
//   1. The "Awaiting" filter is active on first render and the page
//      shows the empty hint when the backend returns [].
//   2. Switching to "Answered" re-queries with status=answered (we assert
//      the fetched URL search params via the fetch spy).
//   3. Rows render the shard key when sourceShardKey is non-null AND
//      group sessions by taskId.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { ClarifySessionSummary } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { ClarifyListPage } from '../src/routes/clarify'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mockListResponse(rows: ClarifySessionSummary[]) {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    calls.push(s)
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  return calls
}

function mkSummary(overrides: Partial<ClarifySessionSummary> = {}): ClarifySessionSummary {
  return {
    id: 'sess_1',
    taskId: 'task_a',
    sourceAgentNodeId: 'designer',
    sourceShardKey: null,
    clarifyNodeId: 'c1',
    clarifyNodeRunId: 'nr_1',
    iterationIndex: 0,
    questionCount: 2,
    status: 'awaiting_human',
    createdAt: 1_700_000_000_000,
    answeredAt: null,
    ...overrides,
  }
}

// A minimal in-memory router that mounts ClarifyListPage so the <Link>
// components inside render without throwing about missing route context.
function renderWithRouter() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  // We don't navigate; just provide enough child routes that Link doesn't
  // type-error on `to='/clarify/$nodeRunId'` / `to='/tasks/$id'`.
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: ClarifyListPage,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify/$nodeRunId',
    component: () => null,
  })
  const taskRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => null,
  })
  const tree = rootRoute.addChildren([indexRoute, detailRoute, taskRoute])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('/clarify list (RFC-023 T22)', () => {
  test('Awaiting filter is active on first render and empty hint shows when backend returns []', async () => {
    mockListResponse([])
    renderWithRouter()
    await waitFor(() => {
      expect(screen.getByTestId('clarify-list-empty')).toBeTruthy()
    })
    const awaitingTab = screen.getByTestId('clarify-filter-awaiting')
    expect(awaitingTab.getAttribute('aria-selected')).toBe('true')
  })

  test('switching to Answered triggers a fetch with status=answered', async () => {
    const calls = mockListResponse([])
    renderWithRouter()
    await waitFor(() => screen.getByTestId('clarify-list-empty'))
    fireEvent.click(screen.getByTestId('clarify-filter-answered'))
    await waitFor(() => {
      expect(calls.some((u) => u.includes('status=answered'))).toBe(true)
    })
  })

  test('renders shard key on rows with sourceShardKey non-null, groups by task', async () => {
    mockListResponse([
      mkSummary({ id: 's1', taskId: 'task_a', sourceShardKey: 'shard-A' }),
      mkSummary({ id: 's2', taskId: 'task_a', sourceShardKey: 'shard-B' }),
      mkSummary({ id: 's3', taskId: 'task_b', sourceShardKey: null }),
    ])
    renderWithRouter()
    await waitFor(() => screen.getByTestId('clarify-row-s1'))
    expect(screen.getByTestId('clarify-group-task_a')).toBeTruthy()
    expect(screen.getByTestId('clarify-group-task_b')).toBeTruthy()
    const shardChips = document.querySelectorAll('[data-testid="clarify-row-shard"]')
    expect(shardChips.length).toBe(2)
  })
})
