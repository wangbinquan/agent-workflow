// RFC-151 PR-3 — list-shell primitives contract.
//
// The five resource list pages (agents/skills/mcps/plugins/workflows) share
// `useResourceList` (query + delete mutation + RFC-099 owner lookup) and —
// /skills excepted — `<ResourceNameCell>` (nowrap name cell: detail link +
// private chip + owner badge). Page-level render locks keep covering the
// pages; this file locks the primitives' own behavior:
//   1. useResourceList fetches `GET {endpoint}` under the given key.
//   2. del.mutateAsync(row) DELETEs by the configured field ('name' | 'id')
//      and invalidates the list on success.
//   3. owners resolves ownerUserId → displayName via POST /api/users/lookup.
//   4. ResourceNameCell renders link/private-chip/owner-badge structurally
//      like the pre-extraction page cells (chip only when private, badge only
//      when the lookup resolves), plus the optional link title.

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
import { ResourceNameCell, type OwnerLookup } from '../src/components/ResourceNameCell'
import { ResourceBadges } from '../src/components/ResourceBadges'
import '../src/i18n'

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
    path: '/agents/$name',
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
  function Probe(props: { deleteBy: 'name' | 'id'; endpoint: string }) {
    const { data, isLoading, error, del, owners } = useResourceList<Row>({
      queryKey: ['rl-test', props.endpoint, props.deleteBy],
      endpoint: props.endpoint,
      deleteBy: props.deleteBy,
    })
    if (isLoading) return <p>loading…</p>
    if (error !== null && error !== undefined) return <p>failed</p>
    return (
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
    )
  }

  test('fetches GET {endpoint}, deletes by name, and invalidates the list', async () => {
    const calls = installFetch('/api/agents', () => [
      { id: 'a1', name: 'alpha needs/escape', ownerUserId: 'u1' },
      { id: 'a2', name: 'beta', ownerUserId: null },
    ])
    renderAtAgents(() => <Probe deleteBy="name" endpoint="/api/agents" />)
    await waitFor(() => screen.getByTestId('row-a1'))
    expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/api/agents'))).toBe(true)

    fireEvent.click(screen.getByText('del a1'))
    await waitFor(() => {
      const dels = calls.filter((c) => c.method === 'DELETE')
      expect(dels).toHaveLength(1)
      // deleteBy:'name' → the row's name (URL-encoded), not its id.
      expect(dels[0]!.url).toContain(`/api/agents/${encodeURIComponent('alpha needs/escape')}`)
    })
    // onSuccess invalidates the collection key → a second GET fires.
    await waitFor(() => {
      const gets = calls.filter((c) => c.method === 'GET' && c.url.endsWith('/api/agents'))
      expect(gets.length).toBeGreaterThanOrEqual(2)
    })
  })

  test('deleteBy id switches the DELETE URL key', async () => {
    const calls = installFetch('/api/plugins', () => [
      { id: 'p1', name: 'plug', ownerUserId: null },
    ])
    renderAtAgents(() => <Probe deleteBy="id" endpoint="/api/plugins" />)
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
    renderAtAgents(() => <Probe deleteBy="name" endpoint="/api/agents" />)
    await waitFor(() => expect(screen.getByTestId('owner-a1').textContent).toBe('Alice'))
    expect(screen.getByTestId('owner-a3').textContent).toBe('')
    const lookups = calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/users/lookup'))
    expect(lookups).toHaveLength(1)
    // Duplicate + null ids collapse to the single distinct real id.
    expect(lookups[0]!.body).toEqual({ ids: ['u1'] })
  })
})

describe('ResourceNameCell', () => {
  const owners: OwnerLookup = {
    get: (id) =>
      id === 'u1'
        ? { id: 'u1', username: 'alice', displayName: 'Alice', role: 'user', status: 'active' }
        : undefined,
  }

  function Cells() {
    return (
      <table>
        <tbody>
          <tr data-testid="row-private">
            <ResourceNameCell
              to="/agents/$name"
              params={{ name: 'secret-agent' }}
              name="secret-agent"
              visibility="private"
              ownerUserId="u1"
              owners={owners}
              title="secret-agent full name"
            />
          </tr>
          <tr data-testid="row-public">
            <ResourceNameCell
              to="/agents/$name"
              params={{ name: 'open-agent' }}
              name="open-agent"
              visibility="public"
              ownerUserId="u-unknown"
              owners={owners}
            />
          </tr>
        </tbody>
      </table>
    )
  }

  test('renders nowrap cell with link, private chip and resolved owner badge', async () => {
    installFetch('/api/agents', () => [])
    renderAtAgents(Cells)
    const privateRow = await waitFor(() => screen.getByTestId('row-private'))

    const cell = privateRow.querySelector('td')
    expect(cell?.className).toBe('data-table__nowrap')
    const link = privateRow.querySelector('a.data-table__link')
    expect(link?.textContent).toBe('secret-agent')
    expect(link?.getAttribute('href')).toContain('/agents/secret-agent')
    expect(link?.getAttribute('title')).toBe('secret-agent full name')
    expect(privateRow.querySelector('.chip.chip--tight')).not.toBeNull()
    const badge = privateRow.querySelector('.data-table__owner')
    expect(badge?.textContent).toBe('Alice')
  })

  test('public row without resolvable owner renders neither chip nor badge', async () => {
    installFetch('/api/agents', () => [])
    renderAtAgents(Cells)
    const publicRow = await waitFor(() => screen.getByTestId('row-public'))
    expect(publicRow.querySelector('.chip')).toBeNull()
    // ownerUserId set but unresolved (deleted user) → badge suppressed, same
    // as the historical page cells.
    expect(publicRow.querySelector('.data-table__owner')).toBeNull()
    expect(publicRow.querySelector('a')?.getAttribute('title')).toBeNull()
  })
})

// RFC-169 (T4) — the visibility/owner fragment was extracted so the split-page
// cards render the identical badges as the surviving table cells. Lock that it
// renders as a bare fragment (host-agnostic — no <td> of its own) and keeps the
// chip-only-when-private / badge-only-when-resolved semantics.
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

  test('public + unresolved owner → renders nothing', () => {
    render(
      <div data-testid="host2">
        <ResourceBadges visibility="public" ownerUserId="ghost" owners={owners} />
      </div>,
    )
    const host = screen.getByTestId('host2')
    expect(host.querySelector('.chip')).toBeNull()
    expect(host.querySelector('.data-table__owner')).toBeNull()
  })
})
