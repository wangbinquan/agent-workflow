// RFC-220 T4 — provider dialog: manual endpoints + identity knobs + ProbeResult
// display (design §8, locks §12 S10).
//
// The wire-shape locks that matter:
//   - '' in a form input ⇔ null on the wire (z.string().url() rejects empty
//     strings by design, so a blank field must never be sent as '').
//   - edit回填 comes from the row's nullable fields without crashing on
//     legacy rows that lack them.
//   - /test renders the always-200 ProbeResult: readiness verdict, per-field
//     source markers, and the unreachable-JWKS warning.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { Window as HappyWindow } from 'happy-dom'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
      put: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  }
})

vi.mock('@/components/RuntimeList', () => ({
  RuntimeList: () => <div data-testid="runtime-list-stub" />,
}))

import { api } from '../src/api/client'
import i18n from '../src/i18n'
import { getConfigQueryKey } from '../src/lib/config-resource'
import { Route as SettingsRoute, validateSettingsSearch } from '../src/routes/settings'
import { clearToken, setToken } from '../src/stores/auth'

const FULL_ROW = {
  id: 'p1',
  slug: 'pure',
  displayName: 'Pure OAuth IdP',
  issuerUrl: 'https://idp.example.test',
  clientId: 'client-1',
  scopes: 'read:user',
  provisioning: 'auto' as const,
  allowedEmailDomains: [],
  iconUrl: null,
  enabled: true,
  authorizationEndpoint: 'https://idp.example.test/oauth/authorize',
  tokenEndpoint: 'https://idp.example.test/oauth/token',
  userinfoEndpoint: 'https://idp.example.test/api/user',
  userinfoRequestStyle: 'post_json' as const,
  jwksUri: null,
  trustEmailVerified: true,
  usernameClaim: 'login sig',
  emailClaim: 'mail',
  subjectClaim: 'id',
  createdAt: 1,
  updatedAt: 1,
}

