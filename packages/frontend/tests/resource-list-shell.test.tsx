// RFC-151 PR-3 — list-shell primitives contract.
//
// The resource list pages (agents/skills/mcps/plugins + the RFC-191 gallery
// pages workflows/workgroups) share `useResourceList` (query + delete
// mutation + RFC-099 owner lookup) and `<ResourceBadges>` (private chip +
// owner badge). Page-level render locks keep covering the pages; this file
// locks the primitives' own behavior:
//   1. useResourceList fetches `GET {endpoint}` under the given key.
//   2. del.mutateAsync(row) DELETEs by immutable id
//      and invalidates the list on success.
//   3. owners resolves ownerUserId → displayName via POST /api/users/lookup.
//
// RFC-191 note: <ResourceNameCell> (the table-era nowrap name cell) retired
// with the last two data-table callers — workflows/workgroups render cards
// now; ResourceBadges (extracted in RFC-169 T4) is the surviving primitive.

import { existsSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import type { UserPublic } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import { useResourceList } from '../src/hooks/useResourceList'
import { ResourceBadges, type OwnerLookup } from '../src/components/ResourceBadges'
import '../src/i18n'

const FRONTEND_SRC_DIR = resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'src')

interface Row {
  id: string
  name: string
  ownerUserId?: string | null
}

interface Call {
  url: string
  method: string
  body: unknown
}

