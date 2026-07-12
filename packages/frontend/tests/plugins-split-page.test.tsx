// RFC-169 (T18) — the /plugins split page end-to-end (real routes + mocked API):
//   - empty pane; card click opens the two-tab detail;
//   - the Updates tab's check-update writes the shared cache → the list card
//     lights up its "update available" chip (the cross-route cache link).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import { IndexRoute as pluginsIndexRoute, Route as pluginsRoute } from '../src/routes/plugins'
import { Route as pluginDetailRoute } from '../src/routes/plugins.detail'
import { Route as pluginNewRoute } from '../src/routes/plugins.new'
import '../src/i18n'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface PluginRow {
  id: string
  name: string
  spec: string
  sourceKind: 'npm' | 'file' | 'git'
  resolvedVersion: string | null
  options: Record<string, unknown>
  description: string
  enabled: boolean
  schemaVersion: number
  createdAt: number
  updatedAt: number
  visibility: 'public' | 'private'
  ownerUserId: string | null
}

let plugins: PluginRow[]

function makePlugin(): PluginRow {
  return {
    id: 'p1',
    name: 'my-plugin',
    spec: 'my-plugin@^1',
    sourceKind: 'npm',
    resolvedVersion: '1.2.0',
    options: {},
    description: '',
    enabled: true,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    visibility: 'public',
    ownerUserId: null,
  }
}

function installFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!

      if (method === 'GET' && path === '/api/plugins') return json(plugins)
      if (method === 'POST' && path === '/api/users/lookup') return json([])
      const detail = path.match(/^\/api\/plugins\/([^/]+)$/)
      if (detail && method === 'GET') {
        const p = plugins.find((x) => x.id === decodeURIComponent(detail[1]!))
        return p ? json(p) : json({ error: 'nf' }, 404)
      }
      if (/\/api\/plugins\/[^/]+\/check-update$/.test(path) && method === 'POST')
        return json({ available: true, current: '1.2.0', latest: '1.3.0' })
      return json({ error: 'unhandled' }, 404)
    },
  )
}

function renderPlugins(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = RootRoute.addChildren([
    pluginsRoute.addChildren([pluginNewRoute, pluginDetailRoute, pluginsIndexRoute]),
  ])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
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
  plugins = [makePlugin()]
  installFetch()
})
afterEach(() => vi.restoreAllMocks())

describe('/plugins split page', () => {
  test('empty pane; card click opens the two-tab detail', async () => {
    const router = renderPlugins('/plugins')
    await waitFor(() => screen.getByTestId('split-card-p1'))
    expect(screen.getByText('Nothing selected')).toBeTruthy()
    fireEvent.click(screen.getByTestId('split-card-p1'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/plugins/p1'))
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    expect(screen.getByRole('tab', { name: 'Config' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Updates' })).toBeTruthy()
  })

  test('check-update in the Updates tab lights up the list card chip (shared cache)', async () => {
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    expect(screen.queryByTestId('plugin-update-my-plugin')).toBeNull() // not checked yet
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    fireEvent.click(await waitFor(() => screen.getByTestId('plugin-check-update')))
    // The list card (left rail, always mounted) now shows the update chip.
    await waitFor(() => expect(screen.getByTestId('plugin-update-my-plugin')).toBeTruthy())
  })
})
