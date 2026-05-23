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
import type { ClarifyRoundSummary } from '@agent-workflow/shared'
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

function mockListResponse(rows: ClarifyRoundSummary[]) {
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

// RFC-058: fixtures use the unified shape; the `mkSummary` overrides bag
// also accepts legacy field names for readability of older test cases.
type LegacyOverrides = Partial<{
  sourceAgentNodeId: string
  sourceAgentNodeTitle: string | null
  sourceShardKey: string | null
  clarifyNodeId: string
  clarifyNodeTitle: string | null
  clarifyNodeRunId: string
  iterationIndex: number
}> &
  Partial<ClarifyRoundSummary>

function mkSummary(overrides: LegacyOverrides = {}): ClarifyRoundSummary {
  const {
    sourceAgentNodeId,
    sourceAgentNodeTitle,
    sourceShardKey,
    clarifyNodeId,
    clarifyNodeTitle,
    clarifyNodeRunId,
    iterationIndex,
    ...rest
  } = overrides
  return {
    id: 'sess_1',
    taskId: 'task_a',
    taskName: 'fixture-task',
    kind: 'self',
    askingNodeId: sourceAgentNodeId ?? 'designer',
    askingNodeTitle: sourceAgentNodeTitle ?? null,
    askingShardKey: sourceShardKey ?? null,
    intermediaryNodeId: clarifyNodeId ?? 'c1',
    intermediaryNodeTitle: clarifyNodeTitle ?? null,
    intermediaryNodeRunId: clarifyNodeRunId ?? 'nr_1',
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: iterationIndex ?? 0,
    questionCount: 2,
    status: 'awaiting_human',
    directive: null,
    createdAt: 1_700_000_000_000,
    answeredAt: null,
    ...rest,
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

  // RFC-037 follow-up: rows render the workflow node title with a nodeId
  // chip underneath (mirrors `reviews.tsx`'s `title || reviewNodeId`
  // pattern). When `clarifyNodeTitle` is absent / empty the row collapses
  // to a single chip carrying the id, exactly like the review list.
  test('row title prefers clarifyNodeTitle when set, falls back to clarifyNodeId otherwise', async () => {
    mockListResponse([
      mkSummary({
        id: 's_titled',
        taskId: 'task_titled',
        clarifyNodeId: 'c1',
        clarifyNodeTitle: 'Ask user about the DB',
      }),
      mkSummary({
        id: 's_legacy',
        taskId: 'task_legacy',
        clarifyNodeId: 'c2',
        // No clarifyNodeTitle — legacy snapshot.
      }),
    ])
    renderWithRouter()
    await waitFor(() => screen.getByTestId('clarify-row-s_titled'))

    const titledRow = screen.getByTestId('clarify-row-s_titled')
    expect(titledRow.textContent ?? '').toContain('Ask user about the DB')
    // Title row keeps the id available as a chip for traceability.
    expect(titledRow.textContent ?? '').toContain('c1')
    // The title element is the styled `.reviews-row__title` div so the
    // row layout matches reviews.
    const titleEl = titledRow.querySelector('.reviews-row__title')
    expect(titleEl?.textContent).toBe('Ask user about the DB')

    const legacyRow = screen.getByTestId('clarify-row-s_legacy')
    expect(legacyRow.textContent ?? '').toContain('c2')
    // No title element when there's nothing user-set to show.
    expect(legacyRow.querySelector('.reviews-row__title')).toBeNull()
  })

  // Source agent chip also prefers `sourceAgentNodeTitle` over the id when
  // backends supply both (consistent with how the row's primary title is
  // chosen). Older backends that omit `sourceAgentNodeTitle` still render
  // the raw id, so existing screenshots are unaffected.
  test('source chip prefers sourceAgentNodeTitle when set, falls back to sourceAgentNodeId', async () => {
    mockListResponse([
      mkSummary({
        id: 's_src_titled',
        taskId: 'task_a',
        sourceAgentNodeId: 'designer',
        sourceAgentNodeTitle: 'UX Designer',
      }),
      mkSummary({
        id: 's_src_legacy',
        taskId: 'task_b',
        sourceAgentNodeId: 'coder',
        // No sourceAgentNodeTitle.
      }),
    ])
    renderWithRouter()
    await waitFor(() => screen.getByTestId('clarify-row-s_src_titled'))
    expect(screen.getByTestId('clarify-row-s_src_titled').textContent ?? '').toContain(
      '← UX Designer',
    )
    expect(screen.getByTestId('clarify-row-s_src_legacy').textContent ?? '').toContain('← coder')
  })

  test('renders shard key on rows with sourceShardKey non-null, groups by task', async () => {
    mockListResponse([
      mkSummary({
        id: 's1',
        taskId: 'task_a',
        taskName: 'fixture-task',
        sourceShardKey: 'shard-A',
      }),
      mkSummary({
        id: 's2',
        taskId: 'task_a',
        taskName: 'fixture-task',
        sourceShardKey: 'shard-B',
      }),
      mkSummary({ id: 's3', taskId: 'task_b', taskName: 'fixture-task', sourceShardKey: null }),
    ])
    renderWithRouter()
    await waitFor(() => screen.getByTestId('clarify-row-s1'))
    expect(screen.getByTestId('clarify-group-task_a')).toBeTruthy()
    expect(screen.getByTestId('clarify-group-task_b')).toBeTruthy()
    const shardChips = document.querySelectorAll('[data-testid="clarify-row-shard"]')
    expect(shardChips.length).toBe(2)
  })
})
