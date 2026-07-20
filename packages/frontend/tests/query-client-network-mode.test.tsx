// Regression lock: "点击创建代理卡在创建中" (user report 2026-07-20).
//
// Reproduced live against the running daemon: after the browser fires a single
// `offline` event, clicking 创建代理 wedges the button at 「创建中…」 forever —
// the whole <fieldset disabled> form freezes, NO HTTP request is ever sent, and
// no error surfaces. Only a page reload recovers.
//
// Root cause: TanStack Query's default `networkMode: 'online'`. `onlineManager`
// never reads `navigator.onLine`; it flips purely on the window `online` /
// `offline` events (query-core/onlineManager.js), and once it believes the
// browser is offline `canStart()` refuses to run the mutation — which parks it
// at `status: 'pending'` (so `create.isPending` stays true) instead of failing.
// Resuming additionally requires `focusManager.isFocused()`, so a background tab
// stays wedged even after the network returns.
//
// That signal is meaningless here: the daemon is on 127.0.0.1, so internet
// reachability says nothing about whether the API is up. macOS emits
// offline/online on Wi-Fi drops, VPN toggles and sleep/wake, and each one can
// brick every write in an open tab. `networkMode: 'always'` makes the request
// actually go out; a genuinely unreachable daemon then fails fast as
// ApiError(0, 'network-unreachable'), which the UI already localizes.
//
// The behavioural test drives the REAL /agents/new route with the REAL
// production client (createQueryClient) — a data-only assertion on the defaults
// would not have caught the user-visible freeze.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { createQueryClient } from '../src/lib/query-client'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import { IndexRoute as agentsIndexRoute, Route as agentsRoute } from '../src/routes/agents'
import { Route as agentDetailRoute } from '../src/routes/agents.detail'
import { Route as agentNewRoute } from '../src/routes/agents.new'
import '../src/i18n'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeAgent(name: string) {
  return {
    id: name,
    name,
    description: '',
    outputs: [],
    inputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    visibility: 'public' as const,
    ownerUserId: null,
  }
}

let posted: string[]

function installFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const path = url.replace(/^https?:\/\/[^/]+/, '')

      if (method === 'POST' && path.endsWith('/api/agents')) {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
        posted.push((body as { name: string }).name)
        return json(makeAgent((body as { name: string }).name))
      }
      if (method === 'GET' && path.endsWith('/api/agents')) return json([])
      if (method === 'GET' && path.includes('/api/agents/'))
        return json(makeAgent(decodeURIComponent(path.split('/api/agents/')[1]!.split('?')[0]!)))
      if (method === 'GET' && path.endsWith('/api/runtimes'))
        return json({
          runtimes: [{ name: 'opencode', protocol: 'opencode', enabled: true, isDefault: true }],
        })
      if (method === 'GET' && path.endsWith('/api/config'))
        return json({ defaultRuntime: 'opencode' })
      if (method === 'POST' && path.endsWith('/api/users/lookup')) return json([])
      if (method === 'GET' && /\/api\/(skills|mcps|plugins)/.test(path)) return json([])
      return json({ error: 'unhandled' }, 404)
    },
  )
}

function renderAgentsNew() {
  const tree = RootRoute.addChildren([
    agentsRoute.addChildren([agentNewRoute, agentDetailRoute, agentsIndexRoute]),
  ])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/agents/new'] }),
  })
  render(
    <QueryClientProvider client={createQueryClient()}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  posted = []
  installFetch()
})

afterEach(() => {
  // Never leak the offline flag into other files — it would pause their
  // mutations the same way and produce baffling timeouts.
  onlineManager.setOnline(true)
  vi.restoreAllMocks()
})

describe('production query client · networkMode', () => {
  // Data oracle for the defaults. Both halves matter: queries left on 'online'
  // strand every list in fetchStatus:'paused' with a spinner that never ends.
  test('queries and mutations both opt out of the browser online gate', () => {
    const defaults = createQueryClient().getDefaultOptions()
    expect(defaults.queries?.networkMode).toBe('always')
    expect(defaults.mutations?.networkMode).toBe('always')
  })

  // Codex impl-gate finding: query-core derives refetchOnReconnect from
  // networkMode (`networkMode !== 'always'`, queryClient.js:272), so opting into
  // 'always' turns reconnect refetching off unless it is spelled out. Paired
  // with refetchOnWindowFocus:false that would strand a query which errored
  // during an outage. Assert the RESOLVED option, so the coupling is caught even
  // if someone drops the explicit flag.
  test('keeps refetch-on-reconnect despite networkMode always', () => {
    const resolved = createQueryClient().defaultQueryOptions({ queryKey: ['probe'] })
    expect(resolved.refetchOnReconnect).toBe(true)
  })

  test('creating an agent still fires while the browser reports offline', async () => {
    const router = renderAgentsNew()
    await waitFor(() => screen.getByTestId('agent-create-button'))

    const name = screen.getByRole('textbox', { name: /Name/ }) as HTMLInputElement
    fireEvent.change(name, { target: { value: 'offline-created' } })

    // A single Wi-Fi blip / VPN toggle is all it takes.
    onlineManager.setOnline(false)

    fireEvent.click(screen.getByTestId('agent-create-button'))

    // The request must actually leave, and the route must land on the new agent
    // instead of sitting on a frozen "Creating…" button.
    await waitFor(() => expect(posted).toEqual(['offline-created']))
    await waitFor(() => expect(router.state.location.pathname).toBe('/agents/offline-created'))
  })
})
