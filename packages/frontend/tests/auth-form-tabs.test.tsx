// RFC-221 — the login page renders exactly the server-discovered method set.
// Bootstrap never leaks password/OIDC login, and ready installations never
// retain the daemon-token escape hatch.

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
import { clearToken, getToken, setBaseUrl, setToken } from '../src/stores/auth'

const BOOTSTRAP = {
  mode: 'bootstrap',
  providers: [],
  passwordLoginEnabled: false,
  daemonTokenEnabled: true,
} as const

function ready(passwordLoginEnabled: boolean, withProvider = false) {
  return {
    mode: 'ready',
    providers: withProvider ? [{ slug: 'corp', displayName: 'Corporate SSO', iconUrl: null }] : [],
    passwordLoginEnabled,
    daemonTokenEnabled: false,
  } as const
}

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
  const setupAdmin = createRoute({
    getParentRoute: () => root,
    path: '/setup/admin',
    component: () => <div data-testid="setup-admin-stub" />,
  })
  const router = createRouter({
    routeTree: root.addChildren([auth, setupAdmin]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const view = render(
    // Test route types intentionally differ from the generated app tree.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <RouterProvider router={router as any} />,
  )
  return { ...view, router }
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

describe('/auth method discovery', () => {
  test('keeps all credential controls hidden while loading and on discovery failure', async () => {
    let rejectDiscovery: ((reason?: unknown) => void) | undefined
    const pending = new Promise<Response>((_resolve, reject) => {
      rejectDiscovery = reject
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => pending)
      .mockResolvedValueOnce(json(BOOTSTRAP))
    renderAuth()

    expect(await screen.findByTestId('auth-discovery-loading')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByLabelText(enUS.auth.token)).toBeNull()

    await act(async () => rejectDiscovery!(new Error('discovery offline')))
    expect((await screen.findByRole('alert')).textContent).toContain(enUS.auth.oidcDiscoveryError)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByLabelText(enUS.auth.token)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(await screen.findByTestId('auth-token-form')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('bootstrap exposes only the setup-token form without a method switcher', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(BOOTSTRAP))
    renderAuth()

    expect(await screen.findByTestId('auth-token-form')).toBeTruthy()
    expect(screen.queryByTestId('auth-password-form')).toBeNull()
    expect(screen.queryByTestId('auth-oidc-method')).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    // 事件驱动的焦点锚点，不要退回 `waitFor(() => document.activeElement === ...)`。
    //
    // 这条断言曾是 `docs/audit-backlog.md` 登记的「第七条同源 flaky」：轮询全局
    // `document.activeElement` 直到超时，等的是 render → effect → `ref.focus()` 这条
    // 跨 turn 的三段链。满载 runner 上越线即红——本机满载 gate 复现过一次，2026-08-09
    // 又在 CI（ubuntu shard 1/3，5081ms 超时）红过一次，而同 run 的 macOS / windows
    // 三条腿全绿：典型的时序敏感面，不是回归。
    //
    // 修法不是继续加超时——预算只要还是「猜一个够大的数」，负载一变就再越线。
    //
    // ⚠️ backlog 原文建议的 `expect(await findByLabelText(...)).toHaveFocus()` 在本仓
    // **跑不了**：前端没装 jest-dom，`toHaveFocus` 会直接 `Invalid Chai property`。
    // 可用的等价改法是把**查询提到轮询之外**：原写法每轮询一次就 `getByLabelText`
    // 重扫一遍整棵树（这个页面的 DOM 很大——两段 SVG 插画 + 完整表单），满载 runner 上
    // 光是这个重复扫描就能吃掉 5s 预算。元素在上面 `findByTestId` 时就已存在，真正
    // 要等的只有 `ref.focus()` 那一步，所以只让轮询体读一个已经拿到的引用。
    const token = await screen.findByLabelText(enUS.auth.token)
    await waitFor(() => expect(document.activeElement).toBe(token))
  })

  test('valid bootstrap token is persisted for the handoff and preserves the redirect', async () => {
    const calls: Array<{ path: string; authorization: string | null }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(request.toString()).pathname
        calls.push({
          path,
          authorization: new Headers(init?.headers).get('authorization'),
        })
        if (path === '/api/auth/oidc/providers') return json(BOOTSTRAP)
        if (path === '/api/whoami') return json({ source: 'daemon' })
        return json({ code: 'unexpected', message: path }, 500)
      },
    )
    const { router } = renderAuth('/auth?redirect=%2Ftasks%2Ft-1%3Ftab%3Doutput')

    fireEvent.change(await screen.findByLabelText(enUS.auth.token), {
      target: { value: ' setup-secret ' },
    })
    fireEvent.click(screen.getByRole('button', { name: /continue setup/i }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/setup/admin'))
    expect(router.state.location.search.redirect).toBe('/tasks/t-1?tab=output')
    expect(getToken()).toBe('setup-secret')
    expect(calls.find((call) => call.path === '/api/whoami')?.authorization).toBe(
      'Bearer setup-secret',
    )
  })

  test('daemon bootstrap link verifies its captured token and enters setup automatically', async () => {
    const calls: Array<{ path: string; authorization: string | null }> = []
    let resolveWhoami: ((response: Response) => void) | undefined
    const whoami = new Promise<Response>((resolve) => {
      resolveWhoami = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(request.toString()).pathname
        calls.push({
          path,
          authorization: new Headers(init?.headers).get('authorization'),
        })
        if (path === '/api/auth/oidc/providers') return json(BOOTSTRAP)
        if (path === '/api/whoami') return whoami
        return json({ code: 'unexpected', message: path }, 500)
      },
    )
    setToken('query-secret')
    const { router } = renderAuth('/auth?bootstrap=token&redirect=%2Ftasks%2Ft-1%3Ftab%3Doutput')

    expect(await screen.findByTestId('auth-bootstrap-handoff')).toBeTruthy()
    await act(async () => resolveWhoami!(json({ source: 'daemon' })))
    await waitFor(() => expect(router.state.location.pathname).toBe('/setup/admin'))
    expect(router.state.location.search.redirect).toBe('/tasks/t-1?tab=output')
    expect(calls.find((call) => call.path === '/api/whoami')?.authorization).toBe(
      'Bearer query-secret',
    )
  })

  test('stale bootstrap link falls back to configured ready methods without retaining token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(ready(true)))
    setToken('retired-daemon-token')
    const { router } = renderAuth('/auth?bootstrap=token&redirect=%2Fagents')

    expect(await screen.findByTestId('auth-password-form')).toBeTruthy()
    await waitFor(() => expect(router.state.location.search.bootstrap).toBeUndefined())
    expect(getToken()).toBeNull()
    expect(screen.queryByLabelText(enUS.auth.token)).toBeNull()
  })

  test('ready installation with no providers renders password login only', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(ready(true)))
    renderAuth()

    expect(await screen.findByTestId('auth-password-form')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByLabelText(enUS.auth.token)).toBeNull()
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('textbox', { name: enUS.auth.username }),
      ),
    )
  })

  test('ready installation with password and OIDC has exactly two accessible methods', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(ready(true, true)))
    renderAuth()

    const oidcTab = await screen.findByRole('tab', { name: enUS.auth.tabOidc })
    const passwordTab = screen.getByRole('tab', { name: enUS.auth.tabPassword })
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.queryByRole('tab', { name: enUS.auth.tabToken })).toBeNull()
    await waitFor(() => expect(oidcTab.getAttribute('aria-selected')).toBe('true'))
    const providerButton = screen.getByRole('button', { name: 'Login with Corporate SSO' })
    expect(providerButton).toBeTruthy()
    expect(providerButton.querySelector('.auth-page__provider-name')?.textContent).toBe(
      'Corporate SSO',
    )
    expect(providerButton.querySelector('.auth-page__provider-copy > span')?.textContent).toBe(
      enUS.auth.providerButtonHint,
    )

    fireEvent.click(passwordTab)
    expect(await screen.findByTestId('auth-password-form')).toBeTruthy()
    expect(screen.queryByLabelText(enUS.auth.token)).toBeNull()
  })

  test('disabling password login removes its tab and form from the DOM', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(ready(false, true)))
    renderAuth()

    expect(await screen.findByTestId('auth-oidc-method')).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('textbox', { name: enUS.auth.username })).toBeNull()
    expect(screen.queryByLabelText(enUS.auth.password)).toBeNull()
    expect(screen.queryByLabelText(enUS.auth.token)).toBeNull()
  })

  test('rejects an impossible mixed bootstrap payload instead of exposing fallbacks', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        mode: 'bootstrap',
        providers: [{ slug: 'corp', displayName: 'Corporate SSO', iconUrl: null }],
        passwordLoginEnabled: true,
        daemonTokenEnabled: true,
      }),
    )
    renderAuth()

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByLabelText(enUS.auth.token)).toBeNull()
  })
})
