// RFC-043 T6 — MemoryDistillJobsTable: whole-row click jumps to the
// admin detail page; retry / cancel buttons stop propagation so they
// stay row-local controls.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import type { MemoryDistillJob } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { MemoryDistillJobsTable } from '../src/components/memory/MemoryDistillJobsTable'
import { meQueryOptions } from '../src/hooks/useActor'
import '../src/i18n'

function mkJob(overrides: Partial<MemoryDistillJob> = {}): MemoryDistillJob {
  return {
    id: 'job-row-1',
    debounceKey: 'k',
    sourceKind: 'feedback',
    sourceEventId: 's',
    taskId: null,
    scopeResolved: { agentIds: [], workflowId: null, repoId: null, includeGlobal: true },
    status: 'failed',
    attempts: 3,
    nextRunAt: 0,
    lastError: 'boom',
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function renderTable(rows: MemoryDistillJob[], onPathChange: (p: string) => void) {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.endsWith('/api/auth/me')) {
      return new Response(
        JSON.stringify({
          user: {
            id: 'u1',
            username: 'root',
            displayName: 'root',
            role: 'admin',
            status: 'active',
          },
          source: 'session',
          permissions: [],
          linkedIdentities: [],
          pats: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (method === 'GET' && url.endsWith('/api/memory-distill-jobs')) {
      return new Response(JSON.stringify({ items: rows }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // retry / cancel POST stubs
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <MemoryDistillJobsTable />,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/memory/distill-jobs/$jobId',
    component: () => <div data-testid="detail-stub" />,
  })
  const history = createMemoryHistory({ initialEntries: ['/'] })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
    history,
  })
  router.subscribe('onLoad', () => {
    onPathChange(history.location.pathname)
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { qc, fetchSpy }
}

describe('MemoryDistillJobsTable row interactions (RFC-043)', () => {
  test('whole-row click navigates to /memory/distill-jobs/$jobId', async () => {
    let path = '/'
    await renderTable([mkJob()], (p) => {
      path = p
    })
    const row = await screen.findByTestId('distill-job-row-job-row-1')
    fireEvent.click(row)
    await waitFor(() => {
      expect(path).toBe('/memory/distill-jobs/job-row-1')
    })
  })

  test('retry button click does NOT navigate (stopPropagation)', async () => {
    let path = '/'
    await renderTable([mkJob({ status: 'failed' })], (p) => {
      path = p
    })
    const btn = await screen.findByTestId('distill-job-row-job-row-1-retry')
    fireEvent.click(btn)
    await waitFor(() => {
      // POST was issued (state-changed) but path stays at /.
      expect(path).toBe('/')
    })
  })

  test('an invoked connected stale retry handler sends zero POST after admin downgrade', async () => {
    let path = '/'
    const { qc, fetchSpy } = await renderTable([mkJob({ status: 'failed' })], (next) => {
      path = next
    })
    const staleRetry = await screen.findByTestId('distill-job-row-job-row-1-retry')
    let invocations = 0
    staleRetry.addEventListener('click', () => {
      invocations += 1
    })
    act(() => {
      qc.setQueryData(meQueryOptions('tok').queryKey, {
        user: { id: 'u1', username: 'dev', displayName: 'dev', role: 'user', status: 'active' },
        source: 'session',
        permissions: [],
        linkedIdentities: [],
        pats: [],
      })
      fireEvent.click(staleRetry)
    })
    expect(invocations).toBe(1)
    expect(
      fetchSpy.mock.calls.filter(
        ([input, init]) =>
          init?.method === 'POST' && input.toString().includes('/api/memory-distill-jobs/'),
      ),
    ).toHaveLength(0)
    expect(path).toBe('/')
    await waitFor(() => expect(screen.queryByTestId('distill-job-row-job-row-1-retry')).toBeNull())
  })
})
