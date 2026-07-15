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
  test('shared password and PAT fields keep labels, constraints, and request payloads', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(request.toString()).pathname
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
        calls.push({ path, method, body })
        if (method === 'POST' && path === '/api/auth/change-password') return json({})
        if (method === 'POST' && path === '/api/auth/pats') {
          return json({ token: 'pat-secret' })
        }
        if (path === '/api/auth/me') return json(actor)
        if (
          path === '/api/auth/pats' ||
          path === '/api/auth/sessions' ||
          path === '/api/auth/identities'
        ) {
          return json([])
        }
        throw new Error(`unexpected account request: ${method} ${path}`)
      },
    )
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    })
    qc.setQueryData(['auth', 'me', 'tok'], actor)
    qc.setQueryData(['pats'], [])
    qc.setQueryData(['sessions'], [])
    qc.setQueryData(['identities'], [])
    renderAccount(qc)

    const passwordSection = (
      await screen.findByRole('heading', {
        name: enUS.account.password,
      })
    ).closest('section')!
    const currentPassword = within(passwordSection).getByLabelText(
      /Current password/,
    ) as HTMLInputElement
    const newPassword = within(passwordSection).getByLabelText(/New password/) as HTMLInputElement
    expect(currentPassword.classList.contains('form-input')).toBe(true)
    expect(currentPassword.autocomplete).toBe('current-password')
    expect(currentPassword.required).toBe(true)
    expect(newPassword.classList.contains('form-input')).toBe(true)
    expect(newPassword.autocomplete).toBe('new-password')
    expect(newPassword.minLength).toBe(8)
    expect(newPassword.required).toBe(true)

    fireEvent.change(currentPassword, { target: { value: 'old-password' } })
    fireEvent.change(newPassword, { target: { value: 'new-password' } })
    fireEvent.click(within(passwordSection).getByRole('button', { name: enUS.account.update }))
    await waitFor(() => {
      expect(calls.some((call) => call.path === '/api/auth/change-password')).toBe(true)
    })
    expect(calls.find((call) => call.path === '/api/auth/change-password')?.body).toEqual({
      oldPassword: 'old-password',
      newPassword: 'new-password',
    })
    expect(await within(passwordSection).findByText(enUS.account.passwordChanged)).toBeTruthy()
    expect(currentPassword.value).toBe('')
    expect(newPassword.value).toBe('')

    const patSection = screen.getByRole('heading', { name: enUS.account.pats }).closest('section')!
    const patName = within(patSection).getByRole('textbox', {
      name: /Token name/,
    }) as HTMLInputElement
    const scopeCheckboxes = within(patSection).getAllByRole('checkbox') as HTMLInputElement[]
    expect(patName.classList.contains('form-input')).toBe(true)
    expect(patName.required).toBe(true)
    expect(scopeCheckboxes).toHaveLength(1)
    expect(scopeCheckboxes[0]?.checked).toBe(true)

    fireEvent.change(patName, { target: { value: 'ci-launcher' } })
    fireEvent.click(within(patSection).getByRole('button', { name: enUS.account.generate }))
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && call.path === '/api/auth/pats')).toBe(
        true,
      )
    })
    expect(
      calls.find((call) => call.method === 'POST' && call.path === '/api/auth/pats')?.body,
    ).toEqual({
      name: 'ci-launcher',
      scopes: ['account:self'],
    })
    expect((await within(patSection).findByTestId('new-pat-secret')).textContent).toContain(
      'pat-secret',
    )
  })

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
    for (const name of [
      enUS.account.profile,
      enUS.account.password,
      enUS.account.pats,
      enUS.account.linkedIdentities,
      enUS.account.sessions,
    ]) {
      const heading = screen.getByRole('heading', { level: 2, name })
      const section = heading.closest('section.card')
      expect(section).not.toBeNull()
      expect(heading.id).not.toBe('')
      expect(section?.getAttribute('aria-labelledby')).toBe(heading.id)
    }
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
