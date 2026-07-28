// RFC-234 (T11) — locks the two resource-page intent affordances:
//   1. <IntentEntryButton> navigates to /intent with the create dialog
//      pre-opened and the hint / mount target carried in search params
//      (gallery "意图创建" + detail "意图修改" share this one component).
//   2. <IntentProvenanceBadge> (AC-11) renders nothing when the provenance
//      read is empty — the server scopes rows to session viewers, so absence
//      is the default shape — and renders a session-linked chip when rows
//      exist, jumping to the originating session on click.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { ReactElement } from 'react'
import { IntentEntryButton } from '../src/components/IntentEntryButton'
import { IntentProvenanceBadge } from '../src/components/IntentProvenanceBadge'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { enUS } from '../src/i18n/en-US'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function renderWithRouter(home: () => ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: home })
  const intentRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/intent',
    validateSearch: (s: Record<string, unknown>) => s,
    component: function IntentProbe() {
      return <div data-testid="intent-probe">{JSON.stringify(intentRoute.useSearch())}</div>
    },
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/intent/$sessionId',
    component: function DetailProbe() {
      return <div data-testid="intent-detail-probe">{detailRoute.useParams().sessionId}</div>
    },
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, intentRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('RFC-234 intent entry + provenance badge', () => {
  test('modify entry navigates to /intent carrying create + mount search', async () => {
    renderWithRouter(() => (
      <IntentEntryButton
        variant="modify"
        mount={{ resourceType: 'agent', resourceId: 'A1' }}
        data-testid="entry"
      />
    ))
    const btn = await screen.findByTestId('entry')
    expect(btn.textContent).toBe(enUS.intent.entryModify)
    fireEvent.click(btn)
    const probe = await screen.findByTestId('intent-probe')
    expect(JSON.parse(probe.textContent ?? '{}')).toEqual({
      create: true,
      mountType: 'agent',
      mountId: 'A1',
    })
  })

  test('badge hidden on empty provenance; visible chip links to the session', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    renderWithRouter(() => (
      <div data-testid="host">
        <IntentProvenanceBadge resourceType="agent" resourceId="A1" />
      </div>
    ))
    await screen.findByTestId('host')
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.queryByTestId('intent-provenance-badge')).toBeNull()
    cleanup()

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          { commitId: 'J1', sessionId: 'S9', sessionTitle: 'audit pipeline', createdAt: 1 },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    renderWithRouter(() => <IntentProvenanceBadge resourceType="agent" resourceId="A1" />)
    const badge = await screen.findByTestId('intent-provenance-badge')
    expect(badge.textContent).toContain(enUS.intent.provenanceBadge)
    fireEvent.click(badge)
    const probe = await screen.findByTestId('intent-detail-probe')
    expect(probe.textContent).toBe('S9')
  })
})
