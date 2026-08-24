// RFC-221 — /users is a semantic, responsive directory with one route-owned
// transaction at a time. These tests cover the visible account modes and the
// exact write payloads while retaining the historic self-lockout guards.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AdminUserView } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { enUS } from '../src/i18n/en-US'
import { meQueryOptions, type MeResponse } from '../src/hooks/useActor'
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

const ME: MeResponse = {
  user: { id: 'me-admin', username: 'root', displayName: 'Root', role: 'admin', status: 'active' },
  profile: {
    displayName: 'Root',
    email: 'root@example.test',
    gitCommitIdentity: { name: 'Root', email: 'root@example.test' },
  },
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
    additionalPermissions: [],
    accessRevision: 0,
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
  row('me-admin', { username: 'root', displayName: 'Root', role: 'admin', lastLoginAt: 2_000 }),
  row('u-alice', { username: 'alice', displayName: 'Alice' }),
  row('u-carol', {
    username: 'carol',
    displayName: 'Carol',
    email: 'carol@example.test',
    hasOidcIdentity: true,
    lastLoginAt: 9_000,
  }),
  row('u-dave', { username: 'dave', displayName: 'Dave', status: 'disabled' }),
]

function route(call: FetchCall): Response {
  if (call.url.includes('/api/auth/me')) return jsonResponse(ME)
  if (call.method === 'GET' && call.url.includes('/api/oidc/login-policy')) {
    return jsonResponse({
      passwordLoginEnabled: true,
      oidcDefaultRole: 'guest',
      bootstrapCompletedAt: 1,
      updatedAt: 1,
    })
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
  const view = render(
    <QueryClientProvider client={qc}>
      <UsersPage />
    </QueryClientProvider>,
  )
  return { ...view, qc }
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
  test('permission loss and token switch close a connected create dialog and issue zero writes', async () => {
    const calls = installFetch(route)
    const { qc } = renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'New user' }))
    let dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Username/ }), {
      target: { value: 'stale-user' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Display name/ }), {
      target: { value: 'Stale User' },
    })
    fireEvent.change(within(dialog).getByLabelText(/^Password/), {
      target: { value: 'password-123' },
    })
    let staleCreate = within(dialog).getByRole('button', { name: 'Create' })
    let invocations = 0
    staleCreate.addEventListener('click', () => {
      invocations += 1
    })
    act(() => {
      qc.setQueryData(meQueryOptions('tok').queryKey, {
        ...ME,
        permissions: ['users:read'],
      })
      fireEvent.click(staleCreate)
    })
    expect(invocations).toBe(1)
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    act(() => qc.setQueryData(meQueryOptions('tok').queryKey, ME))
    fireEvent.click(await screen.findByRole('button', { name: 'New user' }))
    dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Username/ }), {
      target: { value: 'actor-a-user' },
    })
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Display name/ }), {
      target: { value: 'Actor A User' },
    })
    fireEvent.change(within(dialog).getByLabelText(/^Password/), {
      target: { value: 'password-123' },
    })
    staleCreate = within(dialog).getByRole('button', { name: 'Create' })
    staleCreate.addEventListener('click', () => {
      invocations += 1
    })
    const actorB: MeResponse = {
      ...ME,
      user: { ...ME.user, id: 'admin-b', username: 'admin-b' },
    }
    act(() => {
      setToken('tok-b')
      qc.setQueryData(meQueryOptions('tok-b').queryKey, actorB)
      fireEvent.click(staleCreate)
    })
    expect(invocations).toBe(2)
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

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

  // Newest sign-in first (user request 2026-08-19): Carol (9_000) then Root (2_000),
  // with the never-signed-in accounts below them in name order.
  test('lists accounts newest sign-in first and keeps never-signed-in ones last', async () => {
    installFetch(route)
    const { container } = renderPage()

    await screen.findByTestId('user-manage-u-alice')
    const list = screen.getByRole('list', { name: 'Human user accounts' })
    expect(
      Array.from(list.querySelectorAll('.user-directory__item')).map((item) =>
        item.getAttribute('data-user-id'),
      ),
    ).toEqual(['u-carol', 'me-admin', 'u-alice', 'u-dave'])
    expect(container.querySelectorAll('.user-directory__last-login')).toHaveLength(4)
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
    fireEvent.click(within(dialog).getByTestId('user-permission-scripts:author'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true))
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      username: 'new-user',
      displayName: 'New User',
      role: 'user',
      password: 'password-123',
      additionalPermissions: ['scripts:author'],
    })
  })

  test('busy locks the permission draft and a failed create keeps every entered value', async () => {
    let settleCreate: ((response: Response) => void) | undefined
    const pendingCreate = new Promise<Response>((resolveCreate) => {
      settleCreate = resolveCreate
    })
    installFetch((call) => {
      if (call.method === 'POST' && /\/api\/users$/.test(call.url)) return pendingCreate
      return route(call)
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'New user' }))
    const dialog = await screen.findByRole('dialog')
    const username = within(dialog).getByRole('textbox', { name: /Username/ }) as HTMLInputElement
    const displayName = within(dialog).getByRole('textbox', {
      name: /Display name/,
    }) as HTMLInputElement
    const password = within(dialog).getByLabelText(/^Password/) as HTMLInputElement
    const scripts = within(dialog).getByTestId('user-permission-scripts:author') as HTMLInputElement

    fireEvent.change(username, { target: { value: 'retry-user' } })
    fireEvent.change(displayName, { target: { value: 'Retry User' } })
    fireEvent.change(password, { target: { value: 'password-123' } })
    fireEvent.click(scripts)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(
        (within(dialog).getByRole('button', { name: 'Saving…' }) as HTMLButtonElement).disabled,
      ).toBe(true)
      expect(scripts.disabled).toBe(true)
      expect(
        (within(dialog).getByTestId('user-permission-search') as HTMLInputElement).disabled,
      ).toBe(true)
      expect(
        (within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled,
      ).toBe(true)
    })

    act(() => {
      settleCreate?.(
        jsonResponse(
          { ok: false, code: 'user-create-failed', message: 'Create failed; retry safely' },
          500,
        ),
      )
    })
    expect(await within(dialog).findByText('Create failed; retry safely')).toBeTruthy()
    expect(username.value).toBe('retry-user')
    expect(displayName.value).toBe('Retry User')
    expect(password.value).toBe('password-123')
    expect(scripts.checked).toBe(true)
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
      additionalPermissions: [],
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
    expect(dialog.textContent).toContain('You cannot change your own access preset or grants')
    expect(within(dialog).queryByRole('button', { name: 'Disable' })).toBeNull()
  })

  test('updates an exact permission set with the observed access revision', async () => {
    const calls = installFetch(route)
    renderPage()
    fireEvent.click(await screen.findByTestId('user-manage-u-alice'))
    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByTestId('user-permission-scripts:author'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/u-alice'))).toBe(
        true,
      ),
    )
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      access: {
        role: 'user',
        additionalPermissions: ['scripts:author'],
        expectedRevision: 0,
      },
    })
  })

  test('keeps the permission draft after an OCC conflict until reload is requested', async () => {
    let listCalls = 0
    const calls = installFetch((call) => {
      if (call.url.includes('/api/auth/me')) return jsonResponse(ME)
      if (call.method === 'GET' && call.url.includes('/api/oidc/login-policy')) {
        return jsonResponse({
          passwordLoginEnabled: true,
          oidcDefaultRole: 'guest',
          bootstrapCompletedAt: 1,
          updatedAt: 1,
        })
      }
      if (call.method === 'GET' && /\/api\/users(\?.*)?$/.test(call.url)) {
        listCalls += 1
        return jsonResponse(
          ROWS.map((user) =>
            user.id === 'u-alice' ? { ...user, accessRevision: listCalls === 1 ? 7 : 8 } : user,
          ),
        )
      }
      if (call.method === 'PATCH' && call.url.endsWith('/api/users/u-alice')) {
        return jsonResponse(
          { error: { code: 'user-access-stale', message: 'Access changed concurrently' } },
          409,
        )
      }
      return jsonResponse({ code: 'not-mocked', message: call.url }, 500)
    })
    renderPage()
    fireEvent.click(await screen.findByTestId('user-manage-u-alice'))
    const dialog = await screen.findByRole('dialog')
    const scripts = within(dialog).getByTestId('user-permission-scripts:author') as HTMLInputElement

    fireEvent.click(scripts)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    expect(await within(dialog).findByText('Permissions changed elsewhere')).toBeTruthy()
    expect(scripts.checked).toBe(true)
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      access: {
        role: 'user',
        additionalPermissions: ['scripts:author'],
        expectedRevision: 7,
      },
    })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload latest' }))
    await waitFor(() => expect(listCalls).toBeGreaterThan(1))
    await waitFor(() => {
      const latest = screen.getByTestId('user-permission-scripts:author') as HTMLInputElement
      expect(latest.checked).toBe(false)
    })
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

  // User-reported regression (2026-07-30): the transient success banner used
  // to touch the directory search toolbar because QueryState renders a
  // fragment and the page itself does not provide sibling spacing.
  test('keeps transient success feedback separated from the directory filters', async () => {
    installFetch(route)
    renderPage()
    fireEvent.click(await screen.findByTestId('user-manage-u-dave'))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Enable' }),
    )
    const confirm = await screen.findByRole('dialog', { name: /Enable Dave/ })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Enable' }))

    const noticeText = await screen.findByText(enUS.users.notice.enabled)
    const banner = noticeText.closest('.notice-banner')
    const feedbackStack = banner?.parentElement
    expect(feedbackStack?.classList.contains('feedback-stack')).toBe(true)
    expect(feedbackStack?.classList.contains('feedback-stack--section')).toBe(true)
    expect(feedbackStack?.nextElementSibling?.classList.contains('user-directory')).toBe(true)
    expect(
      feedbackStack?.nextElementSibling?.querySelector('.user-directory__toolbar'),
    ).not.toBeNull()
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
        return jsonResponse({
          passwordLoginEnabled: true,
          oidcDefaultRole: 'guest',
          bootstrapCompletedAt: 1,
          updatedAt: 1,
        })
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
