// RFC-043 T5 — admin gating + loading on the new
// /memory/distill-jobs/$jobId route component. We bypass the real
// router by rendering the page component directly and stubbing
// fetch / Route.useParams.
//
// Goal: lock the admin / non-admin branches and the load-error
// branch — full integration coverage of the route comes via the
// component-level tests for the 6 sections, which together exercise
// every observable surface of the page.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

// Mock the actor hook so we can flip admin / non-admin freely. The gate keys
// off the admin ROLE (useIsAdmin) — memory:approve is a user-baseline
// permission and no longer implies admin (RFC-099 D12).
vi.mock('../src/hooks/useActor', () => ({
  useIsAdmin: () => mockIsAdmin,
  usePermission: () => false,
  useActor: () => ({ data: null }),
}))
let mockIsAdmin = true

// Mock the WS hook so the route doesn't try to open a real socket.
vi.mock('../src/hooks/useMemoryDistillJobWs', () => ({
  useMemoryDistillJobWs: () => undefined,
}))

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  mockIsAdmin = true
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function loadRoutePage() {
  // Import here so module-level mocks are in place.
  const mod = await import('../src/routes/memory.distill-jobs.$jobId')
  return mod.Route
}

async function renderRoute(jobId: string) {
  const PageRoute = await loadRoutePage()
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const child = createRoute({
    getParentRoute: () => rootRoute,
    path: '/memory/distill-jobs/$jobId',
    component: PageRoute.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([child]),
    history: createMemoryHistory({ initialEntries: [`/memory/distill-jobs/${jobId}`] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('memory.distill-jobs.$jobId route page (RFC-043)', () => {
  test('non-admin sees Admin-only placeholder', async () => {
    mockIsAdmin = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    await renderRoute('job-1')
    await waitFor(() => {
      expect(screen.getByTestId('distill-detail-admin-only')).toBeTruthy()
    })
    expect(screen.getByRole('heading', { level: 1, name: 'job-1' })).toBeTruthy()
  })

  test('admin: load error renders the localized error box', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/api/memory-distill-jobs/job-x')) {
        return new Response(JSON.stringify({ error: { code: 'distill-job-not-found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await renderRoute('job-x')
    await waitFor(() => {
      expect(screen.getByText(/Failed to load distill job detail/i)).toBeTruthy()
    })
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'job-x' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy()
  })

  test('admin: happy path renders 4 section titles', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/session')) {
        return new Response(JSON.stringify({ attempts: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // detail
      const body = {
        job: {
          id: 'job-y',
          debounceKey: 'k',
          sourceKind: 'feedback',
          sourceEventId: 's1',
          taskId: null,
          scopeResolved: { agentIds: [], workflowId: null, repoId: null, includeGlobal: true },
          status: 'done',
          attempts: 0,
          nextRunAt: 1,
          lastError: null,
          createdAt: 1,
          startedAt: null,
          finishedAt: null,
          opencodeSessionId: null,
          userPromptMd: null,
          exitCode: 0,
          stderrExcerpt: null,
        },
        siblings: [],
        sourceEvents: [],
        dedupSnapshot: [],
        candidates: [],
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    await renderRoute('job-y')
    await waitFor(() => {
      expect(screen.getByTestId('distill-source-events-section')).toBeTruthy()
    })
    expect(screen.getByTestId('distill-scope-section')).toBeTruthy()
    expect(screen.getByTestId('distill-candidates-section')).toBeTruthy()
    expect(screen.getByTestId('distill-conversation-section')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'job-y' })).toBeTruthy()
  })
})
