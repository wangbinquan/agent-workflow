// RFC-169 (T18) — the /plugins split page end-to-end (real routes + mocked API):
//   - empty pane; card click opens the two-tab detail;
//   - the Updates tab's check-update writes the shared cache → the list card
//     lights up its "update available" chip (the cross-route cache link).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  operationConfigHash: string
}

let plugins: PluginRow[]
let requests: Array<{ path: string; method: string; body: unknown }> = []
let deferCheck = false
let resolveDeferredCheck: ((response: Response) => void) | null = null
let deferUpgrade = false
let resolveDeferredUpgrade: (() => void) | null = null
let latestQueryClient: QueryClient | null = null
let failSave = false
let failCheck = false
let staleCheckOnce = false
let checkAvailable = true
let checkIdentityStatus: 'known' | 'unknown' = 'known'

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
    operationConfigHash: 'a'.repeat(64),
  }
}

function installFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      requests.push({ path, method, body })

      if (method === 'GET' && path === '/api/plugins') return json(plugins)
      if (method === 'POST' && path === '/api/users/lookup') return json([])
      const detail = path.match(/^\/api\/plugins\/([^/]+)$/)
      if (detail && method === 'GET') {
        const p = plugins.find((x) => x.id === decodeURIComponent(detail[1]!))
        return p ? json(p) : json({ error: 'nf' }, 404)
      }
      if (detail && method === 'PUT') {
        if (failSave) return json({ code: 'save-failed', message: 'save failed' }, 500)
        const index = plugins.findIndex((x) => x.id === decodeURIComponent(detail[1]!))
        if (index < 0) return json({ error: 'nf' }, 404)
        plugins[index] = {
          ...plugins[index]!,
          ...(body as Partial<PluginRow>),
          operationConfigHash: 'b'.repeat(64),
          updatedAt: plugins[index]!.updatedAt + 1,
        }
        return json(plugins[index])
      }
      if (/\/api\/plugins\/[^/]+\/check-update$/.test(path) && method === 'POST') {
        if (failCheck) return json({ code: 'check-failed', message: 'check failed' }, 503)
        if (staleCheckOnce) {
          staleCheckOnce = false
          plugins[0] = {
            ...plugins[0]!,
            description: 'foreign write before Check',
            operationConfigHash: 'c'.repeat(64),
            updatedAt: plugins[0]!.updatedAt + 1,
          }
          return json(
            { code: 'resource-operation-stale', message: 'plugin changed; reload and retry' },
            409,
          )
        }
        const response = json({
          available: checkAvailable,
          current: '1.2.0',
          latest: checkAvailable ? '1.3.0' : '1.2.0',
          identityStatus: checkIdentityStatus,
          configHashUsed: (body as { expectedConfigHash: string }).expectedConfigHash,
        })
        if (deferCheck) {
          return new Promise<Response>((resolve) => {
            resolveDeferredCheck = () => resolve(response)
          })
        }
        return response
      }
      if (/\/api\/plugins\/[^/]+\/upgrade$/.test(path) && method === 'POST') {
        const current = plugins[0]!
        const resource = {
          ...current,
          resolvedVersion: '1.3.0',
          operationConfigHash: 'd'.repeat(64),
          updatedAt: current.updatedAt + 1,
        }
        plugins[0] = resource
        const response = json({
          configHashUsed: (body as { expectedConfigHash: string }).expectedConfigHash,
          resource,
        })
        if (deferUpgrade) {
          return new Promise<Response>((resolve) => {
            resolveDeferredUpgrade = () => resolve(response)
          })
        }
        return response
      }
      return json({ error: 'unhandled' }, 404)
    },
  )
}

function renderPlugins(initial: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  latestQueryClient = qc
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
  requests = []
  deferCheck = false
  resolveDeferredCheck = null
  deferUpgrade = false
  resolveDeferredUpgrade = null
  latestQueryClient = null
  failSave = false
  failCheck = false
  staleCheckOnce = false
  checkAvailable = true
  checkIdentityStatus = 'known'
  installFetch()
})
afterEach(() => {
  // Keep teardown-triggered route queries behind this file's fetch mock until the
  // component tree has unmounted; the global hook can then drain safely.
  cleanup()
  vi.restoreAllMocks()
})

