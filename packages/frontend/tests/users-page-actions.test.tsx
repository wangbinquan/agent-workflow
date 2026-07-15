// LOCKS: /users action column — self-disable lockout + re-enable affordance.
//
// Regression coverage for the 2026-06-24 incident (an admin disabled their own
// account and there was no UI path to restore it). Locks in:
//   - The current admin's OWN row shows NO "Disable" button (self-disable
//     lockout; the backend also enforces self-disable-forbidden).
//   - A disabled user shows an "Enable" button; clicking it PATCHes
//     {status:'active'} to /api/users/:id — the inverse of the DELETE disable,
//     so a disabled account is never stranded with no way back.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { setBaseUrl, setToken } from '../src/stores/auth'
import { UsersPage } from '../src/routes/users'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      let body: unknown = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      const call: FetchCall = { url, method, body }
      calls.push(call)
      return handler(call)
    },
  )
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const ME = {
  user: { id: 'me-admin', username: 'root', displayName: 'Root', role: 'admin', status: 'active' },
  source: 'session',
  permissions: ['users:read', 'users:write'],
  linkedIdentities: [],
  pats: [],
}

const ROWS = [
  // The currently-logged-in admin (self).
  {
    id: 'me-admin',
    username: 'root',
    email: null,
    displayName: 'Root',
    role: 'admin',
    status: 'active',
    lastLoginAt: null,
  },
  // Another active user — disable-able.
  {
    id: 'u-alice',
    username: 'alice',
    email: null,
    displayName: 'Alice',
    role: 'user',
    status: 'active',
    lastLoginAt: null,
  },
  // A disabled user — should expose an Enable button.
  {
    id: 'u-dave',
    username: 'dave',
    email: null,
    displayName: 'Dave',
    role: 'user',
    status: 'disabled',
    lastLoginAt: null,
  },
]

function route(call: FetchCall): Response {
  if (call.url.includes('/api/auth/me')) return jsonResponse(ME)
  if (call.method === 'GET' && /\/api\/users(\?.*)?$/.test(call.url)) return jsonResponse(ROWS)
  if (call.method === 'PATCH' && /\/api\/users\/[^/?]+$/.test(call.url)) {
    return jsonResponse({
      id: 'u-dave',
      username: 'dave',
      email: null,
      displayName: 'Dave',
      role: 'user',
      status: 'active',
      lastLoginAt: null,
    })
  }
  return jsonResponse({ code: 'not-mocked', message: call.url }, 500)
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <UsersPage />
    </QueryClientProvider>,
  )
}

