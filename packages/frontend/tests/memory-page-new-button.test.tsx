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

// Flip admin vs non-admin via this mock.
vi.mock('../src/hooks/useActor', () => ({
  usePermission: (perm: string) =>
    perm === 'memory:approve' ? mockIsAdmin : perm === 'memory:edit' ? mockIsAdmin : false,
  useActor: () => ({ data: null }),
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

async function loadMemoryPage() {
  const mod = await import('../src/routes/memory')
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({
    getParentRoute: () => root,
    path: '/memory',
    component: mod.Route.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/memory'] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('/memory page header — [+ New memory] (RFC-045)', () => {
  test('admin sees the New button', async () => {
    mockIsAdmin = true
    await loadMemoryPage()
    const btn = await screen.findByTestId('memory-new-button')
    expect(btn).toBeTruthy()
  })

  test('non-admin does NOT see the New button', async () => {
    mockIsAdmin = false
    await loadMemoryPage()
    await waitFor(() => {
      // Wait for the page header to render in either branch.
      expect(screen.getByTestId('memory-tab-bar')).toBeTruthy()
    })
    expect(screen.queryByTestId('memory-new-button')).toBeNull()
  })

  test('clicking the New button opens the MemoryNewDialog', async () => {
    mockIsAdmin = true
    await loadMemoryPage()
    const btn = await screen.findByTestId('memory-new-button')
    fireEvent.click(btn)
    const dialog = await screen.findByTestId('memory-new-dialog')
    expect(dialog).toBeTruthy()
  })
})
