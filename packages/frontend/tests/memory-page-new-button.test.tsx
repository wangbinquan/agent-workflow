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
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
    const url = request.toString()
    const payload = url.includes('/api/fusions/pending-count')
      ? { count: 0 }
      : url.includes('/api/fusions?')
        ? []
        : { items: [] }
    return new Response(JSON.stringify(payload), {
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
      expect(screen.getByRole('navigation', { name: /Memory sections|记忆分区/i })).toBeTruthy()
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

  test('page sections push URL state, preserve focus/hash, and render one section', async () => {
    const { router } = await loadMemoryPage('/memory?focus=mem_1#candidate')
    const selector = await screen.findByRole('combobox', { name: /Memory sections|记忆分区/i })
    expect(selector.textContent).toMatch(/All Approved|已审批/)
    fireEvent.click(selector)
    const fusion = screen.getByRole('option', { name: /Fusion|融合/ })
    fireEvent.mouseDown(fusion)
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ focus: 'mem_1', tab: 'fusion' })
    })
    expect(router.state.location.hash).toBe('candidate')
    expect(screen.getByTestId('memory-section-panel').textContent).toMatch(/Fusion|融合/)
    expect(screen.queryByRole('tabpanel')).toBeNull()

    router.history.back()
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ focus: 'mem_1' })
      expect(screen.getByRole('combobox').textContent).toMatch(/All Approved|已审批/)
    })
    expect(router.state.location.hash).toBe('candidate')
  })

  test('All view mode survives a section round trip', async () => {
    await loadMemoryPage('/memory')
    fireEvent.click(await screen.findByTestId('memory-all-filter-archived'))
    expect(screen.getByTestId('memory-all-filter-archived').getAttribute('aria-checked')).toBe(
      'true',
    )

    const selector = screen.getByRole('combobox', { name: /Memory sections|记忆分区/i })
    fireEvent.click(selector)
    fireEvent.mouseDown(screen.getByRole('option', { name: /Fusion|融合/ }))
    await screen.findByTestId('memory-fusion-empty')

    fireEvent.click(screen.getByRole('combobox', { name: /Memory sections|记忆分区/i }))
    fireEvent.mouseDown(screen.getByRole('option', { name: /All Approved|已审批/ }))
    expect(
      (await screen.findByTestId('memory-all-filter-archived')).getAttribute('aria-checked'),
    ).toBe('true')
  })
})