function renderAuthentication(
  rows: Array<Record<string, unknown>>,
  options: {
    history?: ReturnType<typeof createMemoryHistory> | ReturnType<typeof createBrowserHistory>
    initialEntries?: string[]
  } = {},
) {
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/auth/me') {
      return Promise.resolve({
        user: {
          id: 'oidc-configurer',
          username: 'oidc-configurer',
          displayName: 'OIDC configurer',
          role: 'user',
          status: 'active',
        },
        source: 'session',
        permissions: ['settings:read', 'oidc:read', 'oidc:configure'],
        linkedIdentities: [],
        pats: [],
      })
    }
    if (url === '/api/oidc/providers') return Promise.resolve(rows.slice())
    if (url === '/api/oidc/login-policy') {
      return Promise.resolve({
        passwordLoginEnabled: true,
        oidcDefaultRole: 'guest',
        bootstrapCompletedAt: 1,
        updatedAt: 1,
      })
    }
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData(getConfigQueryKey(), DEFAULT_CONFIG)
  const root = createRootRoute({ component: () => <Outlet /> })
  const settings = createRoute({
    getParentRoute: () => root,
    path: '/settings',
    validateSearch: validateSettingsSearch,
    component: SettingsRoute.options.component,
  })
  const other = createRoute({
    getParentRoute: () => root,
    path: '/other',
    component: () => <div data-testid="other-page">other</div>,
  })
  const history =
    options.history ??
    createMemoryHistory({
      initialEntries: options.initialEntries ?? ['/settings?tab=authentication'],
    })
  const router = createRouter({
    routeTree: root.addChildren([settings, other]),
    history,
  })
  render(
    <QueryClientProvider client={client}>
      {/* The focused harness intentionally clones the production route id. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { history, router }
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setToken('oidc-provider-configurer')
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.put as ReturnType<typeof vi.fn>).mockReset()
  ;(api.post as ReturnType<typeof vi.fn>).mockReset()
  ;(api.patch as ReturnType<typeof vi.fn>).mockReset()
  ;(api.delete as ReturnType<typeof vi.fn>).mockReset()
})

afterEach(() => {
  clearToken()
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-220 S10 — provider dialog fields', () => {
  test('create: blanks go out as null, filled endpoint fields as trimmed strings', async () => {
    renderAuthentication([])
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({})
    fireEvent.click(await screen.findByTestId('oidc-add-provider'))
    await screen.findByRole('dialog')

    fireEvent.change(screen.getByPlaceholderText('github-enterprise'), {
      target: { value: 'pure' },
    })
    fireEvent.change(screen.getByPlaceholderText('GitHub Enterprise'), {
      target: { value: 'Pure OAuth' },
    })
    fireEvent.change(screen.getByPlaceholderText('https://github.corp.com'), {
      target: { value: 'https://idp.example.test' },
    })
    const [clientIdInput] = screen
      .getAllByRole('textbox')
      .filter((el) => (el as HTMLInputElement).required && (el as HTMLInputElement).value === '')
    fireEvent.change(clientIdInput!, { target: { value: 'client-1' } })
    fireEvent.change(document.querySelector('input[type="password"]')!, {
      target: { value: 'secret-1' },
    })
    fireEvent.change(screen.getByPlaceholderText('https://idp.corp.com/oauth/token'), {
      target: { value: '  https://idp.example.test/oauth/token  ' },
    })
    fireEvent.change(screen.getByPlaceholderText('sub'), { target: { value: 'id' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    const body = (api.post as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>
    expect(body.tokenEndpoint).toBe('https://idp.example.test/oauth/token') // trimmed
    expect(body.authorizationEndpoint).toBeNull() // blank ⇔ null, never ''
    expect(body.userinfoEndpoint).toBeNull()
    expect(body.jwksUri).toBeNull()
    expect(body.usernameClaim).toBeNull()
    expect(body.emailClaim).toBeNull()
    expect(body.subjectClaim).toBe('id')
    expect(body.trustEmailVerified).toBe(false)
    expect(body.userinfoRequestStyle).toBe('get_bearer') // untouched default
  })

  test('D8: userinfo request style segmented — default, switch, and edit回填', async () => {
    renderAuthentication([])
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({})
    fireEvent.click(await screen.findByTestId('oidc-add-provider'))
    await screen.findByRole('dialog')
    // default = standard GET+Bearer
    expect(screen.getByTestId('oidc-userinfo-style-get_bearer').getAttribute('aria-checked')).toBe(
      'true',
    )
    fireEvent.change(screen.getByPlaceholderText('github-enterprise'), { target: { value: 'p' } })
    fireEvent.change(screen.getByPlaceholderText('GitHub Enterprise'), { target: { value: 'P' } })
    fireEvent.change(screen.getByPlaceholderText('https://github.corp.com'), {
      target: { value: 'https://idp.example.test' },
    })
    const [clientIdInput] = screen
      .getAllByRole('textbox')
      .filter((el) => (el as HTMLInputElement).required && (el as HTMLInputElement).value === '')
    fireEvent.change(clientIdInput!, { target: { value: 'c' } })
    fireEvent.change(document.querySelector('input[type="password"]')!, {
      target: { value: 's' },
    })
    fireEvent.click(screen.getByTestId('oidc-userinfo-style-post_json'))
    // clicking the field LABEL must not proxy to the first radio and silently
    // reset the choice (impl-gate P2: Field needs group rendering here)
    fireEvent.click(screen.getByText('Userinfo request style', { selector: 'span' }))
    expect(screen.getByTestId('oidc-userinfo-style-post_json').getAttribute('aria-checked')).toBe(
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1))
    const body = (api.post as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<string, unknown>
    expect(body.userinfoRequestStyle).toBe('post_json')
    cleanup()
    // edit回填 from the row value
    renderAuthentication([FULL_ROW])
    fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
    await screen.findByRole('dialog')
    expect(screen.getByTestId('oidc-userinfo-style-post_json').getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  test('edit: new fields回填 from the row and PATCH carries the edits', async () => {
    renderAuthentication([FULL_ROW])
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({})
    fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
    await screen.findByRole('dialog')

    expect(
      (screen.getByPlaceholderText('https://idp.corp.com/oauth/authorize') as HTMLInputElement)
        .value,
    ).toBe(FULL_ROW.authorizationEndpoint)
    expect((screen.getByPlaceholderText('preferred_username') as HTMLInputElement).value).toBe(
      'login sig',
    )
    expect((screen.getByPlaceholderText('email') as HTMLInputElement).value).toBe('mail')
    const trust = screen.getByRole('checkbox', {
      name: /Trust emails as verified/,
    }) as HTMLInputElement
    expect(trust.checked).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('https://idp.corp.com/oauth/authorize'), {
      target: { value: '' },
    })
    fireEvent.click(trust)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
    const body = (api.patch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as Record<
      string,
      unknown
    >
    expect(body.authorizationEndpoint).toBeNull() // cleared field → null
    expect(body.trustEmailVerified).toBe(false)
    expect(body.emailClaim).toBe('mail')
    expect(body.subjectClaim).toBe('id') // untouched values survive
  })

  test('legacy rows without the new fields open the dialog without crashing', async () => {
    const legacy = { ...FULL_ROW }
    delete (legacy as Record<string, unknown>).authorizationEndpoint
    delete (legacy as Record<string, unknown>).trustEmailVerified
    delete (legacy as Record<string, unknown>).usernameClaim
    delete (legacy as Record<string, unknown>).emailClaim
    renderAuthentication([legacy])
    fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
    await screen.findByRole('dialog')
    expect(
      (screen.getByPlaceholderText('https://idp.corp.com/oauth/authorize') as HTMLInputElement)
        .value,
    ).toBe('')
    expect((screen.getByPlaceholderText('email') as HTMLInputElement).value).toBe('')
  })

  test('username/email selectors fail in their own fields before submit', async () => {
    renderAuthentication([FULL_ROW])
    ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({})
    fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
    await screen.findByRole('dialog')

    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    const email = screen.getByPlaceholderText('email')
    fireEvent.change(email, { target: { value: 'mail alternate_mail' } })
    expect(email.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(/Use one plain claim name/)).toBeTruthy()
    expect(save.disabled).toBe(true)

    fireEvent.change(email, { target: { value: 'mail' } })
    const username = screen.getByPlaceholderText('preferred_username')
    fireEvent.change(username, { target: { value: '__proto__' } })
    expect(username.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(/Use 1–8 plain claim names/)).toBeTruthy()
    expect(save.disabled).toBe(true)
    expect(api.patch).not.toHaveBeenCalled()
  })

  test('test connection renders the ProbeResult: verdict, sources, jwks warning', async () => {
    renderAuthentication([FULL_ROW])
    ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      discovery: { ok: false, error: 'network down' },
      issuer: 'https://idp.example.test',
      endpoints: {
        authorizationEndpoint: {
          url: 'https://idp.example.test/oauth/authorize',
          source: 'manual',
        },
        tokenEndpoint: { url: 'https://disc.example.test/token', source: 'discovery' },
        userinfoEndpoint: null,
        jwksUri: { url: 'https://idp.example.test/jwks', source: 'manual' },
      },
      jwksReachable: false,
      scopesSupported: [],
    })
    fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByText(/Configuration cannot complete a sign-in/)
    expect(api.post).toHaveBeenCalledWith('/api/oidc/providers/p1/test')
    // not-ready + discovery down must surface the REAL failure reason, not
    // the "manual endpoints in use" fallback wording (impl-gate P2)
    expect(screen.getByText(/discovery unavailable: network down/)).toBeTruthy()
    expect(screen.getAllByText('(manual)', { exact: false }).length).toBe(2) // authorize + jwks
    expect(screen.getAllByText('(discovery)', { exact: false }).length).toBe(1) // token
    expect(screen.getByText(/not configured/)).toBeTruthy()
    expect(screen.getByText(/JWKS is configured but unreachable/)).toBeTruthy()
  })

  // RFC-250 T13 — provider forms contain a client secret and therefore stay
  // memory-only, but every dismiss path must acknowledge meaningful edits.
  test('dirty edit requires an explicit discard while a clean edit closes directly', async () => {
    renderAuthentication([FULL_ROW])
    fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
    await screen.findByRole('dialog', { name: 'Edit OIDC provider' })

    fireEvent.change(screen.getByPlaceholderText('GitHub Enterprise'), {
      target: { value: 'Changed provider' },
    })
    fireEvent.click(document.querySelector('.dialog__close')!)
    expect(await screen.findByRole('dialog', { name: 'Discard provider changes?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Discard provider changes?' })).toBeNull(),
    )
    expect(screen.getByRole('dialog', { name: 'Edit OIDC provider' })).toBeTruthy()

    fireEvent.click(document.querySelector('.dialog__close')!)
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }))
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit OIDC provider' })).toBeNull(),
    )

    // Reopening without edits keeps the ordinary one-step close behavior.
    fireEvent.click(screen.getByTestId('oidc-edit-p1'))
    await screen.findByRole('dialog', { name: 'Edit OIDC provider' })
    fireEvent.click(document.querySelector('.dialog__close')!)
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit OIDC provider' })).toBeNull(),
    )
  })

  test('dirty provider blocks router navigation until explicit discard', async () => {
    const { router } = renderAuthentication([FULL_ROW])
    fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
    await screen.findByRole('dialog', { name: 'Edit OIDC provider' })
    fireEvent.change(screen.getByPlaceholderText('GitHub Enterprise'), {
      target: { value: 'Changed provider' },
    })

    // The focused harness owns /other; the app-wide RegisteredRouter type does not.
    void router.navigate({ to: '/other' } as never)
    const routeGuard = await screen.findByTestId('unsaved-guard-dialog')
    expect(router.state.location.pathname).toBe('/settings')
    expect(within(routeGuard).getByText(/client secret/i)).toBeTruthy()
    fireEvent.click(within(routeGuard).getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/other'))
  })

  test('dirty provider blocks browser Back until explicit discard', async () => {
    const isolatedWindow = new HappyWindow({
      url: 'http://oidc.test/other',
    })
    const history = createBrowserHistory({ window: isolatedWindow })
    history.push('/settings?tab=authentication')
    history.flush()
    try {
      const { router } = renderAuthentication([FULL_ROW], { history })
      fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
      await screen.findByRole('dialog', { name: 'Edit OIDC provider' })
      fireEvent.change(screen.getByPlaceholderText('GitHub Enterprise'), {
        target: { value: 'Changed provider' },
      })

      isolatedWindow.history.back()
      await isolatedWindow.happyDOM.waitUntilComplete()
      const backGuard = await screen.findByTestId('unsaved-guard-dialog')
      expect(router.state.location.pathname).toBe('/settings')
      fireEvent.click(within(backGuard).getByRole('button', { name: 'Discard changes' }))
      await isolatedWindow.happyDOM.waitUntilComplete()
      await waitFor(() => expect(router.state.location.pathname).toBe('/other'))
    } finally {
      cleanup()
      history.destroy()
      await isolatedWindow.happyDOM.close()
    }
  })

  test('dirty provider arms beforeunload', async () => {
    const isolatedWindow = new HappyWindow({
      url: 'http://oidc.test/settings?tab=authentication',
    })
    const history = createBrowserHistory({ window: isolatedWindow })
    try {
      renderAuthentication([FULL_ROW], { history })
      fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
      await screen.findByRole('dialog', { name: 'Edit OIDC provider' })
      fireEvent.change(screen.getByPlaceholderText('GitHub Enterprise'), {
        target: { value: 'Changed provider' },
      })

      const event = new isolatedWindow.Event('beforeunload', { cancelable: true })
      isolatedWindow.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    } finally {
      history.destroy()
      await isolatedWindow.happyDOM.close()
    }
  })

  test('save and connection test are mutually exclusive, block navigation, and success disarms the guard', async () => {
    let resolvePatch!: () => void
    ;(api.patch as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolvePatch = resolve
        }),
    )
    const { router } = renderAuthentication([FULL_ROW])
    fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
    await screen.findByRole('dialog', { name: 'Edit OIDC provider' })
    fireEvent.change(screen.getByPlaceholderText('GitHub Enterprise'), {
      target: { value: 'Changed provider' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1))
    const cardFieldsets = Array.from(
      document.querySelectorAll<HTMLFieldSetElement>('fieldset.settings-card'),
    )
    expect(cardFieldsets).toHaveLength(4)
    expect(cardFieldsets.every((fieldset) => fieldset.disabled)).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Test connection' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((document.querySelector('.dialog__close') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByRole('dialog', { name: 'Edit OIDC provider' })).toBeTruthy()

    // The focused harness owns /other; the app-wide RegisteredRouter type does not.
    void router.navigate({ to: '/other' } as never)
    const routeGuard = await screen.findByTestId('unsaved-guard-dialog')
    expect(within(routeGuard).queryByRole('button', { name: 'Discard changes' })).toBeNull()
    expect(router.state.location.pathname).toBe('/settings')

    resolvePatch()
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit OIDC provider' })).toBeNull(),
    )
    await waitFor(() => expect(screen.queryByTestId('unsaved-guard-dialog')).toBeNull())
    await router.navigate({ to: '/other' } as never)
    await waitFor(() => expect(router.state.location.pathname).toBe('/other'))
  })
})
