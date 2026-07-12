// Regression lock: /plugins/new must let the user fix a rejected Spec and
// re-submit successfully WITHOUT reopening the page.
//
// History: RFC-031's first cut made /plugins a single page with a shared
// inline create/edit form synced from the live ['plugins'] query via
//   useEffect(() => { if (editingId === null) setForm(EMPTY_FORM) ... },
//             [editingId, data])
// so any list refetch that changed `data`'s identity (window-focus refetch,
// post-mutation invalidate, reconnect) wiped the user's in-progress input —
// they fixed the Spec, the edit got clobbered, the re-submit sent the stale
// value, and only reopening the editor (a fresh form) worked. Commit 4257975
// fixed it by splitting create into its own /plugins/new route whose only
// state is local useState(form/errors) — no useQuery, no syncing effect.
//
// This test drives the REAL PluginCreatePage through the bad-spec → fix →
// retry sequence and asserts the second POST carries the corrected spec and
// navigates on success. If anyone reintroduces a query-synced form here, the
// retry would send a stale/empty spec and these assertions go red.

import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

const h = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  createRoute: (o: unknown) => o,
  useNavigate: () => h.navigate,
}))
vi.mock('../src/routes/__root', () => ({ Route: {} }))

// Imported AFTER the mocks so createRoute/useNavigate resolve to the stubs.
import { Route as PluginNewRoute } from '../src/routes/plugins.new'
import { SplitDirtyContext } from '../src/components/split/splitDirty'

interface FetchCall {
  url: string
  method: string
  body: Record<string, unknown> | null
}

function installFetch(handler: (call: FetchCall) => Response): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      let body: Record<string, unknown> | null = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>
        } catch {
          body = null
        }
      }
      const call: FetchCall = { url, method, body }
      calls.push(call)
      return handler(call)
    },
  )
  return calls
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  h.navigate.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function renderCreatePage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Comp = (PluginNewRoute as unknown as { component: ComponentType }).component
  return render(
    <QueryClientProvider client={qc}>
      <SplitDirtyContext.Provider value={{ dirtyKey: null, report: () => {} }}>
        <Comp />
      </SplitDirtyContext.Provider>
    </QueryClientProvider>,
  )
}

describe('plugin create — fix a rejected spec and retry in place', () => {
  test('server 422 on first save, then corrected spec is sent and succeeds', async () => {
    const calls = installFetch((call) => {
      if (call.method === 'POST' && call.url.includes('/api/plugins')) {
        if (call.body?.spec === 'dd-trace') {
          return json({ id: 'plg_ok', name: 'myplugin', spec: 'dd-trace' }, 201)
        }
        return json(
          { code: 'plugin-install-failed', message: 'plugin install failed (exit 1)' },
          422,
        )
      }
      return json([], 200)
    })

    renderCreatePage()

    const nameInput = await screen.findByPlaceholderText('dd-trace')
    const specInput = screen.getByPlaceholderText(/@scope\/pkg/)
    fireEvent.change(nameInput, { target: { value: 'myplugin' } })
    fireEvent.change(specInput, { target: { value: 'badpkg' } })

    const save = screen.getByTestId('plugin-save-button') as HTMLButtonElement
    fireEvent.click(save)

    await waitFor(() => {
      const post1 = calls.find((c) => c.method === 'POST')
      expect(post1).toBeDefined()
      expect(post1!.body!.spec).toBe('badpkg')
    })

    // Fix the spec and save again — no reopening the page.
    fireEvent.change(specInput, { target: { value: 'dd-trace' } })
    fireEvent.click(save)

    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'POST').length).toBe(2)
    })
    const posts = calls.filter((c) => c.method === 'POST')
    // The retry must carry the corrected spec, not the stale one.
    expect(posts[1]!.body!.spec).toBe('dd-trace')
    await waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1))
  })

  test('client-side first error (empty spec), then fix → retry succeeds', async () => {
    const calls = installFetch((call) => {
      if (call.method === 'POST' && call.url.includes('/api/plugins')) {
        return json({ id: 'plg_ok', name: 'myplugin', spec: 'dd-trace' }, 201)
      }
      return json([], 200)
    })

    renderCreatePage()

    const nameInput = await screen.findByPlaceholderText('dd-trace')
    fireEvent.change(nameInput, { target: { value: 'myplugin' } })
    // Spec left empty → client validation rejects before any POST.
    const save = screen.getByTestId('plugin-save-button') as HTMLButtonElement
    fireEvent.click(save)

    await waitFor(() => expect(screen.getByText(/spec is required/i)).toBeTruthy())
    expect(calls.filter((c) => c.method === 'POST').length).toBe(0)

    const specInput = screen.getByPlaceholderText(/@scope\/pkg/)
    fireEvent.change(specInput, { target: { value: 'dd-trace' } })
    fireEvent.click(save)

    await waitFor(() => {
      const posts = calls.filter((c) => c.method === 'POST')
      expect(posts.length).toBe(1)
      expect(posts[0]!.body!.spec).toBe('dd-trace')
    })
    await waitFor(() => expect(h.navigate).toHaveBeenCalledTimes(1))
  })
})
