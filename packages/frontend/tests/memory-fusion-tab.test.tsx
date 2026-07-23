// RFC-121 — Memory page "fusion" tab.
//
// Fusions awaiting approval moved out of the inbox drawer and onto the
// /memory page as a dedicated "fusion" tab (MemoryFusionList). This is now
// the list entry point to a pending fusion (previously inbox-only).
//
// Locks:
//   1. awaiting fusions render as rows that link to /fusions/:id.
//   2. the row count uses incorporatedMemoryIds when present, else memoryIds.
//   3. empty feed → empty state; errored feed → retry affordance.
//   4. source backstop: routes/memory.tsx wires the fusion tab + list.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Fusion } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { MemoryFusionList } from '../src/components/memory/MemoryFusionList'
import '../src/i18n'

function mkFusion(overrides: Partial<Fusion> = {}): Fusion {
  return {
    id: 'fus_1',
    skillId: 'skill_1',
    skillName: 'my-skill',
    baseSkillVersion: 1,
    memoryIds: ['m1', 'm2'],
    intent: '',
    status: 'awaiting_approval',
    iteration: 1,
    currentTaskId: null,
    proposedDiff: null,
    incorporatedMemoryIds: null,
    skipped: null,
    changelog: null,
    appliedSkillVersion: null,
    ownerUserId: 'u',
    createdAt: 1,
    decidedByUserId: null,
    decidedAt: null,
    decisionReason: null,
    error: null,
    ...overrides,
  }
}

function installFetch(opts: { fusions?: Fusion[]; error?: boolean }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/fusions')) {
      if (opts.error === true) {
        return new Response('{"code":"x"}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify(opts.fusions ?? []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  })
}

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <MemoryFusionList />
        <Outlet />
      </QueryClientProvider>
    ),
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  // The detail route must exist so the row <Link> resolves a real href.
  const fusionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/fusions/$id',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, fusionRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<RouterProvider router={router as any} />)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-121 MemoryFusionList', () => {
  test('awaiting fusions render rows that link to /fusions/:id', async () => {
    installFetch({
      fusions: [
        mkFusion({ id: 'fus_a', skillName: 'alpha-skill' }),
        mkFusion({ id: 'fus_b', skillName: 'beta-skill' }),
      ],
    })
    renderList()
    const rowA = await screen.findByTestId('memory-fusion-row-fus_a')
    expect(rowA.textContent ?? '').toContain('alpha-skill')
    expect(rowA.getAttribute('href')).toContain('/fusions/fus_a')
    expect(screen.getByTestId('memory-fusion-row-fus_b')).toBeTruthy()
  })

  test('row count prefers incorporatedMemoryIds over the selected memoryIds', async () => {
    installFetch({
      fusions: [
        mkFusion({ id: 'fus_c', memoryIds: ['m1', 'm2', 'm3'], incorporatedMemoryIds: ['m1'] }),
      ],
    })
    renderList()
    const row = await screen.findByTestId('memory-fusion-row-fus_c')
    // subtitle interpolates n=1 (incorporated), not 3 (originally selected).
    expect(row.textContent ?? '').toContain('1')
    expect(row.textContent ?? '').not.toContain('3')
  })

  test('empty feed renders the empty state', async () => {
    installFetch({ fusions: [] })
    renderList()
    await waitFor(() => {
      expect(screen.getByTestId('memory-fusion-empty')).toBeTruthy()
    })
  })

  test('errored feed renders a retry affordance', async () => {
    installFetch({ error: true })
    renderList()
    await waitFor(() => {
      expect(screen.getByTestId('memory-fusion-error')).toBeTruthy()
    })
  })
})

describe('RFC-121 memory.tsx fusion tab wiring (source backstop)', () => {
  test('routes/memory.tsx renders MemoryFusionList under a "fusion" tab', () => {
    const src = readFileSync(resolve(__dirname, '..', 'src', 'routes', 'memory.tsx'), 'utf8')
    expect(src).toContain('MemoryFusionList')
    expect(src).toContain("'fusion'")
    expect(src).toContain('memory.tab.fusion')
  })
})
