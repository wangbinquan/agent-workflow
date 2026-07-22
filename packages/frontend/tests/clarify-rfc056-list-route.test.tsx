// RFC-056 PR-C T8 — locks /clarify list page chip + cross-clarify rendering.
//
// Mixed-list contract (PR-B backend):
//   GET /api/clarify → Array<self | cross> tagged with `kind: 'self' | 'cross'`.
//
// LOCKS:
//   1. List renders both self + cross rows with a per-row chip labelled
//      'clarify.list.chip.self' / 'clarify.list.chip.cross'.
//   2. Cross-clarify row uses the crossClarifyNodeRunId (not clarifyNodeRunId)
//      in its Open link.
//   3. Cross-clarify row carries the targetDesignerNodeId in the visible
//      source chip (`→ <designer-id>` segment).
//   4. Abandoned cross-clarify row renders the abandoned chip + red status
//      class.
//
// Source-text lint at the bottom guards against rename / removal of the
// crucial data-testid + chip selectors.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
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

const CLARIFY_TSX = resolve(__dirname, '..', 'src', 'routes', 'clarify.tsx')

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function mockListResponse(rows: ClarifyRoundSummary[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(rows), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

function selfRow(overrides: Partial<ClarifyRoundSummary> = {}): ClarifyRoundSummary {
  return {
    kind: 'self',
    id: 'sess_self',
    taskId: 'task_a',
    taskName: 'fixture-task',
    askingNodeId: 'designer',
    askingShardKey: null,
    intermediaryNodeId: 'c1',
    intermediaryNodeRunId: 'nr_self_1',
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: 0,
    questionCount: 2,
    status: 'awaiting_human',
    terminatedAs: null,
    directive: null,
    createdAt: 1_700_000_000_000,
    answeredAt: null,
    ...overrides,
  }
}

function crossRow(overrides: Partial<ClarifyRoundSummary> = {}): ClarifyRoundSummary {
  return {
    kind: 'cross',
    id: 'sess_cross',
    taskId: 'task_a',
    taskName: 'fixture-task',
    askingNodeId: 'questioner',
    askingShardKey: null,
    intermediaryNodeId: 'cross1',
    intermediaryNodeRunId: 'nr_cross_1',
    targetConsumerNodeId: 'designer',
    loopIter: 0,
    iteration: 0,
    questionCount: 3,
    status: 'awaiting_human',
    terminatedAs: null,
    directive: null,
    createdAt: 1_700_000_000_500,
    answeredAt: null,
    ...overrides,
  }
}

function renderWithRouter() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
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

describe('RFC-056 /clarify list — mixed self + cross with kind chip', () => {
  test('renders BOTH self and cross rows when the API returns a mixed list', async () => {
    mockListResponse([selfRow(), crossRow()])
    renderWithRouter()
    await waitFor(() => {
      expect(screen.getByTestId('clarify-row-sess_self')).toBeTruthy()
    })
    expect(screen.getByTestId('clarify-row-sess_cross')).toBeTruthy()
  })

  test('each row carries a chip labelled per its kind (self vs cross)', async () => {
    mockListResponse([selfRow(), crossRow()])
    renderWithRouter()
    await waitFor(() => screen.getByTestId('clarify-row-sess_self'))
    const selfChip = screen.getByTestId('clarify-row-kind-sess_self')
    const crossChip = screen.getByTestId('clarify-row-kind-sess_cross')
    // i18n is whichever lang i18n bootstrap picked (default zh-CN). Just
    // assert distinct text — the lang-specific strings live in the bundle.
    expect((selfChip.textContent ?? '').length).toBeGreaterThan(0)
    expect((crossChip.textContent ?? '').length).toBeGreaterThan(0)
    expect(selfChip.textContent).not.toBe(crossChip.textContent)
  })

  test('cross-clarify Open link points to the cross-clarify node_run id', async () => {
    mockListResponse([crossRow({ intermediaryNodeRunId: 'nr_xc_abc' })])
    renderWithRouter()
    await waitFor(() => screen.getByTestId('clarify-row-sess_cross'))
    const row = screen.getByTestId('clarify-row-sess_cross')
    const link = row.querySelector('a[href]') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href') ?? '').toContain('nr_xc_abc')
  })

  test('cross-clarify row surfaces the designer target in the source chip', async () => {
    mockListResponse([crossRow({ targetConsumerNodeId: 'designerNodeABC' })])
    renderWithRouter()
    await waitFor(() => screen.getByTestId('clarify-row-sess_cross'))
    expect(screen.getByTestId('clarify-row-designer').textContent ?? '').toContain(
      'designerNodeABC',
    )
  })

  test('abandoned cross-clarify row renders the abandoned status chip', async () => {
    mockListResponse([crossRow({ id: 'sess_abd', status: 'abandoned', directive: 'continue' })])
    renderWithRouter()
    await waitFor(() => screen.getByTestId('clarify-row-sess_abd'))
    const row = screen.getByTestId('clarify-row-sess_abd')
    const statusChip = row.querySelector('.status-chip')
    expect(statusChip?.className ?? '').toContain('status-chip--danger')
  })
})

describe('RFC-056 source-code grep guards', () => {
  test('clarify.tsx references clarify.list.chip.cross + clarify.list.chip.self', () => {
    const src = readFileSync(CLARIFY_TSX, 'utf-8')
    expect(src).toContain('clarify.list.chip.cross')
    expect(src).toContain('clarify.list.chip.self')
  })

  test('clarify.tsx renders cross-clarify rows with data-kind="cross"', () => {
    const src = readFileSync(CLARIFY_TSX, 'utf-8')
    expect(src).toMatch(/data-kind="cross"/)
    expect(src).toMatch(/data-kind="self"/)
  })
})
