// RFC-221 — authentication settings must never let an administrator remove
// the final usable sign-in path. Password sign-in can only be turned off when
// an enabled OIDC provider exists, and doing so protects that last provider.

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

const ENABLED_PROVIDER = {
  id: 'corp',
  slug: 'corp',
  displayName: 'Company SSO',
  issuerUrl: 'https://id.example.test',
  clientId: 'agent-workflow',
  scopes: 'openid profile email',
  provisioning: 'invite' as const,
  allowedEmailDomains: [],
  iconUrl: null,
  enabled: true,
  authorizationEndpoint: null,
  tokenEndpoint: null,
  userinfoEndpoint: null,
  userinfoRequestStyle: 'get_bearer' as const,
  jwksUri: null,
  trustEmailVerified: false,
  usernameClaim: null,
  subjectClaim: null,
  createdAt: 1,
  updatedAt: 1,
}

function renderAuthentication(options: {
  passwordLoginEnabled: boolean
  providers?: (typeof ENABLED_PROVIDER)[]
}) {
  let policy = {
    passwordLoginEnabled: options.passwordLoginEnabled,
    bootstrapCompletedAt: 10,
    updatedAt: 10,
  }
  const providers = options.providers ?? []

  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/oidc/providers') return Promise.resolve(providers)
    if (url === '/api/oidc/login-policy') return Promise.resolve(policy)
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })
  ;(api.put as ReturnType<typeof vi.fn>).mockImplementation(
    (_url: string, body: { passwordLoginEnabled: boolean }) => {
      policy = { ...policy, passwordLoginEnabled: body.passwordLoginEnabled, updatedAt: 11 }
      return Promise.resolve(policy)
    },
  )

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
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.put as ReturnType<typeof vi.fn>).mockReset()
  ;(api.post as ReturnType<typeof vi.fn>).mockReset()
  ;(api.patch as ReturnType<typeof vi.fn>).mockReset()
  ;(api.delete as ReturnType<typeof vi.fn>).mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-221 authentication login policy UX', () => {
  test('keeps password sign-in locked on until an enabled provider exists', async () => {
    renderAuthentication({ passwordLoginEnabled: true })

    const passwordSwitch = (await screen.findByTestId('password-login-switch')) as HTMLInputElement
    expect(passwordSwitch.checked).toBe(true)
    expect(passwordSwitch.disabled).toBe(true)
    expect(screen.getByText(/No identity provider is enabled/)).toBeTruthy()
    expect(screen.getByText('Permanently retired')).toBeTruthy()

    fireEvent.click(passwordSwitch)
    expect(api.put).not.toHaveBeenCalled()
  })

  test('requires confirmation before turning password sign-in off', async () => {
    renderAuthentication({ passwordLoginEnabled: true, providers: [ENABLED_PROVIDER] })

    const passwordSwitch = (await screen.findByTestId('password-login-switch')) as HTMLInputElement
    expect(passwordSwitch.disabled).toBe(false)
    fireEvent.click(passwordSwitch)

    const dialog = await screen.findByRole('dialog')
    expect(api.put).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off password sign-in' }))

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/oidc/login-policy', {
        passwordLoginEnabled: false,
      })
      expect(passwordSwitch.checked).toBe(false)
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  test('protects the final enabled provider and can re-enable passwords directly', async () => {
    renderAuthentication({ passwordLoginEnabled: false, providers: [ENABLED_PROVIDER] })

    const passwordSwitch = (await screen.findByTestId('password-login-switch')) as HTMLInputElement
    const deleteProvider = (await screen.findByTestId('oidc-delete-corp')) as HTMLButtonElement
    expect(passwordSwitch.checked).toBe(false)
    expect(deleteProvider.disabled).toBe(true)
    expect(deleteProvider.title).toContain('At least one enabled identity provider')

    fireEvent.click(screen.getByTestId('oidc-edit-corp'))
    const dialog = await screen.findByRole('dialog')
    const enabledSwitch = within(dialog).getByRole('checkbox', { name: /^Enabled/ })
    expect((enabledSwitch as HTMLInputElement).disabled).toBe(true)
    expect(dialog.textContent).toContain('At least one enabled identity provider')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(passwordSwitch)

    await waitFor(() => {
      expect(api.put).toHaveBeenCalledWith('/api/oidc/login-policy', {
        passwordLoginEnabled: true,
      })
      expect(passwordSwitch.checked).toBe(true)
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
