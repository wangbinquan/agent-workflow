// RFC-164 PR-4 → RFC-165 — the workgroup detail page's launch entry.
//
// The standalone /workgroups/launch page is retired (the /tasks/new wizard is
// the launch surface — its flows are locked by tasks-new-wizard.test.tsx).
// What survives here:
//   1. Detail page: the "Launch task" button renders ONLY when the shared
//      workgroupLaunchReadiness oracle says ready, and deep-links into the
//      wizard with the group pre-picked (?kind=workgroup&workgroup=<name>).
//   2. A not-ready group hides the button and shows the readiness banner.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { Workgroup } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

function wg(name: string, overrides: Partial<Workgroup> = {}): Workgroup {
  return {
    id: `wg_${name}`,
    name,
    description: '',
    instructions: '',
    mode: 'leader_worker',
    leaderMemberId: 'mem_1',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 20,
    completionGate: false,
    members: [
      {
        id: 'mem_1',
        memberType: 'agent',
        agentName: 'coder',
        userId: null,
        displayName: 'Coder',
        roleDesc: '',
        sortOrder: 0,
      },
    ],
    ownerUserId: null,
    visibility: 'public',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function installFetch(state: { workgroups: Workgroup[] }): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (req: RequestInfo | URL) => {
    const url = req.toString()
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (url.includes('/api/auth/me')) {
      return json({
        user: { id: 'u_me', username: 'me', displayName: 'Me', role: 'admin', status: 'active' },
        source: 'session',
        permissions: [],
        linkedIdentities: [],
        pats: [],
      })
    }
    const one = url.match(/\/api\/workgroups\/([^/]+)$/)
    if (one !== null) {
      const row = state.workgroups.find((w) => w.name === decodeURIComponent(one[1]!))
      return row !== undefined ? json(row) : json({ code: 'workgroup-not-found' }, 404)
    }
    if (url.endsWith('/api/workgroups')) return json(state.workgroups)
    return json({})
  })
}

async function renderPage(initialEntry: string) {
  const detail = await import('../src/routes/workgroups.detail')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups/$name',
    component: detail.Route.options.component,
  })
  const wizardStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/new',
    component: () => <div data-testid="wizard-stub" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detailRoute, wizardStub]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('/workgroups/$name — launch entry gating', () => {
  test('a launch-ready group shows the button deep-linking into the wizard', async () => {
    installFetch({ workgroups: [wg('review-squad')] })
    await renderPage('/workgroups/review-squad')
    const btn = await screen.findByTestId('workgroup-launch-button')
    expect(btn.getAttribute('href')).toBe('/tasks/new?kind=workgroup&workgroup=review-squad')
  })

  test('a not-ready group (no members) hides the launch button', async () => {
    installFetch({
      workgroups: [wg('empty-squad', { members: [], leaderMemberId: null })],
    })
    await renderPage('/workgroups/empty-squad')
    await screen.findByTestId('workgroup-readiness-banner')
    expect(screen.queryByTestId('workgroup-launch-button')).toBeNull()
  })
})
