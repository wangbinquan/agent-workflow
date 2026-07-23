// RFC-041 PR4 — Memory group in the sidebar nav.
// RFC-121 — the badge now also counts fusions awaiting approval: it sums the
// admin-only candidate count + the owner/admin-scoped fusion count, so a
// non-admin owner with a pending fusion sees it light up (fusions left the
// inbox footer badge for this one).
//
// Locks:
// 1. NAV_GROUPS exposes a "memory" group with a single /memory sub-item.
// 2. <MemoryPendingBadge /> hides for a non-admin with no pending fusions
//    (the admin-only candidate query never fires for them).
// 3. Admin with ≥1 candidate sees a numeric badge.
// 4. RFC-121: a non-admin owner with a pending fusion sees the badge; the
//    admin badge sums candidates + fusions.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import type { MemorySummary } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { MemoryPendingBadge } from '../src/components/shell/MemoryPendingBadge'
import { NAV_GROUPS } from '../src/lib/nav'
import '../src/i18n'

function mkSum(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: 'mem_cand_1',
    scopeType: 'workflow',
    scopeId: 'wf_a',
    title: 'X',
    status: 'candidate',
    tags: [],
    approvedAt: null,
    version: 1,
    distillAction: 'new',
    fusedIntoSkillId: null,
    canManage: true,
    ...overrides,
  }
}

function installFetch(
  meResponse: { permissions: string[]; role?: 'admin' | 'user' },
  candidates: MemorySummary[],
  fusionCount = 0,
): { urls: string[] } {
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    urls.push(url)
    if (url.includes('/api/auth/me')) {
      return new Response(
        JSON.stringify({
          user: {
            id: 'u',
            username: 'u',
            displayName: 'u',
            role: meResponse.role ?? 'admin',
            status: 'active',
          },
          source: 'session',
          permissions: meResponse.permissions,
          linkedIdentities: [],
          pats: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    // RFC-121: the badge fetches the (owner/admin-scoped) fusion pending count
    // for every signed-in user.
    if (url.includes('/api/fusions/pending-count')) {
      return new Response(JSON.stringify({ count: fusionCount }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/api/memories')) {
      return new Response(JSON.stringify({ items: candidates }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  })
  return { urls }
}

function renderBadge() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const root = createRootRoute({ component: MemoryPendingBadge })
  const memory = createRoute({
    getParentRoute: () => root,
    path: '/memory',
    component: () => null,
    validateSearch: (search: Record<string, unknown>) => search,
  })
  const router = createRouter({
    routeTree: root.addChildren([memory]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      {/* Focused test router intentionally differs from the generated app tree. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('NAV_GROUPS includes memory', () => {
  test('memory group has a single /memory sub-item', () => {
    const memory = NAV_GROUPS.find((g) => g.key === 'memory')
    expect(memory).toBeTruthy()
    expect(memory!.i18nKey).toBe('nav.group.memory')
    expect(memory!.subnav).toHaveLength(1)
    expect(memory!.subnav[0]?.to).toBe('/memory')
    expect(memory!.subnav[0]?.i18nKey).toBe('nav.memory')
  })
})

describe('MemoryPendingBadge', () => {
  test('admin with pending candidates renders the badge', async () => {
    installFetch({ permissions: ['memory:read', 'memory:approve'] }, [mkSum(), mkSum({ id: 'm2' })])
    renderBadge()
    await waitFor(() => {
      expect(screen.getByTestId('nav-memory-badge').textContent).toBe('2')
    })
  })

  test('server canManage=false candidates do not contribute to the badge', async () => {
    const { urls } = installFetch({ permissions: ['memory:read'], role: 'user' }, [
      mkSum({ canManage: false }),
      mkSum({ id: 'm2', canManage: false }),
    ])
    renderBadge()
    // Allow react-query a tick to consider firing the candidate query.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('nav-memory-badge')).toBeNull()
    expect(urls.some((u) => u.includes('/api/memories'))).toBe(true)
  })

  test('admin with zero pending candidates does not render the badge', async () => {
    installFetch({ permissions: ['memory:approve'] }, [])
    renderBadge()
    // Wait long enough for the actor + candidate fetches to settle.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('nav-memory-badge')).toBeNull()
  })

  test('RFC-121: non-admin owner with a pending fusion sees the badge', async () => {
    // No memory:approve → candidate query stays disabled (count 0), but the
    // owner-scoped fusion count (3) still lights the Memory badge.
    installFetch({ permissions: ['memory:read'], role: 'user' }, [], 3)
    renderBadge()
    await waitFor(() => {
      expect(screen.getByTestId('nav-memory-badge').textContent).toBe('3')
    })
  })

  test('RFC-121: admin badge sums pending candidates + awaiting fusions', async () => {
    installFetch({ permissions: ['memory:approve'] }, [mkSum(), mkSum({ id: 'm2' })], 3)
    renderBadge()
    await waitFor(() => {
      expect(screen.getByTestId('nav-memory-badge').textContent).toBe('5')
    })
    expect(screen.getByTestId('nav-memory-badge').getAttribute('href')).toContain(
      'tab=approval-queue',
    )
  })

  test('fusion is the sibling destination when there are no manageable candidates', async () => {
    installFetch({ permissions: ['memory:read'], role: 'user' }, [mkSum({ canManage: false })], 2)
    renderBadge()
    const accessory = await screen.findByTestId('nav-memory-badge')
    expect(accessory.getAttribute('href')).toContain('tab=fusion')
    expect(accessory.closest('.nav-item__main')).toBeNull()
  })
})
