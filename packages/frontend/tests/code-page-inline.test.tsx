// RFC-304 T32/T33 — the `/code` page, rendered.
//
// What is worth asserting here is not that the markup exists, but that the page
// answers the question somebody opens it with: is this capability going to run,
// and if not, what do I do about it?
//
// So the load-bearing case is a MISCONFIGURED cell. A page that shows a red
// label and stops has moved the problem rather than solved it — the person now
// has to work out which of five prerequisites is missing and where it lives.
// The backend pairs each missing piece with the route that fixes it; this test
// pins that the page actually renders those as links.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
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

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(handlers: { rows?: unknown[]; workItems?: unknown[] }): Recorded {
  const rec: Recorded = { calls: [] }
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      rec.calls.push({ url, method, body })
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/api/code/work-items')) {
        return json({ items: handlers.workItems ?? [], nextCursor: null })
      }
      if (url.includes('/api/code/matrix')) {
        if (method === 'PUT') return json({ row: (handlers.rows ?? [])[0] })
        return json({ rows: handlers.rows ?? [] })
      }
      return json({})
    },
  )
  return rec
}

async function renderPage(initial = '/code') {
  const page = await import('../src/routes/code')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const codeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/code',
    validateSearch: page.validateCodeSearch,
    component: page.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([codeRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

const READY_ROW = {
  repoId: 'group/project',
  capability: 'mr-review',
  enabled: true,
  readiness: 'ready',
  issues: [],
  repairActions: [],
  bindingId: 'binding-1',
}

const MISCONFIGURED_ROW = {
  repoId: 'group/project',
  capability: 'mr-review',
  enabled: true,
  readiness: 'misconfigured',
  issues: [
    { code: 'no-binding', detail: 'no capability binding is selected for this repo' },
    { code: 'code-host-unconfigured', detail: 'no code-host connection is configured' },
  ],
  repairActions: [
    { code: 'no-binding', label: 'Choose a configuration', route: '/code/bindings' },
    { code: 'code-host-unconfigured', label: 'Add a code host', route: '/settings/code-hosts' },
  ],
  bindingId: null,
}

describe('RFC-304 — the capability matrix', () => {
  test('without a repository it asks for one rather than showing an empty table', async () => {
    installFetch({})
    await renderPage()
    expect(await screen.findByText(/enter a repository/i)).toBeTruthy()
  })

  test('a ready capability is shown as ready', async () => {
    installFetch({ rows: [READY_ROW] })
    await renderPage('/code?repo=group%2Fproject')
    expect(await screen.findByText('mr-review')).toBeTruthy()
    expect(await screen.findByText(/ready/i)).toBeTruthy()
  })

  test('a misconfigured capability names EACH missing piece', async () => {
    // Not "misconfigured" alone: the whole value of the page is that the person
    // learns which prerequisite is absent without reading a log.
    installFetch({ rows: [MISCONFIGURED_ROW] })
    await renderPage('/code?repo=group%2Fproject')
    expect(await screen.findByText(/no capability binding is selected/i)).toBeTruthy()
    expect(await screen.findByText(/no code-host connection is configured/i)).toBeTruthy()
  })

  test('each missing piece carries a link to where it is fixed', async () => {
    // A red label with no next step is only marginally better than silence —
    // which the design names as the most common reason a platform like this
    // gets abandoned.
    installFetch({ rows: [MISCONFIGURED_ROW] })
    await renderPage('/code?repo=group%2Fproject')
    const fix = await screen.findByText('Choose a configuration')
    expect(fix.getAttribute('href')).toBe('/code/bindings')
    const host = await screen.findByText('Add a code host')
    expect(host.getAttribute('href')).toBe('/settings/code-hosts')
  })

  test('toggling a capability PUTs to the matrix endpoint', async () => {
    const rec = installFetch({ rows: [READY_ROW] })
    await renderPage('/code?repo=group%2Fproject')
    const toggle = await screen.findByTestId('code-toggle-mr-review')
    ;(toggle as HTMLInputElement).click()

    await waitFor(() => {
      const put = rec.calls.find((c) => c.method === 'PUT')
      expect(put).toBeDefined()
      expect(put?.body).toMatchObject({ capability: 'mr-review', enabled: false })
    })
  })

  test('the repository is not requested until one is chosen', async () => {
    // An empty path segment would 404 and read as a broken page on first open.
    const rec = installFetch({})
    await renderPage()
    await waitFor(() => {
      expect(rec.calls.some((c) => c.url.includes('/api/code/matrix'))).toBe(false)
    })
  })
})

describe('RFC-304 — the activity view', () => {
  test('an empty deployment explains what will appear here', async () => {
    // "Nothing yet" with no explanation reads as broken on a fresh install.
    installFetch({ workItems: [] })
    await renderPage('/code?tab=activity')
    expect(await screen.findByText(/nothing has run yet/i)).toBeTruthy()
  })

  test('a work item shows its rounds expanded into stages', async () => {
    installFetch({
      workItems: [
        {
          workItemId: 'wi-1',
          capability: 'mr-review',
          anchorKind: 'mr',
          anchorId: '412',
          status: 'idle',
          epoch: 1,
          rounds: [
            {
              roundId: 'r-1',
              roundSeq: 1,
              status: 'published',
              outcome: 'published',
              baselineSha: 'abc',
              stages: [
                {
                  stageName: 'resolve-target',
                  stageSeq: 0,
                  kind: 'program',
                  status: 'done',
                  error: null,
                },
                {
                  stageName: 'review-shard',
                  stageSeq: 4,
                  kind: 'ai',
                  status: 'failed',
                  error: 'the reviewer never returned a valid result',
                },
              ],
            },
          ],
        },
      ],
    })
    await renderPage('/code?tab=activity')

    expect(await screen.findByText('resolve-target')).toBeTruthy()
    expect(await screen.findByText('review-shard')).toBeTruthy()
    // A failed stage without its reason forces a log dig for the one fact the
    // person is looking at the page to learn.
    expect(await screen.findByText(/never returned a valid result/i)).toBeTruthy()
  })
})
