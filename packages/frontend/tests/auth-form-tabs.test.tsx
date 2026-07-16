// RFC-198 PR5 — Auth is a real shared-tab surface. These rendered locks keep
// late OIDC discovery, keep-mounted form drafts, linked tab/panel semantics,
// and the one-time initial focus contract from regressing.

import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'
import { Route as AuthRoute } from '../src/routes/auth'
import { clearToken, setBaseUrl } from '../src/stores/auth'

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderAuth(initialEntry = '/auth') {
  const root = createRootRoute({ component: () => <Outlet /> })
  const auth = createRoute({
    getParentRoute: () => root,
    path: '/auth',
    validateSearch: AuthRoute.options.validateSearch,
    component: AuthRoute.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([auth]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  return render(
    // Test route types intentionally differ from the generated app tree.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <RouterProvider router={router as any} />,
  )
}

beforeEach(async () => {
  clearToken()
  setBaseUrl('http://daemon.test')
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('/auth shared forms and tabs', () => {
  test('distinguishes OIDC loading, discovery error with retry, and configured-empty', async () => {
    let firstReject: ((reason?: unknown) => void) | undefined
    const first = new Promise<Response>((_resolve, reject) => {
      firstReject = reject
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(json({ providers: [] }))
    renderAuth()

    expect(await screen.findByTestId('oidc-discovery-loading')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: enUS.auth.username }), {
      target: { value: 'preserved-user' },
    })
    await act(async () => firstReject!(new Error('discovery offline')))

    const error = await screen.findByRole('alert')
    expect(error.textContent).toContain(enUS.auth.oidcDiscoveryError)
    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findByText(enUS.auth.oidcDiscoveryEmpty)).toBeTruthy()
    expect(
      (screen.getByRole('textbox', { name: enUS.auth.username }) as HTMLInputElement).value,
    ).toBe('preserved-user')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('focuses username once, preserves both drafts, and links every tab to its panel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ providers: [] }))
    renderAuth()

    const username = (await screen.findByRole('textbox', {
      name: enUS.auth.username,
    })) as HTMLInputElement
    const password = screen.getByLabelText(enUS.auth.password) as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(username))

    fireEvent.change(username, { target: { value: 'alice' } })
    fireEvent.change(password, { target: { value: 'correct horse' } })

    const passwordTab = screen.getByRole('tab', { name: enUS.auth.tabPassword })
    const tokenTab = screen.getByRole('tab', { name: enUS.auth.tabToken })
    passwordTab.focus()
    fireEvent.keyDown(passwordTab, { key: 'ArrowRight' })

    await waitFor(() => expect(tokenTab.getAttribute('aria-selected')).toBe('true'))
    expect(document.activeElement).toBe(tokenTab)
    const token = screen.getByLabelText(enUS.auth.token) as HTMLInputElement
    fireEvent.change(token, { target: { value: 'daemon-secret' } })

    fireEvent.keyDown(tokenTab, { key: 'ArrowLeft' })
    await waitFor(() => expect(document.activeElement).toBe(passwordTab))
    expect(username.value).toBe('alice')
    expect(password.value).toBe('correct horse')
    expect(document.activeElement).toBe(passwordTab)

    fireEvent.keyDown(passwordTab, { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement).toBe(tokenTab))
    expect(token.value).toBe('daemon-secret')
    expect(document.activeElement).toBe(tokenTab)

    for (const tab of [passwordTab, tokenTab]) {
      const panelId = tab.getAttribute('aria-controls')
      expect(panelId).toBeTruthy()
      const panel = document.getElementById(panelId!)
      expect(panel?.getAttribute('role')).toBe('tabpanel')
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id)
    }
  })

  test('adds a late OIDC method without displacing the active token tab or stealing focus', async () => {
    let resolveProviders: ((response: Response) => void) | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveProviders = resolve
        }),
    )
    renderAuth()

    const passwordTab = await screen.findByRole('tab', { name: enUS.auth.tabPassword })
    const tokenTab = screen.getByRole('tab', { name: enUS.auth.tabToken })
    passwordTab.focus()
    fireEvent.keyDown(passwordTab, { key: 'End' })
    await waitFor(() => expect(document.activeElement).toBe(tokenTab))
    expect(tokenTab.getAttribute('aria-selected')).toBe('true')

    await waitFor(() => expect(resolveProviders).toBeTypeOf('function'))
    await act(async () => {
      resolveProviders!(
        json({
          providers: [{ slug: 'corp', displayName: 'Corporate SSO', iconUrl: null }],
        }),
      )
    })

    const oidcTab = await screen.findByRole('tab', { name: enUS.auth.tabOidc })
    expect(tokenTab.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tokenTab)

    fireEvent.keyDown(tokenTab, { key: 'ArrowLeft' })
    await waitFor(() => expect(oidcTab.getAttribute('aria-selected')).toBe('true'))
    expect(document.activeElement).toBe(oidcTab)
    expect(screen.getByRole('button', { name: 'Login with Corporate SSO' })).toBeTruthy()

    const panelId = oidcTab.getAttribute('aria-controls')
    expect(document.getElementById(panelId!)?.getAttribute('aria-labelledby')).toBe(oidcTab.id)
  })

  test('keeps the password payload and clears a method error when switching tabs', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(request.toString()).pathname
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
        calls.push({ path, method, body })
        if (path === '/api/auth/oidc/providers') return json({ providers: [] })
        if (path === '/api/auth/login') {
          return json({ code: 'invalid-credentials', message: 'invalid credentials' }, 401)
        }
        return json({ code: 'unexpected', message: path }, 500)
      },
    )
    renderAuth('/auth?redirect=%2Ftasks%2Ft%2Fpreview%3Fpath%3Da.md%23heading')

    fireEvent.change(await screen.findByRole('textbox', { name: enUS.auth.username }), {
      target: { value: 'alice' },
    })
    fireEvent.change(screen.getByLabelText(enUS.auth.password), {
      target: { value: 'correct horse' },
    })
    fireEvent.click(screen.getByRole('button', { name: enUS.auth.signIn }))

    expect((await screen.findByRole('alert')).textContent).toContain(enUS.auth.invalidCredentials)
    expect(calls.find((call) => call.path === '/api/auth/login')?.body).toEqual({
      username: 'alice',
      password: 'correct horse',
    })

    fireEvent.click(screen.getByRole('tab', { name: enUS.auth.tabToken }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    fireEvent.click(screen.getByRole('tab', { name: enUS.auth.tabPassword }))
    expect(
      (screen.getByRole('textbox', { name: enUS.auth.username }) as HTMLInputElement).value,
    ).toBe('alice')
  })
})