describe('/plugins split page', () => {
  test('empty pane; card click opens the two-tab detail', async () => {
    const router = renderPlugins('/plugins')
    const card = await waitFor(() => screen.getByTestId('split-card-p1'))
    expect(card.querySelector('[data-icon="plugin"]')).not.toBeNull()
    expect(card.textContent).toContain('Plugin')
    expect(card.textContent).toContain('my-plugin@^1')
    expect(card.textContent).toContain('1.2.0')
    fireEvent.change(screen.getByTestId('split-search'), { target: { value: '1.2.0' } })
    expect(screen.getByTestId('split-card-p1')).toBeTruthy()
    expect(screen.getByText('Nothing selected')).toBeTruthy()
    expect(screen.getAllByTestId('split-new-button')).toHaveLength(1)
    expect(screen.queryByTestId('plugins-mobile-back')).toBeNull()
    expect(screen.getAllByRole('link', { name: '+ New plugin' })).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('list')
    fireEvent.click(screen.getByTestId('split-card-p1'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/plugins/p1'))
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    for (const [key, name] of [
      ['config', 'Config'],
      ['updates', 'Updates'],
    ] as const) {
      const tab = screen.getByRole('tab', { name })
      const panel = screen.getByTestId(`plugin-panel-${key}`)
      expect(tab.id).toBe(`plugins-detail-tab-${key}`)
      expect(tab.getAttribute('aria-controls')).toBe(panel.id)
      expect(panel.id).toBe(`plugins-detail-panel-${key}`)
      expect(panel.getAttribute('aria-labelledby')).toBe(tab.id)
    }
    expect(screen.getByTestId('plugins-mobile-back').getAttribute('href')).toBe('/plugins')
    expect(screen.getAllByTestId('plugins-mobile-back')).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('detail')
  })

  test('new route uses the shared back and keeps the rail create CTA unique', async () => {
    renderPlugins('/plugins/new')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: /New plugin/ }))
    expect(screen.getByTestId('plugins-mobile-back').getAttribute('href')).toBe('/plugins')
    expect(screen.getAllByTestId('plugins-mobile-back')).toHaveLength(1)
    expect(screen.getAllByTestId('split-new-button')).toHaveLength(1)
    expect(
      screen.getByTestId('split-detail').closest('.page--split')?.getAttribute('data-mobile-view'),
    ).toBe('detail')
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

  test('dirty Save and check publishes the exact PUT receipt before operation', async () => {
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    fireEvent.change(screen.getByLabelText(/^Spec/), { target: { value: 'my-plugin@^2' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    const button = screen.getByTestId('plugin-check-update')
    expect(button.textContent).toBe('Save and check')
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByTestId('plugin-update-my-plugin')).toBeTruthy())
    const writes = requests.filter(
      (request) => request.method === 'PUT' || request.path.endsWith('/check-update'),
    )
    expect(writes.map((request) => request.method)).toEqual(['PUT', 'POST'])
    expect(writes[0]?.body).toMatchObject({ expectedConfigHash: 'a'.repeat(64) })
    expect(writes[1]?.body).toEqual({ expectedConfigHash: 'b'.repeat(64) })
  })

  test('invalid draft returns to Config and performs zero save/check request', async () => {
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    fireEvent.change(screen.getByLabelText(/^Options \(JSON object\)/), {
      target: { value: '{broken' },
    })
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    fireEvent.click(screen.getByTestId('plugin-check-update'))
    await waitFor(() => expect(screen.getByTestId('plugin-panel-config').hidden).toBe(false))
    const options = screen.getByTestId('plugin-form-options')
    await waitFor(() => expect(document.activeElement).toBe(options))
    expect(options.getAttribute('aria-invalid')).toBe('true')
    expect(options.getAttribute('aria-errormessage')).toBe('plugin-field-options-error')
    expect(
      requests.some(
        (request) => request.method === 'PUT' || request.path.endsWith('/check-update'),
      ),
    ).toBe(false)
  })

  test('Save failure performs zero Check request and keeps the draft dirty', async () => {
    failSave = true
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    fireEvent.change(screen.getByLabelText(/^Spec/), { target: { value: 'my-plugin@^2' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    fireEvent.click(screen.getByTestId('plugin-check-update'))
    await waitFor(() => expect(screen.getByText(/save failed/)).toBeTruthy())
    expect(requests.filter((request) => request.path.endsWith('/check-update'))).toHaveLength(0)
    expect(screen.getByText('Draft differs from the saved plugin')).toBeTruthy()
  })

  test('no-change receipt is explicit and keeps Upgrade disabled', async () => {
    checkAvailable = false
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    fireEvent.click(screen.getByTestId('plugin-check-update'))
    await waitFor(() => expect(screen.getByText('This saved plugin is up to date.')).toBeTruthy())
    expect((screen.getByTestId('plugin-upgrade') as HTMLButtonElement).disabled).toBe(true)
  })

  test('Check transport error has a working exact-operation retry', async () => {
    failCheck = true
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    fireEvent.click(screen.getByTestId('plugin-check-update'))
    await waitFor(() => expect(screen.getByText(/check failed/)).toBeTruthy())
    failCheck = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByTestId('plugin-update-my-plugin')).toBeTruthy())
    expect(requests.filter((request) => request.path.endsWith('/check-update'))).toHaveLength(2)
  })

  test('stale Check reloads the saved hash so Retry uses the new exact basis', async () => {
    staleCheckOnce = true
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    fireEvent.click(screen.getByTestId('plugin-check-update'))
    await waitFor(() => expect(screen.getByText(/older saved revision/)).toBeTruthy())
    await waitFor(() =>
      expect(
        latestQueryClient!.getQueryData<PluginRow>(['plugins', 'p1'])?.operationConfigHash,
      ).toBe('c'.repeat(64)),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByTestId('plugin-update-my-plugin')).toBeTruthy())
    const checks = requests.filter((request) => request.path.endsWith('/check-update'))
    expect(checks.map((request) => request.body)).toEqual([
      { expectedConfigHash: 'a'.repeat(64) },
      { expectedConfigHash: 'c'.repeat(64) },
    ])
  })

  test('Upgrade applies only the exact checked hash and clears the ready chip', async () => {
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    fireEvent.click(screen.getByTestId('plugin-check-update'))
    await waitFor(() => expect(screen.getByTestId('plugin-update-my-plugin')).toBeTruthy())
    fireEvent.click(screen.getByTestId('plugin-upgrade'))
    await waitFor(() =>
      expect(screen.getByText('Upgrade published a new immutable plugin generation.')).toBeTruthy(),
    )
    expect(screen.queryByTestId('plugin-update-my-plugin')).toBeNull()
    const upgradeRequest = requests.find((request) => request.path.endsWith('/upgrade'))
    expect(upgradeRequest?.body).toEqual({ expectedConfigHash: 'a'.repeat(64) })
  })

  test('late Check receipt cannot populate cache after a newer resource hash wins', async () => {
    deferCheck = true
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    fireEvent.click(screen.getByTestId('plugin-check-update'))
    await waitFor(() => expect(resolveDeferredCheck).not.toBeNull())
    latestQueryClient!.setQueryData(['plugins', 'p1'], {
      ...plugins[0]!,
      description: 'foreign write',
      operationConfigHash: 'c'.repeat(64),
    })
    resolveDeferredCheck!(json({}))
    await waitFor(() => expect(screen.getByText(/older saved revision/)).toBeTruthy())
    expect(screen.queryByTestId('plugin-update-my-plugin')).toBeNull()
  })

  test('late Upgrade receipt cannot roll the detail query back over a newer PUT hash', async () => {
    deferUpgrade = true
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    fireEvent.click(screen.getByTestId('plugin-check-update'))
    await waitFor(() => expect(screen.getByTestId('plugin-update-my-plugin')).toBeTruthy())
    fireEvent.click(screen.getByTestId('plugin-upgrade'))
    await waitFor(() => expect(resolveDeferredUpgrade).not.toBeNull())

    const newer = {
      ...plugins[0]!,
      description: 'foreign PUT after backend upgrade',
      operationConfigHash: 'e'.repeat(64),
      updatedAt: plugins[0]!.updatedAt + 1,
    }
    plugins[0] = newer
    latestQueryClient!.setQueryData(['plugins', 'p1'], newer)
    resolveDeferredUpgrade!()

    await waitFor(() => expect(screen.getByText(/older saved revision/)).toBeTruthy())
    await waitFor(() =>
      expect(
        latestQueryClient!.getQueryData<PluginRow>(['plugins', 'p1'])?.operationConfigHash,
      ).toBe('e'.repeat(64)),
    )
    expect(latestQueryClient!.getQueryData<PluginRow>(['plugins', 'p1'])?.description).toBe(
      'foreign PUT after backend upgrade',
    )
  })

  test('file source explains external management and exposes no Check/Upgrade actions', async () => {
    plugins[0] = { ...plugins[0]!, sourceKind: 'file', spec: '/tmp/external-plugin' }
    renderPlugins('/plugins/p1')
    await waitFor(() => screen.getByRole('heading', { level: 2, name: 'my-plugin' }))
    fireEvent.click(screen.getByRole('tab', { name: 'Updates' }))
    expect(screen.getByText('Managed by an external path')).toBeTruthy()
    expect(screen.queryByTestId('plugin-check-update')).toBeNull()
    expect(screen.queryByTestId('plugin-upgrade')).toBeNull()
  })
})