beforeEach(async () => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  await i18n.changeLanguage('en-US')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('/users action column', () => {
  test('RFC-198 page-header-primary-ratchet keeps one populated-list header task', async () => {
    installFetch(route)
    const { container } = renderPage()

    await screen.findByText('alice')
    const page = container.querySelector('.page')
    const header = page?.querySelector('header.page__header')
    const primary = header?.querySelector('button.btn--primary')

    expect(primary).not.toBeNull()
    expect(Array.from(header?.querySelectorAll('.btn--primary') ?? [])).toEqual([primary])

    // Prove that the sole primary is the page task rather than an arbitrary
    // styled control: invoking it opens the real create-user form.
    fireEvent.click(primary as HTMLButtonElement)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(document.querySelector('#users-create-form')).not.toBeNull()
  })

  test('create dialog uses labelled Form controls, focuses username, and preserves the payload', async () => {
    const calls = installFetch((call) => {
      if (call.method === 'POST' && /\/api\/users$/.test(call.url)) {
        return jsonResponse({
          id: 'u-new',
          username: 'new-user',
          email: null,
          displayName: 'New User',
          role: 'user',
          status: 'active',
          lastLoginAt: null,
        })
      }
      return route(call)
    })
    renderPage()

    await screen.findByText('alice')
    fireEvent.click(screen.getByRole('button', { name: 'New user' }))

    const dialog = await screen.findByRole('dialog')
    const username = within(dialog).getByRole('textbox', {
      name: /Username/,
    }) as HTMLInputElement
    const displayName = within(dialog).getByRole('textbox', { name: /Display name/ })
    const password = within(dialog).getByLabelText('Password (leave blank for invite-only)')
    const role = within(dialog).getByRole('combobox', { name: 'Role' })
    await waitFor(() => expect(document.activeElement).toBe(username))
    expect(username.classList.contains('form-input')).toBe(true)
    expect(displayName.classList.contains('form-input')).toBe(true)
    expect(password.classList.contains('form-input')).toBe(true)
    expect(role.closest('.form-field')).not.toBeNull()

    fireEvent.change(username, { target: { value: 'new-user' } })
    fireEvent.change(displayName, { target: { value: 'New User' } })
    fireEvent.change(password, { target: { value: 'password-123' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST' && /\/api\/users$/.test(call.url))).toBe(
        true,
      )
    })
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      username: 'new-user',
      displayName: 'New User',
      role: 'user',
      password: 'password-123',
    })
  })

  test('keeps PageHeader visible while actor permissions are loading', () => {
    installFetch((call) => {
      if (call.url.includes('/api/auth/me')) return new Promise<Response>(() => undefined)
      return jsonResponse({ code: 'unexpected-list-request', message: call.url }, 500)
    })
    renderPage()

    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeTruthy()
    expect(screen.getByTestId('loading-state')).toBeTruthy()
    expect(screen.queryByTestId('no-permission')).toBeNull()
  })

  test('renders the shared no-permission state without querying the user list', async () => {
    const calls = installFetch((call) => {
      if (call.url.includes('/api/auth/me')) {
        return jsonResponse({ ...ME, permissions: [] })
      }
      return jsonResponse({ code: 'unexpected-list-request', message: call.url }, 500)
    })
    renderPage()

    expect(await screen.findByTestId('no-permission')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeTruthy()
    expect(calls.some((call) => /\/api\/users(\?.*)?$/.test(call.url))).toBe(false)
  })

  test('own row hides Disable; only the other active user is disable-able', async () => {
    installFetch(route)
    renderPage()
    await screen.findByText('alice')
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeTruthy()
    expect(screen.getByRole('table').parentElement?.className).toContain('table-viewport__scroller')
    expect(screen.getAllByRole('button', { name: 'New user' })).toHaveLength(1)
    // me-admin is self → hidden; dave is disabled → no Disable; only alice left.
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(1)
  })

  test('initial empty list moves the only New user action into EmptyState', async () => {
    installFetch((call) => {
      if (call.url.includes('/api/auth/me')) return jsonResponse(ME)
      if (call.method === 'GET' && /\/api\/users(\?.*)?$/.test(call.url)) return jsonResponse([])
      return jsonResponse({ code: 'not-mocked', message: call.url }, 500)
    })
    renderPage()

    const empty = await screen.findByTestId('users-empty')
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeTruthy()
    expect(empty.textContent).toContain(enUS.users.emptyDescription)
    expect(empty.querySelector('[data-icon="user"]')).not.toBeNull()
    const createActions = screen.getAllByRole('button', { name: 'New user' })
    expect(createActions).toHaveLength(1)
    expect(screen.queryByRole('table')).toBeNull()
    const header = empty.closest('.page')?.querySelector('header.page__header')
    const chromePrimaries = [header, empty].flatMap((surface) =>
      Array.from(surface?.querySelectorAll('.btn--primary') ?? []),
    )
    expect(chromePrimaries).toEqual([createActions[0]])
  })

  test('initial list failure keeps PageHeader and exposes a working shared retry action', async () => {
    let listCalls = 0
    installFetch((call) => {
      if (call.url.includes('/api/auth/me')) return jsonResponse(ME)
      if (call.method === 'GET' && /\/api\/users(\?.*)?$/.test(call.url)) {
        listCalls += 1
        return jsonResponse({ code: 'users-unavailable', message: 'Users are unavailable' }, 503)
      }
      return jsonResponse({ code: 'not-mocked', message: call.url }, 500)
    })
    renderPage()

    expect((await screen.findByRole('alert')).textContent).toContain('Users are unavailable')
    expect(screen.getByRole('heading', { level: 1, name: 'Users' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New user' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(listCalls).toBe(2))
  })

  test('disabled user shows Enable → PATCH {status:active}', async () => {
    const calls = installFetch(route)
    renderPage()
    await screen.findByText('dave')
    const enableBtns = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableBtns).toHaveLength(1)
    fireEvent.click(enableBtns[0]!)
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH' && /\/api\/users\/u-dave$/.test(c.url))).toBe(
        true,
      )
    })
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.body).toEqual({ status: 'active' })
  })
})
