// RFC-198 PR4 — cached empty account sections must not swallow a background
// refetch failure. Sessions and identities keep their truthful empty content,
// add an inline retry, and recover in place instead of looking like a clean
// successful response.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MeResponse } from '../src/hooks/useActor'
import { Route as AccountRoute } from '../src/routes/account'
import { enUS } from '../src/i18n/en-US'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

const actor: MeResponse = {
  user: {
    id: 'u1',
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
    status: 'active',
  },
  source: 'session',
  permissions: ['account:self'],
  linkedIdentities: [],
  pats: [],
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderAccount(qc: QueryClient) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const account = createRoute({
    getParentRoute: () => root,
    path: '/account',
    component: AccountRoute.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([account]),
    history: createMemoryHistory({ initialEntries: ['/account'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      {/* Test route types intentionally differ from the generated app tree. */}
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
  cleanup()
  vi.restoreAllMocks()
})

describe('/account cached-empty query continuity', () => {
  test('top-level actor query shows initial loading and initial error with a working retry', async () => {
    let finishFirstActorRequest: ((response: Response) => void) | undefined
    let actorRequests = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
      const path = new URL(request.toString()).pathname
      if (path === '/api/auth/me') {
        actorRequests += 1
        if (actorRequests === 1) {
          return new Promise<Response>((resolve) => {
            finishFirstActorRequest = resolve
          })
        }
        return json(actor)
      }
      if (
        path === '/api/auth/pats' ||
        path === '/api/auth/sessions' ||
        path === '/api/auth/identities'
      ) {
        return json([])
      }
      throw new Error(`unexpected account request: ${path}`)
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderAccount(qc)

    expect(await screen.findByRole('heading', { level: 1, name: enUS.account.title })).toBeTruthy()
    expect(screen.getByTestId('loading-state')).toBeTruthy()

    await waitFor(() => expect(finishFirstActorRequest).toBeTypeOf('function'))
    await act(async () => {
      finishFirstActorRequest!(
        json({ code: 'actor-unavailable', message: 'Actor lookup failed' }, 503),
      )
    })
    expect((await screen.findByRole('alert')).textContent).toContain('Actor lookup failed')
    expect(screen.queryByRole('heading', { name: enUS.account.profile })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /retry|重试/i }))
    expect(await screen.findByRole('heading', { name: enUS.account.profile })).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(actorRequests).toBe(2)
  })

  test('top-level stale actor error preserves the account sections and retries in place', async () => {
    let failActorRefresh = true
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
      const path = new URL(request.toString()).pathname
      if (path === '/api/auth/me') {
        return failActorRefresh
          ? json({ code: 'actor-refresh-failed', message: 'Actor refresh failed' }, 503)
          : json(actor)
      }
      if (
        path === '/api/auth/pats' ||
        path === '/api/auth/sessions' ||
        path === '/api/auth/identities'
      ) {
        return json([])
      }
      throw new Error(`unexpected account request: ${path}`)
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    })
    qc.setQueryData(['auth', 'me', 'tok'], actor)
    qc.setQueryData(['pats'], [])
    qc.setQueryData(['sessions'], [])
    qc.setQueryData(['identities'], [])
    renderAccount(qc)

    expect(await screen.findByRole('heading', { name: enUS.account.profile })).toBeTruthy()
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['auth', 'me', 'tok'], exact: true })
    })
    expect((await screen.findByRole('alert')).textContent).toContain('Actor refresh failed')
    expect(screen.getByRole('heading', { name: enUS.account.profile })).toBeTruthy()
    expect(screen.getByText('alice')).toBeTruthy()

    failActorRefresh = false
    fireEvent.click(screen.getByRole('button', { name: /retry|重试/i }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByRole('heading', { name: enUS.account.profile })).toBeTruthy()
  })

  test('sessions and identities show stale errors with retry, then recover in place', async () => {
    let fail = true
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
      const path = new URL(request.toString()).pathname
      if (path === '/api/auth/sessions' || path === '/api/auth/identities') {
        return fail
          ? json({ code: 'account-refresh-failed', message: `${path} refresh failed` }, 503)
          : json([])
      }
      if (path === '/api/auth/pats') return json([])
      throw new Error(`unexpected account request: ${path}`)
    })
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    })
    qc.setQueryData(['auth', 'me', 'tok'], actor)
    qc.setQueryData(['pats'], [])
    qc.setQueryData(['sessions'], [])
    qc.setQueryData(['identities'], [])
    renderAccount(qc)

    const sessions = (await screen.findByRole('heading', { name: enUS.account.sessions })).closest(
      'section',
    )!
    const identities = screen
      .getByRole('heading', { name: enUS.account.linkedIdentities })
      .closest('section')!
    expect(within(sessions).getByText(enUS.account.noSessions)).toBeTruthy()
    expect(within(identities).getByText(enUS.account.noIdentities)).toBeTruthy()

    await qc.refetchQueries({ queryKey: ['sessions'], exact: true })
    await qc.refetchQueries({ queryKey: ['identities'], exact: true })
    expect(await within(sessions).findByRole('alert')).toBeTruthy()
    expect(await within(identities).findByRole('alert')).toBeTruthy()
    expect(within(sessions).getByText(enUS.account.noSessions)).toBeTruthy()
    expect(within(identities).getByText(enUS.account.noIdentities)).toBeTruthy()

    fail = false
    fireEvent.click(within(sessions).getByRole('button', { name: /retry|重试/i }))
    fireEvent.click(within(identities).getByRole('button', { name: /retry|重试/i }))
    await waitFor(() => {
      expect(within(sessions).queryByRole('alert')).toBeNull()
      expect(within(identities).queryByRole('alert')).toBeNull()
    })
    expect(within(sessions).getByText(enUS.account.noSessions)).toBeTruthy()
    expect(within(identities).getByText(enUS.account.noIdentities)).toBeTruthy()
  })
})
