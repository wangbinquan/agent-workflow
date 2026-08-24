import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { meQueryOptions, type MeResponse } from '../src/hooks/useActor'
import { usePrivilegedNodes } from '../src/hooks/usePrivilegedNodes'
import { setBaseUrl, setToken } from '../src/stores/auth'

const TOKEN = 'tok-privileged-settled'

function actor(permissions: MeResponse['permissions']): MeResponse {
  return {
    user: {
      id: 'u1',
      username: 'dev',
      displayName: 'Dev',
      role: 'user',
      status: 'active',
    },
    profile: {
      displayName: 'Dev',
      email: 'dev@example.test',
      gitCommitIdentity: { name: 'Dev', email: 'dev@example.test' },
    },
    source: 'session',
    permissions,
    linkedIdentities: [],
    pats: [],
  }
}

function Probe() {
  const grants = usePrivilegedNodes()
  return (
    <output data-testid="grants">
      {grants.canAuthorScripts && grants.canAuthorCodeHost ? 'yes' : 'no'}
    </output>
  )
}

beforeEach(() => {
  setBaseUrl('http://privileged-settled.test')
  setToken(TOKEN)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('cached privileged grants fail closed while /me is fetching and after retained-data error', async () => {
  let rejectRefresh!: (reason: unknown) => void
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    () =>
      new Promise<Response>((_resolve, reject) => {
        rejectRefresh = reject
      }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(
    meQueryOptions(TOKEN).queryKey,
    actor(['scripts:author', 'code-host-calls:author']),
  )
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('grants').textContent).toBe('yes'))

  let refresh!: Promise<void>
  act(() => {
    refresh = client.refetchQueries({ queryKey: meQueryOptions(TOKEN).queryKey })
  })
  await waitFor(() => expect(screen.getByTestId('grants').textContent).toBe('no'))
  await act(async () => {
    rejectRefresh(new Error('me refresh failed'))
    await refresh
  })
  expect(client.getQueryData(meQueryOptions(TOKEN).queryKey)).toEqual(
    actor(['scripts:author', 'code-host-calls:author']),
  )
  expect(screen.getByTestId('grants').textContent).toBe('no')

  vi.mocked(globalThis.fetch).mockResolvedValue(
    new Response(JSON.stringify(actor(['scripts:author', 'code-host-calls:author'])), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  await act(async () => {
    await client.refetchQueries({ queryKey: meQueryOptions(TOKEN).queryKey })
  })
  await waitFor(() => expect(screen.getByTestId('grants').textContent).toBe('yes'))
})

test('token and QueryClient identity switches never render grants from the previous cache', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}))
  const first = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const second = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  first.setQueryData(
    meQueryOptions(TOKEN).queryKey,
    actor(['scripts:author', 'code-host-calls:author']),
  )
  const view = render(
    <QueryClientProvider client={first}>
      <Probe />
    </QueryClientProvider>,
  )
  await waitFor(() => expect(screen.getByTestId('grants').textContent).toBe('yes'))

  act(() => setToken('tok-privileged-next'))
  expect(screen.getByTestId('grants').textContent).toBe('no')

  act(() => setToken(TOKEN))
  await waitFor(() => expect(screen.getByTestId('grants').textContent).toBe('yes'))
  view.rerender(
    <QueryClientProvider client={second}>
      <Probe />
    </QueryClientProvider>,
  )
  expect(screen.getByTestId('grants').textContent).toBe('no')
})