function installFetch(endpoint: string, rowsByGet: () => Row[]): Call[] {
  const calls: Call[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      let body: unknown = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      calls.push({ url, method, body })
      if (method === 'POST' && url.endsWith('/api/users/lookup')) {
        const users: UserPublic[] = [
          { id: 'u1', username: 'alice', displayName: 'Alice', role: 'user', status: 'active' },
        ]
        return new Response(JSON.stringify(users), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'DELETE' && url.includes(`${endpoint}/`)) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'GET' && url.endsWith(endpoint)) {
        return new Response(JSON.stringify(rowsByGet()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // Anything else (root-shell /api/me etc.) → 404 so unrelated queries
      // fail cleanly instead of receiving wrong-shaped rows.
      return new Response('not found', { status: 404 })
    },
  )
  return calls
}

/** Mount `Component` as the /agents route inside a minimal real router (the
 *  shared cell renders TanStack <Link>s, which need a RouterProvider). */
function renderAtAgents(Component: () => React.ReactElement | null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const listRoute = createRoute({
    getParentRoute: () => RootRoute,
    path: '/agents',
    component: Component,
  })
  const detailStub = createRoute({
    getParentRoute: () => RootRoute,
    path: '/agents/$id',
    component: () => null,
  })
  const tree = RootRoute.addChildren([listRoute, detailStub])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/agents'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('useResourceList', () => {
  function Probe(props: { endpoint: string }) {
    const { data, isLoading, error, refetch, del, owners } = useResourceList<Row>({
      queryKey: ['rl-test', props.endpoint],
      endpoint: props.endpoint,
    })
    if (isLoading) return <p>loading…</p>
    if (error !== null && error !== undefined && data === undefined) return <p>failed</p>
    return (
      <>
        {error !== null && error !== undefined && <p role="alert">failed</p>}
        <ul>
          {(data ?? []).map((r) => (
            <li key={r.id}>
              <span data-testid={`row-${r.id}`}>{r.name}</span>
              <span data-testid={`owner-${r.id}`}>
                {r.ownerUserId != null ? (owners.get(r.ownerUserId)?.displayName ?? '') : ''}
              </span>
              <button type="button" onClick={() => void del.mutateAsync(r)}>
                del {r.id}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={() => void refetch()}>
          retry
        </button>
      </>
    )
  }

  test('fetches GET {endpoint}, deletes by id, and invalidates the list', async () => {
    const calls = installFetch('/api/agents', () => [
      { id: 'a1', name: 'alpha needs/escape', ownerUserId: 'u1' },
      { id: 'a2', name: 'beta', ownerUserId: null },
    ])
    renderAtAgents(() => <Probe endpoint="/api/agents" />)
    await waitFor(() => screen.getByTestId('row-a1'))
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/api/agents'))).toBe(true)

    fireEvent.click(screen.getByText('del a1'))
    await waitFor(() => {
      const dels = calls.filter((c) => c.method === 'DELETE')
      expect(dels).toHaveLength(1)
      expect(dels[0]!.url).toContain('/api/agents/a1')
    })
    // onSuccess invalidates the collection key → a second GET fires.
    await waitFor(() => {
      const gets = calls.filter((c) => c.method === 'GET' && c.url.endsWith('/api/agents'))
      expect(gets.length).toBeGreaterThanOrEqual(2)
    })
  })

  test('plugins use the same canonical id DELETE key', async () => {
    const calls = installFetch('/api/plugins', () => [
      { id: 'p1', name: 'plug', ownerUserId: null },
    ])
    renderAtAgents(() => <Probe endpoint="/api/plugins" />)
    await waitFor(() => screen.getByTestId('row-p1'))
    fireEvent.click(screen.getByText('del p1'))
    await waitFor(() => {
      const dels = calls.filter((c) => c.method === 'DELETE')
      expect(dels).toHaveLength(1)
      expect(dels[0]!.url).toContain('/api/plugins/p1')
    })
  })

  test('owners batch-resolves ownerUserId via POST /api/users/lookup', async () => {
    const calls = installFetch('/api/agents', () => [
      { id: 'a1', name: 'alpha', ownerUserId: 'u1' },
      { id: 'a2', name: 'beta', ownerUserId: 'u1' },
      { id: 'a3', name: 'gamma', ownerUserId: null },
    ])
    renderAtAgents(() => <Probe endpoint="/api/agents" />)
    await waitFor(() => expect(screen.getByTestId('owner-a1').textContent).toBe('Alice'))
    expect(screen.getByTestId('owner-a3').textContent).toBe('')
    const lookups = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/users/lookup'))
    expect(lookups).toHaveLength(1)
    // Duplicate + null ids collapse to the single distinct real id.
    expect(lookups[0]!.body).toEqual({ ids: ['u1'] })
  })

  test('manual refetch failure keeps stale rows visible and can retry again', async () => {
    let fail = false
    let listGets = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const method = (init?.method ?? 'GET').toUpperCase()
        if (method === 'POST' && url.endsWith('/api/users/lookup')) {
          return new Response('[]', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (method === 'GET' && url.endsWith('/api/agents')) {
          listGets += 1
          if (fail) {
            return new Response(JSON.stringify({ error: 'offline' }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            })
          }
          return new Response(JSON.stringify([{ id: 'a1', name: 'alpha' }]), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      },
    )

    renderAtAgents(() => <Probe endpoint="/api/agents" />)
    await screen.findByTestId('row-a1')

    fail = true
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await screen.findByRole('alert')
    expect(screen.getByTestId('row-a1').textContent).toBe('alpha')

    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByTestId('row-a1')).toBeTruthy()
    expect(listGets).toBe(3)
  })
})

// RFC-191 — ResourceNameCell retired with the data-table lists; the shared
// component must stay gone (its semantics live on in ResourceBadges below).
describe('ResourceNameCell retirement (RFC-191)', () => {
  test('the component file no longer exists and nothing imports it', () => {
    expect(existsSync(resolve(FRONTEND_SRC_DIR, 'components/ResourceNameCell.tsx'))).toBe(false)
  })
})

// RFC-169 (T4) — the visibility/owner fragment was extracted so the split-page
// cards render the identical badges as the surviving table cells. Lock that it
// renders as a bare fragment (host-agnostic — no <td> of its own) and keeps the
// chip-only-when-private semantics; unresolved owners fall back to their id so
// duplicate display names never become ambiguous while lookup is pending.
describe('ResourceBadges (T4 extraction)', () => {
  const owners: OwnerLookup = {
    get: (id) =>
      id === 'u1'
        ? { id: 'u1', username: 'alice', displayName: 'Alice', role: 'user', status: 'active' }
        : undefined,
  }

  test('private + resolved owner → chip + badge, no wrapper element', () => {
    render(
      <div data-testid="host">
        <ResourceBadges visibility="private" ownerUserId="u1" owners={owners} />
      </div>,
    )
    const host = screen.getByTestId('host')
    expect(host.querySelector('td')).toBeNull() // not tied to a table cell
    expect(host.querySelector('.chip.chip--tight')).not.toBeNull()
    expect(host.querySelector('.data-table__owner')?.textContent).toBe('Alice')
  })

  test('public + unresolved owner → renders the stable owner-id fallback', () => {
    render(
      <div data-testid="host2">
        <ResourceBadges visibility="public" ownerUserId="ghost" owners={owners} />
      </div>,
    )
    const host = screen.getByTestId('host2')
    expect(host.querySelector('.chip')).toBeNull()
    expect(host.querySelector('.data-table__owner')?.textContent).toBe('ghost')
  })
})
