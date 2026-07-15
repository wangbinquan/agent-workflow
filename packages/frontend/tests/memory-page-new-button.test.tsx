// RFC-045 — /memory page header `[+ New memory]` button.
//
// Locks:
//   * admin (memory:approve) sees the button.
//   * non-admin does NOT see the button.
//   * clicking opens MemoryNewDialog (titled "New memory" via i18n).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

// Flip admin vs non-admin via this mock. RFC-099: the page keys off the
// actor's ROLE (memory:approve moved into the user baseline).
vi.mock('../src/hooks/useActor', () => ({
  usePermission: (perm: string) =>
    perm === 'memory:approve' ? mockIsAdmin : perm === 'memory:edit' ? mockIsAdmin : false,
  useActor: () => ({
    data: {
      user: {
        id: 'u1',
        username: 'u1',
        displayName: 'U1',
        role: mockIsAdmin ? 'admin' : 'user',
        status: 'active',
      },
      source: 'session',
      permissions: [],
      linkedIdentities: [],
      pats: [],
    },
  }),
}))
let mockIsAdmin = true

// Avoid real WebSocket / fetch from the memory hooks.
vi.mock('../src/hooks/useMemoryWs', () => ({
  useMemoryWs: () => undefined,
  MEMORY_QUERY_KEYS: {
    pendingCount: ['memories', 'pending-count'],
    candidates: ['memories', 'candidates'],
    all: ['memories', 'all'],
    detail: (id: string) => ['memories', 'detail', id],
    scoped: () => ['memories', 'scoped'],
  },
}))
vi.mock('../src/hooks/useMemoryDistillJobWs', () => ({
  useMemoryDistillJobWs: () => undefined,
}))

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  mockIsAdmin = true
  // Stub fetch with empty list responses so the queries resolve cleanly.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    return new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function loadMemoryPage(initialEntry = '/memory') {
  const mod = await import('../src/routes/memory')
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({
    getParentRoute: () => root,
    path: '/memory',
    component: mod.Route.options.component,
    validateSearch: mod.Route.options.validateSearch,
  })
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, view }
}

describe('/memory page header — [+ New memory] (RFC-045)', () => {
  test('admin sees the New button', async () => {
    mockIsAdmin = true
    await loadMemoryPage()
    const btn = await screen.findByTestId('memory-new-button')
    expect(btn.closest('header')?.querySelector('h1.page__title')).not.toBeNull()
    expect(btn).toBeTruthy()
  })

  test('non-admin ALSO sees the New button (RFC-099 D12 — owners create scoped memories)', async () => {
    mockIsAdmin = false
    await loadMemoryPage()
    await waitFor(() => {
      // Wait for the page header to render in either branch.
      expect(screen.getByTestId('memory-tab-bar')).toBeTruthy()
    })
    // RFC-099 flipped this assertion: the button shows for every logged-in
    // user; the backend enforces per-scope manage rights at POST time.
    expect(screen.queryByTestId('memory-new-button')).toBeTruthy()
  })

  test('clicking the New button opens the MemoryNewDialog', async () => {
    mockIsAdmin = true
    await loadMemoryPage()
    const btn = await screen.findByTestId('memory-new-button')
    fireEvent.click(btn)
    const dialog = await screen.findByTestId('memory-new-dialog')
    expect(dialog).toBeTruthy()
  })

  test('page tabs push URL state, preserve focus/hash, and expose matching panels', async () => {
    const { router } = await loadMemoryPage('/memory?focus=mem_1#candidate')
    const allTab = await screen.findByTestId('memory-tab-all')
    expect(allTab.getAttribute('aria-controls')).toBe('memory-panel-all')
    expect(document.getElementById('memory-panel-all')?.hidden).toBe(true)

    fireEvent.click(allTab)
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ focus: 'mem_1', tab: 'all' })
    })
    expect(router.state.location.hash).toBe('candidate')
    expect(document.getElementById('memory-panel-all')?.hidden).toBe(false)
    expect(allTab.getAttribute('aria-selected')).toBe('true')

    router.history.back()
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ focus: 'mem_1' })
      expect(screen.getByTestId('memory-tab-approval-queue').getAttribute('aria-selected')).toBe(
        'true',
      )
    })
    expect(router.state.location.hash).toBe('candidate')
  })
})
