// RFC-221 — /users is a semantic, responsive directory with one route-owned
// transaction at a time. These tests cover the visible account modes and the
// exact write payloads while retaining the historic self-lockout guards.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AdminUserView } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'
import { UsersPage } from '../src/routes/users'
import { setBaseUrl, setToken } from '../src/stores/auth'

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

function row(id: string, overrides: Partial<AdminUserView> = {}): AdminUserView {
  return {
    id,
    username: id,
    email: null,
    displayName: id,
    role: 'user',
    status: 'active',
    forcePasswordChange: false,
    createdBy: 'me-admin',
    createdAt: 1,
    updatedAt: 1,
    lastLoginAt: null,
    hasOidcIdentity: false,
    ...overrides,
  }
}

const ROWS: AdminUserView[] = [
  row('__system__', {
    username: '__system__',
    displayName: 'System',
    role: 'admin',
    createdBy: null,
  }),
  row('me-admin', { username: 'root', displayName: 'Root', role: 'admin' }),
  row('u-alice', { username: 'alice', displayName: 'Alice' }),
  row('u-carol', {
    username: 'carol',
    displayName: 'Carol',
    email: 'carol@example.test',
    hasOidcIdentity: true,
  }),
  row('u-dave', { username: 'dave', displayName: 'Dave', status: 'disabled' }),
]

