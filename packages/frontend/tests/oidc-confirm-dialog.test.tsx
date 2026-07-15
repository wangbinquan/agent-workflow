// RFC-198 PR5 — OIDC provider deletion uses the transactional ConfirmDialog
// contract and the provider editor uses the shared form primitives.

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
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
import { Route as SettingsRoute, validateSettingsSearch } from '../src/routes/settings'

interface Provider {
  id: string
  slug: string
  displayName: string
  issuerUrl: string
  clientId: string
  scopes: string
  provisioning: 'auto' | 'allowlist' | 'invite'
  allowedEmailDomains: string[]
  iconUrl: string | null
  enabled: boolean
  createdAt: number
  updatedAt: number
}

function provider(id: string, displayName: string): Provider {
  return {
    id,
    slug: id,
    displayName,
    issuerUrl: `https://${id}.example.test`,
    clientId: `${id}-client`,
    scopes: 'openid profile email',
    provisioning: 'invite',
    allowedEmailDomains: [],
    iconUrl: null,
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderAuthentication(initialRows: Provider[]) {
  const server = { rows: initialRows.slice() }
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/oidc/providers') return Promise.resolve(server.rows.slice())
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  client.setQueryData(['config'], DEFAULT_CONFIG)
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
  return { client, server }
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

describe('/settings OIDC provider UX', () => {
  test('cancel uses the snapshotted provider name and restores the still-mounted trigger', async () => {
    const { client } = renderAuthentication([provider('p1', 'Original provider')])
    const trigger = await screen.findByTestId('oidc-delete-p1')
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('Original provider')

    act(() => {
      client.setQueryData<Provider[]>(['oidc-providers'], (rows) =>
        rows?.map((row) => ({ ...row, displayName: 'Renamed after open' })),
      )
    })
    expect(dialog.textContent).toContain('Original provider')
    expect(dialog.textContent).not.toContain('Renamed after open')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    })
    expect(api.delete).not.toHaveBeenCalled()
  })

  test('pending is single-fire and non-dismissible; rejection stays open, retry focuses adjacent row', async () => {
    const first = deferred<unknown>()
    const { server } = renderAuthentication([
      provider('p1', 'First provider'),
      provider('p2', 'Second provider'),
    ])
    ;(api.delete as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(async () => {
        server.rows = server.rows.filter((row) => row.id !== 'p1')
        return {}
      })

    fireEvent.click(await screen.findByTestId('oidc-delete-p1'))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Delete' }) as HTMLButtonElement
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(1))
    expect(api.delete).toHaveBeenCalledWith('/api/oidc/providers/p1')
    await waitFor(() => {
      expect(confirm.disabled).toBe(true)
      expect(cancel.disabled).toBe(true)
    })
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBe(dialog)

    await act(async () => {
      first.reject(new Error('provider is in use'))
      try {
        await first.promise
      } catch {
        // ConfirmDialog owns and renders the rejected mutation.
      }
    })
    expect((await within(dialog).findByRole('alert')).textContent).toContain('provider is in use')
    expect(screen.getByRole('dialog')).toBe(dialog)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByTestId('oidc-delete-p1')).toBeNull()
      expect(document.activeElement).toBe(screen.getByTestId('oidc-edit-p2'))
    })
    expect(api.delete).toHaveBeenCalledTimes(2)
    expect(api.delete).toHaveBeenLastCalledWith('/api/oidc/providers/p1')
  })

  test('successful deletion of the only row restores focus to Add provider', async () => {
    const { server } = renderAuthentication([provider('p1', 'Only provider')])
    ;(api.delete as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      server.rows = []
      return {}
    })

    fireEvent.click(await screen.findByTestId('oidc-delete-p1'))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    )

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(screen.getByTestId('oidc-add-provider'))
    })
  })

  test('successful deletion resolves a fresh adjacent focus target after concurrent row removal', async () => {
    const { client, server } = renderAuthentication([
      provider('p1', 'First provider'),
      provider('p2', 'Second provider'),
      provider('p3', 'Third provider'),
    ])
    ;(api.delete as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      server.rows = server.rows.filter((row) => row.id !== 'p1' && row.id !== 'p2')
      return {}
    })

    fireEvent.click(await screen.findByTestId('oidc-delete-p1'))
    const dialog = await screen.findByRole('dialog')
    act(() => {
      server.rows = server.rows.filter((row) => row.id !== 'p2')
      client.setQueryData<Provider[]>(['oidc-providers'], server.rows.slice())
    })
    await waitFor(() => expect(screen.queryByTestId('oidc-edit-p2')).toBeNull())

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(screen.getByTestId('oidc-edit-p3'))
    })
  })

  test('successful deletion awaits server-only concurrent removals before restoring focus', async () => {
    const { server } = renderAuthentication([
      provider('p1', 'First provider'),
      provider('p2', 'Second provider'),
    ])
    ;(api.delete as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // p2 disappeared on the server while the confirmation was open, but the
      // local cache has not observed that removal yet.
      server.rows = []
      return {}
    })

    fireEvent.click(await screen.findByTestId('oidc-delete-p1'))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }),
    )

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.queryByTestId('oidc-edit-p2')).toBeNull()
      expect(document.activeElement).toBe(screen.getByTestId('oidc-add-provider'))
    })
  })

  test('provider editor fields use shared Field/TextInput/Switch rendering', async () => {
    renderAuthentication([])
    fireEvent.click(await screen.findByTestId('oidc-add-provider'))
    const dialog = await screen.findByRole('dialog')

    for (const name of [
      'Slug',
      'Display name',
      'Issuer URL',
      'Client ID',
      'Client secret',
      'Scopes',
    ]) {
      const label = within(dialog).getByText(name, {
        selector: '.form-field__label',
        exact: false,
      })
      const input = label.closest('label')?.querySelector('input')
      expect(input).toBeTruthy()
      if (input === null || input === undefined) throw new Error(`missing input for ${name}`)
      expect(input.classList.contains('form-input')).toBe(true)
      expect(input.closest('.form-field')).toBeTruthy()
    }
    const provisioning = within(dialog).getByRole('combobox', { name: 'Provisioning policy' })
    expect(provisioning.closest('.form-field')).toBeTruthy()
    fireEvent.click(provisioning)
    fireEvent.mouseDown(await screen.findByRole('option', { name: /^allowlist/ }))
    const allowedDomainsLabel = within(dialog).getByText('Allowed email domains', {
      selector: '.form-field__label',
    })
    expect(
      allowedDomainsLabel
        .closest('label')
        ?.querySelector('input')
        ?.classList.contains('form-input'),
    ).toBe(true)
    const enabled = within(dialog).getByRole('checkbox', { name: /Enabled/ })
    expect(enabled.closest('.form-switch')).toBeTruthy()
  })
})
