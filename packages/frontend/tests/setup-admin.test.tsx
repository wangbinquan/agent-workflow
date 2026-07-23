// RFC-221 — mandatory, one-way first-administrator handoff.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import i18n from '../src/i18n'
import { Route as SetupRoute } from '../src/routes/setup.admin'
import { clearToken, getToken, setBaseUrl, setToken } from '../src/stores/auth'

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderSetup(initialEntry = '/setup/admin') {
  const root = createRootRoute({ component: () => <Outlet /> })
  const setup = createRoute({
    getParentRoute: () => root,
    path: '/setup/admin',
    validateSearch: SetupRoute.options.validateSearch,
    component: SetupRoute.options.component,
  })
  const auth = createRoute({
    getParentRoute: () => root,
    path: '/auth',
    component: () => <div>auth destination</div>,
  })
  const router = createRouter({
    routeTree: root.addChildren([setup, auth]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      {/* Test route types intentionally differ from the generated app tree. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { ...view, router }
}

beforeEach(async () => {
  clearToken()
  setToken('daemon-bootstrap-token')
  setBaseUrl('http://daemon.test')
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('/setup/admin', () => {
  test('posts only administrator-owned fields, retires the token, and preserves redirect', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(request.toString()).pathname
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
        calls.push({ path, method, body })
        if (path === '/api/auth/bootstrap/status') return json({ required: true })
        if (path === '/api/auth/bootstrap/admin') return json({ id: 'u-first' }, 201)
        return json({ code: 'unexpected', message: path }, 500)
      },
    )
    const { router } = renderSetup('/setup/admin?redirect=%2Fworkflows%3Fview%3Dmine')

    fireEvent.change(await screen.findByLabelText(/username/i), {
      target: { value: 'first-admin' },
    })
    fireEvent.change(screen.getByLabelText(/display name/i), {
      target: { value: 'First Administrator' },
    })
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'admin@example.com' },
    })
    fireEvent.change(screen.getAllByLabelText(/password/i)[0]!, {
      target: { value: 'correct horse battery' },
    })
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'correct horse battery' },
    })
    fireEvent.click(screen.getByRole('button', { name: /complete.*handoff/i }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/auth'))
    expect(router.state.location.search).toEqual({
      setup: 'complete',
      redirect: '/workflows?view=mine',
    })
    expect(getToken()).toBeNull()
    expect(calls.find((call) => call.path === '/api/auth/bootstrap/admin')).toEqual({
      path: '/api/auth/bootstrap/admin',
      method: 'POST',
      body: {
        username: 'first-admin',
        displayName: 'First Administrator',
        email: 'admin@example.com',
        password: 'correct horse battery',
      },
    })
  })

  test('keeps submission disabled while password confirmation differs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ required: true }))
    renderSetup()

    fireEvent.change(await screen.findByLabelText(/username/i), { target: { value: 'admin' } })
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: 'Admin' } })
    fireEvent.change(screen.getAllByLabelText(/password/i)[0]!, {
      target: { value: 'password-one' },
    })
    fireEvent.change(screen.getByLabelText(/confirm password/i), {
      target: { value: 'password-two' },
    })

    expect(
      screen.getByRole('button', { name: /complete.*handoff/i }).hasAttribute('disabled'),
    ).toBe(true)
    expect(screen.getByText(/passwords do not match/i)).toBeTruthy()
  })

  test('an already-completed bootstrap clears a stale daemon token and returns to login', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ required: false }))
    const { router } = renderSetup()

    await waitFor(() => expect(router.state.location.pathname).toBe('/auth'))
    expect(getToken()).toBeNull()
  })
})
