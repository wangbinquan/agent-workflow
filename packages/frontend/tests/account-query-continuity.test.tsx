// RFC-221 — route-backed account security center, typed actor ownership, and
// stale-data continuity.

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
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'
import type { MeResponse } from '../src/hooks/useActor'
import { Route as AccountRoute } from '../src/routes/account'
import { clearToken, getToken, setBaseUrl, setToken } from '../src/stores/auth'

const actor: MeResponse = {
  user: {
    id: 'u1',
    username: 'alice',
    displayName: 'Alice Chen',
    role: 'user',
    status: 'active',
  },
  source: 'session',
  permissions: ['account:self'],
  linkedIdentities: [],
  pats: [],
}

const oidcActor: MeResponse = {
  ...actor,
  linkedIdentities: [
    {
      id: 'identity-1',
      userId: 'u1',
      providerId: 'provider-1',
      providerSlug: 'corp',
      providerDisplayName: 'Corporate SSO',
      subject: '00u-long-technical-subject',
      email: 'alice@example.com',
      emailVerified: true,
      linkedAt: 1_700_000_000_000,
    },
  ],
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderAccount(qc: QueryClient, initialEntry = '/account') {
  const root = createRootRoute({ component: () => <Outlet /> })
  const account = createRoute({
    getParentRoute: () => root,
    path: '/account',
    validateSearch: AccountRoute.options.validateSearch,
    component: AccountRoute.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([account]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const view = render(
    <QueryClientProvider client={qc}>
      {/* Test route types intentionally differ from the generated app tree. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { ...view, router }
}

beforeEach(async () => {
  clearToken()
  setBaseUrl('http://daemon.test')
  setToken('tok')
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('/account security center', () => {
  test('overview owns linked identities through /me and exposes no unlink action', async () => {
    const paths: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
      const path = new URL(request.toString()).pathname
      paths.push(path)
      if (path === '/api/auth/me') return json(oidcActor)
      throw new Error(`unexpected account request: ${path}`)
    })
    renderAccount(queryClient())

    expect(
      await screen.findByRole('heading', { level: 2, name: enUS.account.sections.overview }),
    ).toBeTruthy()
    expect(screen.getByText('Alice Chen')).toBeTruthy()
    expect(screen.getByText('Corporate SSO')).toBeTruthy()
    expect(screen.getAllByText(enUS.account.oidcManaged)).toHaveLength(2)
    expect(screen.queryByRole('button', { name: enUS.account.unlink })).toBeNull()
    expect(paths).toEqual(['/api/auth/me'])

    fireEvent.click(screen.getByText(enUS.account.technicalIdentity))
    expect(screen.getByText('00u-long-technical-subject')).toBeTruthy()
  })

  test('local password change installs the fresh session token before invalidation', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(request.toString()).pathname
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        calls.push({ path, method, body })
        if (path === '/api/auth/me') return json(actor)
        if (path === '/api/auth/sessions') return json([])
        if (path === '/api/auth/change-password') {
          return json({ ok: true, sessionToken: 'fresh-session-token' })
        }
        throw new Error(`unexpected account request: ${method} ${path}`)
      },
    )
    renderAccount(queryClient(), '/account?section=security')

    const current = (await screen.findByLabelText(/Current password/i)) as HTMLInputElement
    const next = screen.getByLabelText(/New password/i) as HTMLInputElement
    expect(current.autocomplete).toBe('current-password')
    expect(next.autocomplete).toBe('new-password')
    expect(next.minLength).toBe(8)

    fireEvent.change(current, { target: { value: 'old-password' } })
    fireEvent.change(next, { target: { value: 'new-password' } })
    fireEvent.click(screen.getByRole('button', { name: enUS.account.update }))

    expect(await screen.findByText(enUS.account.passwordChanged)).toBeTruthy()
    expect(getToken()).toBe('fresh-session-token')
    expect(calls.find((call) => call.path === '/api/auth/change-password')?.body).toEqual({
      oldPassword: 'old-password',
      newPassword: 'new-password',
    })
    expect(current.value).toBe('')
    expect(next.value).toBe('')
  })

  test('OIDC-managed security omits the password form but keeps sessions available', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
      const path = new URL(request.toString()).pathname
      if (path === '/api/auth/me') return json(oidcActor)
      if (path === '/api/auth/sessions') return json([])
      throw new Error(`unexpected account request: ${path}`)
    })
    renderAccount(queryClient(), '/account?section=security')

    expect(await screen.findByText(enUS.account.oidcPasswordTitle)).toBeTruthy()
    expect(screen.queryByLabelText(/Current password/i)).toBeNull()
    expect(screen.queryByLabelText(/New password/i)).toBeNull()
    expect(screen.getByRole('heading', { name: enUS.account.sessions })).toBeTruthy()
  })

  test('existing PATs are retirement-only and revoke through confirmation', async () => {
    const pat = {
      id: 'pat-1',
      name: 'legacy-ci',
      scopes: ['account:self'] as const,
      createdAt: 1_700_000_000_000,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    }
    let revoked = false
    const calls: Array<{ path: string; method: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(request.toString()).pathname
        const method = init?.method ?? 'GET'
        calls.push({ path, method })
        if (path === '/api/auth/me') {
          return json({
            ...actor,
            pats: [{ ...pat, scopes: [...pat.scopes], revokedAt: revoked ? Date.now() : null }],
          })
        }
        if (path === '/api/auth/pats/pat-1' && method === 'DELETE') {
          revoked = true
          return new Response(null, { status: 204 })
        }
        throw new Error(`unexpected account request: ${method} ${path}`)
      },
    )
    renderAccount(queryClient(), '/account?section=tokens')

    expect(await screen.findByText('legacy-ci')).toBeTruthy()
    expect(screen.getByText(enUS.account.tokensRetiredTitle)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: enUS.account.generate })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: enUS.account.revoke }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: enUS.account.revoke }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls).toContainEqual({ path: '/api/auth/pats/pat-1', method: 'DELETE' })
    expect(await screen.findByText(enUS.account.patStatusRevoked)).toBeTruthy()
  })

  test('initial error retries, while a stale actor error preserves the active panel', async () => {
    let requests = 0
    let failRefresh = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request: RequestInfo | URL) => {
      const path = new URL(request.toString()).pathname
      if (path !== '/api/auth/me') throw new Error(`unexpected account request: ${path}`)
      requests += 1
      if (requests === 1 || failRefresh) {
        return json({ code: 'actor-unavailable', message: 'Actor lookup failed' }, 503)
      }
      return json(actor)
    })
    const qc = queryClient()
    renderAccount(qc)

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: enUS.account.sections.overview })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(
      await screen.findByRole('heading', { name: enUS.account.sections.overview }),
    ).toBeTruthy()

    failRefresh = true
    await act(async () => {
      await qc.refetchQueries({ queryKey: ['auth', 'me', 'tok'], exact: true })
    })
    expect((await screen.findByRole('alert')).textContent).toContain('Actor lookup failed')
    expect(screen.getByRole('heading', { name: enUS.account.sections.overview })).toBeTruthy()
  })
})