function route(call: FetchCall): Response {
  if (call.url.includes('/api/auth/me')) return jsonResponse(ME)
  if (call.method === 'GET' && call.url.includes('/api/oidc/login-policy')) {
    return jsonResponse({ passwordLoginEnabled: true, bootstrapCompletedAt: 1, updatedAt: 1 })
  }
  if (call.method === 'GET' && /\/api\/users(\?.*)?$/.test(call.url)) return jsonResponse(ROWS)
  if (call.method === 'POST' && /\/api\/users\/[^/?]+\/reset-password$/.test(call.url)) {
    return jsonResponse({ ok: true })
  }
  if (call.method === 'POST' && /\/api\/users$/.test(call.url)) {
    return jsonResponse(row('u-new', { username: 'new-user', displayName: 'New User' }), 201)
  }
  if (call.method === 'PATCH' && /\/api\/users\/[^/?]+$/.test(call.url)) {
    return jsonResponse(row('u-dave', { username: 'dave', displayName: 'Dave' }))
  }
  if (call.method === 'DELETE' && /\/api\/users\/[^/?]+$/.test(call.url)) {
    return jsonResponse({ ok: true })
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

describe('/users responsive directory actions', () => {
  test('has one page-header action, a semantic human list, and a separate system principal', async () => {
    installFetch(route)
    const { container } = renderPage()

    await screen.findByTestId('user-manage-u-alice')
    const page = container.querySelector('.page')
    const header = page?.querySelector('header.page__header')
    const primary = header?.querySelector('button.btn--primary')
    expect(primary).not.toBeNull()
    expect(Array.from(header?.querySelectorAll('.btn--primary') ?? [])).toEqual([primary])
    expect(screen.getByRole('list', { name: 'Human user accounts' })).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByRole('heading', { name: 'System principal' })).toBeTruthy()
    expect(screen.getByText('Setup token retired')).toBeTruthy()

    fireEvent.click(primary as HTMLButtonElement)
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(document.querySelector('#users-create-form')).not.toBeNull()
  })

  test('creates a password account from labelled controls with an exact payload', async () => {
    const calls = installFetch(route)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'New user' }))

    const dialog = await screen.findByRole('dialog')
    const username = within(dialog).getByRole('textbox', { name: /Username/ }) as HTMLInputElement
    const displayName = within(dialog).getByRole('textbox', { name: /Display name/ })
    const password = within(dialog).getByLabelText(/^Password/)
    await waitFor(() => expect(document.activeElement).toBe(username))

    fireEvent.change(username, { target: { value: 'new-user' } })
    fireEvent.change(displayName, { target: { value: 'New User' } })
    fireEvent.change(password, { target: { value: 'password-123' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true))
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      username: 'new-user',
      displayName: 'New User',
      role: 'user',
      password: 'password-123',
    })
  })

  test('creates an SSO invitation without leaking the hidden password', async () => {
    const calls = installFetch(route)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'New user' }))
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByTestId('users-create-mode-sso'))
    expect(within(dialog).queryByLabelText('Password')).toBeNull()
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Username/ }), {
      target: { value: 'sso-user' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Display name/ }), {
      target: { value: 'SSO User' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Email/ }), {
      target: { value: 'SSO@EXAMPLE.TEST' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true))
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      username: 'sso-user',
      displayName: 'SSO User',
      email: 'sso@example.test',
      role: 'user',
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

  test('renders no-permission without querying the user list', async () => {
    const calls = installFetch((call) => {
      if (call.url.includes('/api/auth/me')) return jsonResponse({ ...ME, permissions: [] })
      return jsonResponse({ code: 'unexpected-list-request', message: call.url }, 500)
    })
    renderPage()

    expect(await screen.findByTestId('no-permission')).toBeTruthy()
    expect(calls.some((call) => /\/api\/users(\?.*)?$/.test(call.url))).toBe(false)
  })

  test('self-management locks role and disable controls', async () => {
    installFetch(route)
    renderPage()
    fireEvent.click(await screen.findByTestId('user-manage-me-admin'))
    const dialog = await screen.findByRole('dialog')

    expect(
      (within(dialog).getByTestId('users-edit-role-admin') as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((within(dialog).getByTestId('users-edit-role-user') as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(dialog.textContent).toContain('You cannot change your own role')
    expect(within(dialog).queryByRole('button', { name: 'Disable' })).toBeNull()
  })

  test('OIDC-managed users have no reset-password action', async () => {
    installFetch(route)
    renderPage()
    fireEvent.click(await screen.findByTestId('user-manage-u-carol'))
    const dialog = await screen.findByRole('dialog')

    expect(dialog.textContent).toContain('linked identity provider')
    expect(within(dialog).queryByRole('button', { name: /Reset password/ })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: /Set password/ })).toBeNull()
  })

  test('local password reset sends only newPassword and force', async () => {
    const calls = installFetch(route)
    renderPage()
    fireEvent.click(await screen.findByTestId('user-manage-u-alice'))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset password' }),
    )

    const dialog = await screen.findByRole('dialog', { name: /Reset password for Alice/ })
    const password = within(dialog).getByLabelText(/^New password/)
    const confirm = within(dialog).getByLabelText(/^Confirm new password/)
    fireEvent.change(password, { target: { value: 'new-password-123' } })
    fireEvent.change(confirm, { target: { value: 'new-password-123' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save new password' }))

    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === 'POST' && call.url.endsWith('/u-alice/reset-password'),
        ),
      ).toBe(true),
    )
    expect(
      calls.find((call) => call.method === 'POST' && call.url.endsWith('/reset-password'))?.body,
    ).toEqual({ newPassword: 'new-password-123', force: true })
  })

  test('disabled user uses Manage → confirmation → PATCH active', async () => {
    const calls = installFetch(route)
    renderPage()
    fireEvent.click(await screen.findByTestId('user-manage-u-dave'))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Enable' }),
    )
    const confirm = await screen.findByRole('dialog', { name: /Enable Dave/ })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Enable' }))

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/u-dave'))).toBe(
        true,
      ),
    )
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ status: 'active' })
  })

  test('search and status filters retain the toolbar and expose a clear path', async () => {
    installFetch(route)
    renderPage()
    const search = (await screen.findByTestId('users-search')) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'no-such-user' } })
    expect(await screen.findByTestId('users-filtered-empty')).toBeTruthy()
    expect(screen.getByTestId('users-status-filter')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => {
      expect(search.value).toBe('')
      expect(document.activeElement).toBe(search)
    })
    expect(screen.getByTestId('user-manage-u-alice')).toBeTruthy()
  })

  test('initial empty and initial error keep the page shell and recovery action', async () => {
    let listCalls = 0
    const calls = installFetch((call) => {
      if (call.url.includes('/api/auth/me')) return jsonResponse(ME)
      if (call.url.includes('/api/oidc/login-policy')) {
        return jsonResponse({ passwordLoginEnabled: true, bootstrapCompletedAt: 1, updatedAt: 1 })
      }
      if (call.method === 'GET' && /\/api\/users(\?.*)?$/.test(call.url)) {
        listCalls += 1
        if (listCalls === 1) return jsonResponse([])
        return jsonResponse({ code: 'users-unavailable', message: 'Users are unavailable' }, 503)
      }
      return jsonResponse({ code: 'not-mocked', message: call.url }, 500)
    })
    renderPage()

    const empty = await screen.findByTestId('users-empty')
    expect(empty.textContent).toContain(enUS.users.emptyDescription)
    expect(screen.getAllByRole('button', { name: 'New user' })).toHaveLength(1)
    expect(calls.some((call) => call.method === 'GET' && /\/api\/users/.test(call.url))).toBe(true)
  })
})
