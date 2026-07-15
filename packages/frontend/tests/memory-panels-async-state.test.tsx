// RFC-198 — every /memory panel shares the same async-state contract.
//
// This regression suite exists because the six panels previously mixed bare
// error boxes, missing retry actions and stale-data blanking. A future panel
// refactor must keep initial LoadingState, ErrorBanner + Retry, real empty
// states, and cached rows while a background refresh is failing.

import type { ReactElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { MemoryDistillJob } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  }
})

vi.mock('../src/hooks/useActor', () => ({
  useActor: () => ({ data: { user: { role: 'admin' } } }),
}))

import { api } from '../src/api/client'
import { MemoryAllList } from '../src/components/memory/MemoryAllList'
import { MemoryApprovalQueue } from '../src/components/memory/MemoryApprovalQueue'
import { MemoryByScopeBrowser } from '../src/components/memory/MemoryByScopeBrowser'
import { MemoryDistillJobsTable } from '../src/components/memory/MemoryDistillJobsTable'
import { MemoryFusionList } from '../src/components/memory/MemoryFusionList'
import { MemoryScopedList } from '../src/components/memory/MemoryScopedList'
import '../src/i18n'

const mockedGet = vi.mocked(api.get)

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
}

function renderPanel(node: ReactElement, client = createClient()) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <Outlet />
      </QueryClientProvider>
    ),
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => node,
  })
  const fusionDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/fusions/$id',
    component: () => null,
  })
  const distillDetailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/memory/distill-jobs/$jobId',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, fusionDetailRoute, distillDetailRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })

  return {
    client,
    ...render(<RouterProvider router={router} />),
  }
}

interface PanelCase {
  name: string
  node: () => ReactElement
  emptyResponse: unknown
  assertEmpty: () => void
}

const PANELS: PanelCase[] = [
  {
    name: 'all memories',
    node: () => <MemoryAllList isAdmin />,
    emptyResponse: { items: [] },
    assertEmpty: () => expect(screen.getByTestId('empty-state')).toBeTruthy(),
  },
  {
    name: 'approval queue',
    node: () => <MemoryApprovalQueue isAdmin />,
    emptyResponse: { items: [] },
    assertEmpty: () => expect(screen.getByTestId('memory-approval-queue-empty')).toBeTruthy(),
  },
  {
    name: 'by-scope browser',
    node: () => <MemoryByScopeBrowser />,
    emptyResponse: { items: [] },
    assertEmpty: () => expect(screen.getAllByTestId('empty-state')).toHaveLength(4),
  },
  {
    name: 'scoped list',
    node: () => <MemoryScopedList scopeType="global" scopeId={null} data-testid="scoped-panel" />,
    emptyResponse: { items: [] },
    assertEmpty: () => expect(screen.getByTestId('scoped-panel')).toBeTruthy(),
  },
  {
    name: 'fusion list',
    node: () => <MemoryFusionList />,
    emptyResponse: [],
    assertEmpty: () => expect(screen.getByTestId('memory-fusion-empty')).toBeTruthy(),
  },
  {
    name: 'distill jobs table',
    node: () => <MemoryDistillJobsTable />,
    emptyResponse: { items: [] },
    assertEmpty: () => expect(screen.getByTestId('empty-state')).toBeTruthy(),
  },
]

function job(overrides: Partial<MemoryDistillJob> = {}): MemoryDistillJob {
  return {
    id: 'job-stale-1',
    debounceKey: 'stale-key',
    sourceKind: 'feedback',
    sourceEventId: 'source-1',
    taskId: null,
    scopeResolved: { agentIds: [], workflowId: null, repoId: null, includeGlobal: true },
    status: 'failed',
    attempts: 2,
    nextRunAt: 0,
    lastError: 'run failed',
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  mockedGet.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('RFC-198 memory panel async-state contract', () => {
  test.each(PANELS)(
    '$name renders shared loading, initial error + retry, then the real empty state',
    async ({ node, emptyResponse, assertEmpty }) => {
      let rejectInitial: ((reason: Error) => void) | undefined
      mockedGet
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectInitial = reject
            }),
        )
        .mockResolvedValueOnce(emptyResponse)

      renderPanel(node())
      expect(await screen.findByTestId('loading-state')).toBeTruthy()

      await act(async () => {
        rejectInitial?.(new Error('initial memory panel failure'))
      })
      const alert = await screen.findByRole('alert')
      fireEvent.click(within(alert).getByRole('button', { name: /Retry|重试/i }))

      await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2))
      await waitFor(assertEmpty)
      expect(screen.queryByRole('alert')).toBeNull()
    },
  )

  test('a refetch failure keeps cached distill rows and the table remains the direct viewport child', async () => {
    const cachedRows = { items: [job()] }
    mockedGet
      .mockResolvedValueOnce(cachedRows)
      .mockRejectedValueOnce(new Error('background refresh failed'))
      .mockResolvedValueOnce(cachedRows)
    const client = createClient()
    const view = renderPanel(<MemoryDistillJobsTable />, client)

    expect(await screen.findByTestId('distill-job-row-job-stale-1')).toBeTruthy()
    expect(
      view.container.querySelector('.table-viewport__scroller > table.data-table'),
    ).toBeTruthy()

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['memory-distill-jobs', 'list'] })
    })

    const alert = await screen.findByRole('alert')
    expect(screen.getByTestId('distill-job-row-job-stale-1')).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: /Retry|重试/i }))

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByTestId('distill-job-row-job-stale-1')).toBeTruthy()
  })
})
