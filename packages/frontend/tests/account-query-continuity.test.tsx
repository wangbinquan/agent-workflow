// RFC-221 — route-backed account security center, typed actor ownership, and
// stale-data continuity.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { OwnCodeHostPushCredentialSummary } from '@agent-workflow/shared'
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
import { ACTOR_QUERY_KEY, type MeResponse } from '../src/hooks/useActor'
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
  profile: {
    displayName: 'Alice Chen',
    gitName: 'Alice Chen',
    email: 'alice@example.com',
    gitCommitIdentity: { name: 'Alice Chen', email: 'alice@example.com' },
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

const gitlabPushCredential = {
  provider: 'gitlab' as const,
  displayBaseUrl: 'https://gitlab.example.test',
  connectionGeneration: 'gitlab-generation',
  endpointBindingDigest: 'a'.repeat(64),
  configured: false,
  tokenHint: null,
  updatedAt: null,
  stale: false,
  fallback: 'platform-global' as const,
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

  test('code commit and push tab owns the Git identity card and refreshes the actor cache', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(request.toString()).pathname
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        calls.push({ method, path, body })
        if (path === '/api/auth/me' && method === 'GET') return json(actor)
        if (path === '/api/account/code-host-push-credentials' && method === 'GET') {
          return json({ items: [gitlabPushCredential] })
        }
        if (path === '/api/auth/me/profile' && method === 'PATCH') {
          return json({
            profile: {
              displayName: 'Alice Updated',
              gitName: 'A. Updated',
              email: 'alice.updated@example.test',
              gitCommitIdentity: {
                name: 'A. Updated',
                email: 'alice.updated@example.test',
              },
            },
          })
        }
        throw new Error(`unexpected account request: ${method} ${path}`)
      },
    )
    const qc = queryClient()
    qc.setQueryData([...ACTOR_QUERY_KEY, 'stale-auth-generation'], actor)
    renderAccount(qc, '/account?section=codePush')

    expect(
      await screen.findByRole('heading', { level: 2, name: enUS.account.sections.codePush }),
    ).toBeTruthy()
    const identityCard = screen.getByTestId('account-git-identity-card')
    const credentialCard = await screen.findByTestId('account-code-push-card-gitlab')
    expect(identityCard.classList.contains('settings-card')).toBe(true)
    expect(credentialCard.classList.contains('settings-card')).toBe(true)
    expect(identityCard.querySelector('form')?.classList.contains('account-code-push-form')).toBe(
      true,
    )
    expect(credentialCard.querySelector('form')?.classList.contains('account-code-push-form')).toBe(
      true,
    )
    expect(within(credentialCard).getByText(enUS.account.codePush.priorityTitle)).toBeTruthy()
    expect(within(credentialCard).getByText(enUS.account.codePush.priorityDescription)).toBeTruthy()

    const name = (await screen.findByRole('textbox', {
      name: new RegExp(enUS.account.displayName),
    })) as HTMLInputElement
    const email = screen.getByRole('textbox', {
      name: new RegExp(enUS.account.email),
    }) as HTMLInputElement
    const gitName = screen.getByRole('textbox', {
      name: new RegExp(enUS.account.gitName),
    }) as HTMLInputElement
    expect(name.value).toBe('Alice Chen')
    expect(gitName.value).toBe('Alice Chen')
    expect(email.value).toBe('alice@example.com')
    fireEvent.change(name, { target: { value: ' Alice Updated ' } })
    fireEvent.change(gitName, { target: { value: ' A. Updated ' } })
    fireEvent.change(email, { target: { value: 'ALICE.UPDATED@EXAMPLE.TEST' } })
    fireEvent.click(screen.getByRole('button', { name: enUS.account.saveProfile }))

    expect(await screen.findByText(enUS.account.profileSaved)).toBeTruthy()
    expect(name.value).toBe('Alice Updated')
    expect(gitName.value).toBe('A. Updated')
    expect(email.value).toBe('alice.updated@example.test')
    expect(calls.find((call) => call.path === '/api/auth/me/profile')).toEqual({
      method: 'PATCH',
      path: '/api/auth/me/profile',
      body: {
        displayName: 'Alice Updated',
        gitName: 'A. Updated',
        email: 'alice.updated@example.test',
      },
    })
    expect(qc.getQueryData<MeResponse>([...ACTOR_QUERY_KEY, 'tok'])?.profile).toEqual({
      displayName: 'Alice Updated',
      gitName: 'A. Updated',
      email: 'alice.updated@example.test',
      gitCommitIdentity: {
        name: 'A. Updated',
        email: 'alice.updated@example.test',
      },
    })
    expect(
      qc.getQueryData<MeResponse>([...ACTOR_QUERY_KEY, 'stale-auth-generation'])?.profile,
    ).toEqual(actor.profile)
  })

  test('personal push credential is write-only, replaces platform fallback, and deletes through confirmation', async () => {
    let current: OwnCodeHostPushCredentialSummary = gitlabPushCredential
    const calls: Array<{ method: string; path: string; body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(request.toString()).pathname
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        calls.push({ method, path, body })
        if (path === '/api/auth/me' && method === 'GET') return json(actor)
        if (path === '/api/account/code-host-push-credentials' && method === 'GET') {
          return json({ items: [current] })
        }
        if (path === '/api/account/code-host-push-credentials/gitlab/test' && method === 'POST') {
          const candidate = (body as { token?: string } | undefined)?.token
          return candidate?.includes('invalid') === true
            ? json({ ok: false, at: 1_700_000_000_000, code: 'unauthorized', message: 'HTTP 401' })
            : json({ ok: true, at: 1_700_000_000_000, login: 'alice-code-host' })
        }
        if (path === '/api/account/code-host-push-credentials/gitlab' && method === 'PUT') {
          current = {
            ...gitlabPushCredential,
            configured: true,
            tokenHint: '7890',
            updatedAt: 1_700_000_000_000,
          }
          return json(current)
        }
        if (path === '/api/account/code-host-push-credentials/gitlab' && method === 'DELETE') {
          current = gitlabPushCredential
          return json({ removed: true })
        }
        throw new Error(`unexpected account request: ${method} ${path}`)
      },
    )
    renderAccount(queryClient(), '/account?section=codePush')

    const token = (await screen.findByTestId('account-code-push-token-gitlab')) as HTMLInputElement
    expect(token.type).toBe('password')
    expect(token.value).toBe('')
    expect(screen.getByTestId('account-code-push-status-gitlab').textContent).toContain(
      enUS.account.codePush.platformFallback,
    )

    fireEvent.change(token, { target: { value: 'personal-token-7890' } })
    fireEvent.click(screen.getByTestId('account-code-push-test-gitlab'))
    expect(await screen.findByText('Token is valid. Code-host user: alice-code-host')).toBeTruthy()
    expect(calls.find((call) => call.method === 'POST')).toEqual({
      method: 'POST',
      path: '/api/account/code-host-push-credentials/gitlab/test',
      body: {
        token: 'personal-token-7890',
        connectionGeneration: 'gitlab-generation',
        endpointBindingDigest: 'a'.repeat(64),
      },
    })
    fireEvent.click(screen.getByTestId('account-code-push-save-gitlab'))
    expect(await screen.findByText(enUS.account.codePush.saved)).toBeTruthy()
    expect(token.value).toBe('')
    expect(calls.find((call) => call.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/api/account/code-host-push-credentials/gitlab',
      body: {
        token: 'personal-token-7890',
        connectionGeneration: 'gitlab-generation',
        endpointBindingDigest: 'a'.repeat(64),
      },
    })
    expect(await screen.findByText(/7890/)).toBeTruthy()

    fireEvent.click(screen.getByTestId('account-code-push-test-gitlab'))
    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2)
    })
    expect(calls.filter((call) => call.method === 'POST')[1]).toEqual({
      method: 'POST',
      path: '/api/account/code-host-push-credentials/gitlab/test',
      body: {
        connectionGeneration: 'gitlab-generation',
        endpointBindingDigest: 'a'.repeat(64),
      },
    })

    fireEvent.change(token, { target: { value: 'personal-invalid-token' } })
    fireEvent.click(screen.getByTestId('account-code-push-test-gitlab'))
    expect(
      await screen.findByText(
        'Token validation failed: The token is invalid or lacks the required scope',
      ),
    ).toBeTruthy()

    fireEvent.click(screen.getByTestId('account-code-push-remove-gitlab'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: enUS.account.codePush.remove }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(calls).toContainEqual({
      method: 'DELETE',
      path: '/api/account/code-host-push-credentials/gitlab',
      body: undefined,
    })
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

  // RFC-247 D1 supersedes RFC-221's retirement-only state: this test used to
  // assert the "生成已关闭" banner and the ABSENCE of any creation control.
  // Issuing is available again (the catalog can now express a narrow token), so
  // what still needs locking is that revoke keeps working and stays behind a
  // confirmation — the half that was never about the catalog.
  test('PATs revoke through confirmation, alongside an available creation control', async () => {
    const pat = {
      id: 'pat-1',
      name: 'legacy-ci',
      scopes: ['account:self'] as const,
      purpose: 'general' as const,
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
    expect(screen.getByRole('button', { name: enUS.account.token.create })).toBeTruthy()
    // The creation form is behind the dialog, not inline on the panel.
    expect(screen.queryByRole('textbox')).toBeNull()

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
