// RFC-169 (T16) — the /mcps split page end-to-end (real routes + mocked API):
//   - empty pane at /mcps; card click opens the two-tab detail;
//   - Save stays in place (D2) and clears the dirty dot.
// (probeFreshness / probeUiStatus are unit-tested separately.)

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  operationConfigHash: string
}

let mcps: McpRow[]
let requests: Array<{ method: string; path: string; body: unknown }>
let failNextPut: boolean
let putWait: Promise<void> | null
let releasePut: (() => void) | null

function probeReceipt(hash: string) {
  return {
    id: 'p1',
    mcpId: 'db',
    mcpName: 'db',
    status: 'ok',
    latencyMs: 1,
    handshakeMs: 1,
    serverInfo: null,
    protocolVersion: null,
    capabilities: {},
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    startedAt: 6,
    finishedAt: 7,
    updatedAt: 7,
    configHashUsed: hash,
  }
}

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
    operationConfigHash: 'a'.repeat(64),
  }
}

function installFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!
      requests.push({ method, path, body })

      if (method === 'GET' && path === '/api/mcps') return json(mcps)
      if (method === 'GET' && path === '/api/mcps/probes') return json([])
      if (method === 'POST' && path === '/api/users/lookup') return json([])
      const detail = path.match(/^\/api\/mcps\/([^/]+)$/)
      if (detail) {
        const name = decodeURIComponent(detail[1]!)
        const m = mcps.find((x) => x.name === name)
        if (method === 'GET') return m ? json(m) : json({ error: 'nf' }, 404)
        if (method === 'PUT') {
          if (failNextPut) {
            failNextPut = false
            return json({ ok: false, code: 'save-failed', message: 'save failed' }, 500)
          }
          if (putWait !== null) await putWait
          const i = mcps.findIndex((x) => x.name === name)
          mcps[i] = {
            ...mcps[i]!,
            ...(body as object),
            updatedAt: 5,
            operationConfigHash: 'b'.repeat(64),
          }
          return json(mcps[i])
        }
      }
      if (/\/api\/mcps\/[^/]+\/probe$/.test(path) && method === 'GET') {
        return json({ ok: false, code: 'probe-not-found', message: 'never' }, 404)
      }
      if (/\/api\/mcps\/[^/]+\/probe$/.test(path) && method === 'POST') {
        return json(probeReceipt((body as { expectedConfigHash: string }).expectedConfigHash))
      }
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
  requests = []
  failNextPut = false
  putWait = null
  releasePut = null
  installFetch()
})
afterEach(() => {
  // Unmount route queries while this file's fetch mock is still installed. Restoring
  // first lets teardown-triggered auth/probe requests escape into the global guard.
  cleanup()
  vi.restoreAllMocks()
})

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
    expect(
      requests.find((request) => request.method === 'PUT' && request.path === '/api/mcps/db')?.body,
    ).toMatchObject({ expectedConfigHash: 'a'.repeat(64) })
    expect(router.state.location.pathname).toBe('/mcps/db')
  })

  test('dirty probe offers save-and-probe and forwards only the exact PUT receipt hash', async () => {
    renderMcps('/mcps/db')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'db' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), {
      target: { value: 'probe this draft' },
    })
    fireEvent.click(screen.getByTestId('mcp-tab-probe'))
    const action = await waitFor(() => screen.getByTestId('mcp-save-and-probe'))
    expect(screen.getByTestId('mcp-probe-saved-version')).toBeTruthy()
    fireEvent.click(action)
    await waitFor(() =>
      expect(
        requests.some(
          (request) => request.method === 'POST' && request.path === '/api/mcps/db/probe',
        ),
      ).toBe(true),
    )
    const putIndex = requests.findIndex(
      (request) => request.method === 'PUT' && request.path === '/api/mcps/db',
    )
    const probeIndex = requests.findIndex(
      (request) => request.method === 'POST' && request.path === '/api/mcps/db/probe',
    )
    expect(putIndex).toBeGreaterThanOrEqual(0)
    expect(probeIndex).toBeGreaterThan(putIndex)
    expect(requests[probeIndex]?.body).toEqual({ expectedConfigHash: 'b'.repeat(64) })
  })

  test('invalid hidden Config is activated/focused and sends neither save nor probe', async () => {
    renderMcps('/mcps/db')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'db' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Command/ }), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('mcp-tab-probe'))
    fireEvent.click(await waitFor(() => screen.getByTestId('mcp-save-and-probe')))
    await waitFor(() =>
      expect(screen.getByTestId('mcp-tab-config').getAttribute('aria-selected')).toBe('true'),
    )
    const command = screen.getByRole('textbox', { name: /Command/ })
    await waitFor(() => expect(document.activeElement).toBe(command))
    expect(command.getAttribute('aria-invalid')).toBe('true')
    expect(document.body.textContent).toContain(
      'Command must contain at least one executable entry.',
    )
    expect(
      requests.some(
        (request) =>
          request.method === 'PUT' ||
          (request.method === 'POST' && request.path === '/api/mcps/db/probe'),
      ),
    ).toBe(false)
  })

  test('save failure keeps the draft dirty and sends zero probe requests', async () => {
    renderMcps('/mcps/db')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'db' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), {
      target: { value: 'will fail' },
    })
    fireEvent.click(screen.getByTestId('mcp-tab-probe'))
    failNextPut = true
    fireEvent.click(await waitFor(() => screen.getByTestId('mcp-save-and-probe')))
    await waitFor(() => expect(document.body.textContent).toContain('save failed'))
    expect(screen.queryByTestId('split-card-dot-db')).not.toBeNull()
    expect(
      requests.some(
        (request) => request.method === 'POST' && request.path === '/api/mcps/db/probe',
      ),
    ).toBe(false)
  })

  test('dirty secondary action probes the disclosed saved hash without a PUT', async () => {
    renderMcps('/mcps/db')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'db' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), {
      target: { value: 'leave unsaved' },
    })
    fireEvent.click(screen.getByTestId('mcp-tab-probe'))
    fireEvent.click(await waitFor(() => screen.getByTestId('mcp-probe-saved-version')))
    await waitFor(() =>
      expect(
        requests.some(
          (request) => request.method === 'POST' && request.path === '/api/mcps/db/probe',
        ),
      ).toBe(true),
    )
    expect(requests.some((request) => request.method === 'PUT')).toBe(false)
    const operation = requests.find(
      (request) => request.method === 'POST' && request.path === '/api/mcps/db/probe',
    )
    expect(operation?.body).toEqual({ expectedConfigHash: 'a'.repeat(64) })
  })

  test('edits made while Save is pending stay dirty and prevent the follow-up probe', async () => {
    renderMcps('/mcps/db')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'db' }))
    fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), {
      target: { value: 'submitted snapshot' },
    })
    putWait = new Promise<void>((resolve) => {
      releasePut = resolve
    })
    fireEvent.click(screen.getByTestId('mcp-tab-probe'))
    fireEvent.click(await waitFor(() => screen.getByTestId('mcp-save-and-probe')))
    await waitFor(() =>
      expect(
        requests.some((request) => request.method === 'PUT' && request.path === '/api/mcps/db'),
      ).toBe(true),
    )
    fireEvent.click(screen.getByTestId('mcp-tab-config'))
    fireEvent.change(screen.getByRole('textbox', { name: /Description/ }), {
      target: { value: 'newer local edit' },
    })
    releasePut?.()
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        'The form changed again while saving. No probe was sent',
      ),
    )
    expect(screen.queryByTestId('split-card-dot-db')).not.toBeNull()
    expect(
      requests.some(
        (request) => request.method === 'POST' && request.path === '/api/mcps/db/probe',
      ),
    ).toBe(false)
  })
})
