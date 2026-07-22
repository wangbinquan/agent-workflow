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
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { DEFAULT_CONFIG } from '@agent-workflow/shared'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn(),
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
  jwksUri: null,
  trustEmailVerified: true,
  usernameClaim: 'login sig',
  subjectClaim: 'id',
  createdAt: 1,
  updatedAt: 1,
}

function renderAuthentication(rows: Array<Record<string, unknown>>) {
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/oidc/providers') return Promise.resolve(rows.slice())
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
  const router = createRouter({
    routeTree: root.addChildren([settings]),
    history: createMemoryHistory({ initialEntries: ['/settings?tab=authentication'] }),
  })
  render(
    <QueryClientProvider client={client}>
      {/* The focused harness intentionally clones the production route id. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.post as ReturnType<typeof vi.fn>).mockReset()
  ;(api.patch as ReturnType<typeof vi.fn>).mockReset()
  ;(api.delete as ReturnType<typeof vi.fn>).mockReset()
})

afterEach(() => {
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
    expect(body.subjectClaim).toBe('id')
    expect(body.trustEmailVerified).toBe(false)
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
    expect(body.subjectClaim).toBe('id') // untouched values survive
  })

  test('legacy rows without the new fields open the dialog without crashing', async () => {
    const legacy = { ...FULL_ROW }
    delete (legacy as Record<string, unknown>).authorizationEndpoint
    delete (legacy as Record<string, unknown>).trustEmailVerified
    delete (legacy as Record<string, unknown>).usernameClaim
    renderAuthentication([legacy])
    fireEvent.click(await screen.findByTestId('oidc-edit-p1'))
    await screen.findByRole('dialog')
    expect(
      (screen.getByPlaceholderText('https://idp.corp.com/oauth/authorize') as HTMLInputElement)
        .value,
    ).toBe('')
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
})
