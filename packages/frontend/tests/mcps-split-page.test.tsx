// RFC-169 (T16) — the /mcps split page end-to-end (real routes + mocked API):
//   - empty pane at /mcps; card click opens the two-tab detail;
//   - Save stays in place (D2) and clears the dirty dot.
// (probeFreshness / probeUiStatus are unit-tested separately.)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import { IndexRoute as mcpsIndexRoute, Route as mcpsRoute } from '../src/routes/mcps'
import { Route as mcpDetailRoute } from '../src/routes/mcps.detail'
import { Route as mcpNewRoute } from '../src/routes/mcps.new'
import '../src/i18n'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface McpRow {
  id: string
  name: string
  description: string
  type: 'local' | 'remote'
  config: { command?: string[]; url?: string; timeoutMs?: number }
  enabled: boolean
  schemaVersion: number
  createdAt: number
  updatedAt: number
  visibility: 'public' | 'private'
  ownerUserId: string | null
}

let mcps: McpRow[]

function makeMcp(name: string, description = ''): McpRow {
  return {
    id: name,
    name,
    description,
    type: 'local',
    config: { command: ['uvx', 'thing'] },
    enabled: true,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 1,
    visibility: 'public',
    ownerUserId: null,
  }
}

function installFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!

      if (method === 'GET' && path === '/api/mcps') return json(mcps)
      if (method === 'GET' && path === '/api/mcps/probes') return json([])
      if (method === 'POST' && path === '/api/users/lookup') return json([])
      const detail = path.match(/^\/api\/mcps\/([^/]+)$/)
      if (detail) {
        const name = decodeURIComponent(detail[1]!)
        const m = mcps.find((x) => x.name === name)
        if (method === 'GET') return m ? json(m) : json({ error: 'nf' }, 404)
        if (method === 'PUT') {
          const i = mcps.findIndex((x) => x.name === name)
          mcps[i] = { ...mcps[i]!, ...(body as object), updatedAt: 5 }
          return json(mcps[i])
        }
      }
      if (/\/api\/mcps\/[^/]+\/probe$/.test(path) && method === 'POST')
        return json({ mcpName: 'x' })
      return json({ error: 'unhandled' }, 404)
    },
  )
}

function renderMcps(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = RootRoute.addChildren([
    mcpsRoute.addChildren([mcpNewRoute, mcpDetailRoute, mcpsIndexRoute]),
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
  mcps = [makeMcp('db', 'postgres')]
  installFetch()
})
afterEach(() => vi.restoreAllMocks())

describe('/mcps split page', () => {
  test('empty pane; card click opens the two-tab detail', async () => {
    const router = renderMcps('/mcps')
    const card = await waitFor(() => screen.getByTestId('split-card-db'))
    expect(card.querySelector('[data-icon="mcp"]')).not.toBeNull()
    expect(card.textContent).toContain('MCP')
    expect(card.textContent).toContain('Local (stdio)')
    expect(card.querySelector('[data-testid="mcp-probe-status-unknown"]')).not.toBeNull()
    fireEvent.change(screen.getByTestId('split-search'), { target: { value: 'Local (stdio)' } })
    expect(screen.getByTestId('split-card-db')).toBeTruthy()
    expect(screen.getByText('Nothing selected')).toBeTruthy()
    expect(screen.getAllByTestId('split-new-button')).toHaveLength(1)
    expect(screen.queryByTestId('mcps-mobile-back')).toBeNull()
    expect(screen.getAllByRole('link', { name: '+ New MCP' })).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('list')
    fireEvent.click(screen.getByTestId('split-card-db'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/mcps/db'))
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'db' }))
    for (const [key, name] of [
      ['config', 'Config'],
      ['probe', 'Tools'],
    ] as const) {
      const tab = screen.getByRole('tab', { name: new RegExp(name) })
      const panel = screen.getByTestId(`mcp-panel-${key}`)
      expect(tab.id).toBe(`mcps-detail-tab-${key}`)
      expect(tab.getAttribute('aria-controls')).toBe(panel.id)
      expect(panel.id).toBe(`mcps-detail-panel-${key}`)
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id)
    }
    expect(screen.getByTestId('mcps-mobile-back').getAttribute('href')).toBe('/mcps')
    expect(screen.getAllByTestId('mcps-mobile-back')).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('detail')
  })

  test('new route uses the shared back and keeps the rail create CTA unique', async () => {
    renderMcps('/mcps/new')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: /New MCP/ }))
    expect(screen.getByTestId('mcps-mobile-back').getAttribute('href')).toBe('/mcps')
    expect(screen.getAllByTestId('mcps-mobile-back')).toHaveLength(1)
    expect(screen.getAllByTestId('split-new-button')).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('detail')
  })

  test('Save stays in place, clears the dirty dot', async () => {
    const router = renderMcps('/mcps/db')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'db' }))
    const desc = screen.getByRole('textbox', { name: /Description/ }) as HTMLInputElement
    fireEvent.change(desc, { target: { value: 'edited mcp desc' } })
    await waitFor(() => expect(screen.queryByTestId('split-card-dot-db')).not.toBeNull())
    fireEvent.click(screen.getByTestId('mcp-save-button'))
    await waitFor(() => expect(screen.queryByTestId('split-card-dot-db')).toBeNull())
    expect(router.state.location.pathname).toBe('/mcps/db')
  })
})
