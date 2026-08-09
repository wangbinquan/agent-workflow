// Global authorization hooks must not trust React Query's retained successful
// /me payload after a background refetch error.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  ACTOR_QUERY_KEY,
  isAdminAtRequest,
  meQueryOptions,
  hasPermissionAtRequest,
  useIsAdmin,
  usePermission,
} from '../src/hooks/useActor'
import { setBaseUrl, setToken } from '../src/stores/auth'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function Probe() {
  const canCreate = usePermission('repos:create')
  const isAdmin = useIsAdmin()
  return (
    <>
      <output data-testid="permission">{canCreate ? 'yes' : 'no'}</output>
      <output data-testid="admin">{isAdmin ? 'yes' : 'no'}</output>
    </>
  )
}

beforeEach(() => {
  setBaseUrl('http://permission-fail-closed.test')
  setToken('tok-permission-fail-closed')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('cached write/admin capability fails closed when /me refetch errors', async () => {
  const actor = {
    user: {
      id: 'u-admin',
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
    permissions: ['repos:create'],
    linkedIdentities: [],
    pats: [],
  }
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(json(actor))
    .mockResolvedValueOnce(json({ code: 'me-unavailable', message: 'temporary failure' }, 503))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )

  await waitFor(() => expect(screen.getByTestId('permission').textContent).toBe('yes'))
  expect(screen.getByTestId('admin').textContent).toBe('yes')

  await act(async () => {
    await client.refetchQueries({ queryKey: ACTOR_QUERY_KEY })
  })
  await waitFor(() => expect(screen.getByTestId('permission').textContent).toBe('no'))
  expect(screen.getByTestId('admin').textContent).toBe('no')

  // Prove the denial came from query state, not data eviction.
  const retained = client.getQueriesData({ queryKey: ACTOR_QUERY_KEY })[0]?.[1]
  expect(retained).toEqual(actor)
})

test('cached capability fails closed for the entire background-refetch window', async () => {
  const actor = {
    user: {
      id: 'u-admin',
      username: 'admin',
      displayName: 'Admin',
      role: 'admin',
      status: 'active',
    },
    source: 'session',
    permissions: ['repos:create'],
    linkedIdentities: [],
    pats: [],
  }
  let resolveRefresh!: (response: Response) => void
  const refresh = new Promise<Response>((resolve) => {
    resolveRefresh = resolve
  })
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(actor)).mockReturnValueOnce(refresh)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('permission').textContent).toBe('yes'))

  let refetch!: Promise<void>
  act(() => {
    refetch = client.refetchQueries({ queryKey: ACTOR_QUERY_KEY })
  })
  await waitFor(() =>
    expect(
      client.getQueryState(meQueryOptions('tok-permission-fail-closed').queryKey)?.fetchStatus,
    ).toBe('fetching'),
  )
  expect(screen.getByTestId('permission').textContent).toBe('no')
  expect(screen.getByTestId('admin').textContent).toBe('no')
  expect(hasPermissionAtRequest(client, 'repos:create')).toBe(false)
  expect(isAdminAtRequest(client)).toBe(false)

  await act(async () => {
    resolveRefresh(json(actor))
    await refetch
  })
  await waitFor(() => expect(screen.getByTestId('permission').textContent).toBe('yes'))
  expect(screen.getByTestId('admin').textContent).toBe('yes')
})

test('malformed retained actor payload cannot throw or grant admin', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ permissions: ['repos:create'] }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('permission').textContent).toBe('yes'))
  expect(screen.getByTestId('admin').textContent).toBe('no')
  expect(isAdminAtRequest(client)).toBe(false)
})
