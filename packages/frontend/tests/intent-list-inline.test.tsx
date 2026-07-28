// RFC-234 (T8) — /intent list locks:
//   1. Sessions render with title + status chip (inFlight → generating).
//   2. The create dialog POSTs {message, hint?} and navigates to the detail.
//   3. Start button disabled until a non-empty message exists.

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
import type { IntentSessionSummary } from '@agent-workflow/shared'
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

function session(id: string, overrides: Partial<IntentSessionSummary> = {}): IntentSessionSummary {
  return {
    id,
    title: `goal-${id}`,
    status: 'active',
    contextRevision: 0,
    turnSeq: 2,
    commitSeq: 0,
    inFlight: false,
    currentDraftRevision: null,
    createdAt: 1,
    updatedAt: Date.now(),
    ...overrides,
  }
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(rows: IntentSessionSummary[]): Recorded {
  const rec: Recorded = { calls: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      rec.calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/api/intent-sessions') && method === 'POST') {
        return json(session('new-one'), 201)
      }
      if (url.includes('/api/intent-sessions')) return json(rows)
      return json([])
    },
  )
  return rec
}

async function renderPage(initialEntry = '/intent') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const list = await import('../src/routes/intent')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/intent',
    component: list.Route.options.component,
    // Reuse the real search coercion so `?create=true&mountType=…` behaves
    // exactly like production (raw strings otherwise).
    validateSearch: list.Route.options.validateSearch,
  })
  const detailStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/intent/$sessionId',
    component: () => <div data-testid="detail-stub" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailStub]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('RFC-234 /intent list', () => {
  test('rows render with status chips; in-flight shows generating', async () => {
    installFetch([session('a'), session('b', { inFlight: true })])
    await renderPage()
    await screen.findByText('goal-a')
    expect(screen.getByText('goal-b')).toBeTruthy()
    expect(screen.getByText(enUS.intent.statusRunning)).toBeTruthy()
    expect(screen.getByText(enUS.intent.statusActive)).toBeTruthy()
  })

  test('create dialog gates on message, POSTs and navigates to the detail', async () => {
    const rec = installFetch([])
    await renderPage()
    await screen.findByText(enUS.intent.emptyTitle)
    fireEvent.click(screen.getAllByRole('button', { name: enUS.intent.newSession })[0]!)
    const start = await screen.findByRole('button', { name: enUS.intent.startBuilding })
    expect((start as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('intent-create-message'), {
      target: { value: '  build an audit pipeline  ' },
    })
    expect((start as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(start)
    await waitFor(() => {
      const post = rec.calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/api/intent-sessions'),
      )
      expect(post?.body).toEqual({ message: 'build an audit pipeline' })
    })
    await screen.findByTestId('detail-stub')
  })

  // User feedback 2026-07-28: the artifact type is a dropdown on plain
  // creates, and the MODIFY entry must not ask for it at all — the mounted
  // target IS the subject, and it rides the create POST as `mounts`.
  test('create shows the type dropdown; modify entry hides it and mounts the target', async () => {
    installFetch([])
    await renderPage('/intent?create=true')
    // Dialog auto-opened via search; the artifact-type Select shows Auto.
    await screen.findByRole('button', { name: enUS.intent.startBuilding })
    expect(screen.getByText(enUS.intent.hintAuto)).toBeTruthy()
    expect(screen.queryByTestId('intent-modify-target')).toBeNull()
    cleanup()

    const rec = installFetch([])
    await renderPage('/intent?create=true&mountType=agent&mountId=A1')
    await screen.findByTestId('intent-modify-target')
    expect(screen.queryByText(enUS.intent.hintAuto)).toBeNull()
    fireEvent.change(screen.getByTestId('intent-create-message'), {
      target: { value: 'tweak the auditor' },
    })
    fireEvent.click(screen.getByRole('button', { name: enUS.intent.startBuilding }))
    await waitFor(() => {
      const post = rec.calls.find(
        (call) => call.method === 'POST' && call.url.endsWith('/api/intent-sessions'),
      )
      expect(post?.body).toEqual({
        message: 'tweak the auditor',
        mounts: [{ resourceType: 'agent', resourceId: 'A1' }],
      })
    })
  })
})
