import type { CachedRepo, Permission, RepoGroup } from '@agent-workflow/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import '../src/i18n'
import { ACTOR_QUERY_KEY } from '../src/hooks/useActor'
import { ReposRoute, hasRepoPermissionAtRequest, validateReposSearch } from '../src/routes/repos'
import { setBaseUrl, setToken } from '../src/stores/auth'

const cachedRepo: CachedRepo = {
  id: 'repo-1',
  urlRedacted: 'https://example.test/org/repo-1.git',
  localPath: '/cache/repo-1',
  defaultBranch: 'main',
  lastFetchedAt: '2026-08-01T00:00:00.000Z',
  lastAutoRefreshAt: null,
  createdAt: '2026-07-01T00:00:00.000Z',
  referencingTaskCount: 2,
  hasSubmodules: false,
  lastSubmoduleSyncOk: null,
  lastSubmoduleSyncError: null,
}

const repoGroup: RepoGroup = {
  id: 'group-1',
  name: 'Browseable group',
  description: 'read users can still inspect this group',
  version: 1,
  schemaVersion: 2,
  createdByUserId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  nodes: [{ path: '', attachment: null }],
  directNodeCount: 1,
  flatRepoCount: 0,
  boundMemories: 0,
}

interface RecordedCall {
  pathname: string
  search: string
  method: string
}

interface FetchControl {
  nextAuthResponse?: Promise<Response>
  groupDeleteResponses?: Array<Response | Promise<Response>>
}

function actorPayload(permissions: readonly Permission[]) {
  return { permissions: [...permissions] }
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

function installFetch(
  permissions: readonly Permission[] | null,
  control: FetchControl = {},
): RecordedCall[] {
  const calls: RecordedCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request.toString())
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ pathname: url.pathname, search: url.search, method })

      if (url.pathname === '/api/auth/me' && control.nextAuthResponse !== undefined) {
        const response = control.nextAuthResponse
        control.nextAuthResponse = undefined
        return await response
      }
      if (
        url.pathname === '/api/repo-groups/group-1' &&
        method === 'DELETE' &&
        (control.groupDeleteResponses?.length ?? 0) > 0
      ) {
        return await control.groupDeleteResponses!.shift()!
      }

      let body: unknown = { ok: true }
      if (url.pathname === '/api/auth/me') {
        body = permissions === null ? { source: 'session' } : actorPayload(permissions)
      } else if (url.pathname === '/api/cached-repos' && method === 'GET') {
        body = { items: [cachedRepo] }
      } else if (url.pathname === '/api/repo-groups' && method === 'GET') {
        body = { items: [repoGroup] }
      } else if (url.pathname.endsWith('/layout')) {
        body = { nodes: [{ path: '', origins: [] }], repos: [] }
      } else if (url.pathname === '/api/repo-groups/preview') {
        body = { totalNodes: 1, totalRepos: 1, pendingImports: 0, nodes: [], repos: [] }
      }

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  )
  return calls
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const reposRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/repos',
    validateSearch: validateReposSearch,
    component: ReposRoute.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([reposRoute]),
    history: createMemoryHistory({ initialEntries: ['/repos?tab=repos'] }),
  })
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { client }
}

async function waitForActor(client: QueryClient): Promise<void> {
  await waitFor(() => expect(client.getQueryData([...ACTOR_QUERY_KEY, 'tok'])).toBeTruthy())
}

function setPermissions(client: QueryClient, permissions: readonly Permission[]): void {
  act(() => client.setQueryData([...ACTOR_QUERY_KEY, 'tok'], actorPayload(permissions)))
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  localStorage.removeItem('repo-import-batch-id')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('/repos permission matrix', () => {
  test('read-only actors can browse repositories and groups without any write request', async () => {
    const calls = installFetch(['repos:read'])
    const { client } = renderPage()

    await screen.findByTestId('repos-row-repo-1')
    await waitForActor(client)
    expect(screen.queryByTestId('repos-batch-import-button')).toBeNull()
    expect(screen.queryByTestId('repos-refresh-repo-1')).toBeNull()
    expect(screen.queryByTestId('repos-delete-repo-1')).toBeNull()

    fireEvent.click(screen.getByTestId('repos-tab-groups'))
    await screen.findByTestId('repo-group-row-group-1')
    expect(screen.queryByTestId('repo-groups-new')).toBeNull()
    expect(screen.queryByTestId('repo-group-edit-group-1')).toBeNull()
    expect(screen.queryByTestId('repo-group-delete-group-1')).toBeNull()

    fireEvent.click(screen.getByTestId('repo-group-expand-group-1'))
    await screen.findByTestId('repo-group-layout-group-1')
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([])
  })

  test('malformed /me payload fails closed while preserving read rendering', async () => {
    const calls = installFetch(null)
    const { client } = renderPage()

    await screen.findByTestId('repos-row-repo-1')
    await waitForActor(client)
    expect(screen.queryByTestId('repos-batch-import-button')).toBeNull()
    expect(screen.queryByTestId('repos-refresh-repo-1')).toBeNull()
    expect(screen.queryByTestId('repos-delete-repo-1')).toBeNull()
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([])
  })

  test('cached permissions fail closed while /me refetches and after that refetch errors', async () => {
    const permissions: Permission[] = ['repos:read', 'repos:execute', 'repos:delete']
    const control: FetchControl = {}
    const calls = installFetch(permissions, control)
    const { client } = renderPage()
    await screen.findByTestId('repos-refresh-repo-1')
    await waitForActor(client)

    const staleRefresh = screen.getByTestId('repos-refresh-repo-1')
    const nativeClick = vi.fn()
    staleRefresh.addEventListener('click', nativeClick)
    const authResponse = deferred<Response>()
    control.nextAuthResponse = authResponse.promise
    let refetchPromise!: Promise<void>

    act(() => {
      refetchPromise = client.refetchQueries({ queryKey: ACTOR_QUERY_KEY })
      expect(client.getQueryState([...ACTOR_QUERY_KEY, 'tok'])?.fetchStatus).toBe('fetching')
      // The old control is intentionally still connected: this proves its
      // React handler runs in the render-lag window rather than passing only
      // because a detached node no longer bubbles to the React root.
      expect(staleRefresh.isConnected).toBe(true)
      fireEvent.click(staleRefresh)
    })
    expect(nativeClick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId('repos-refresh-repo-1')).toBeNull())
    expect(calls.filter((call) => call.pathname.endsWith('/refresh'))).toEqual([])

    await act(async () => {
      authResponse.reject(new Error('auth service unavailable'))
      await refetchPromise.catch(() => {})
    })
    expect(client.getQueryState([...ACTOR_QUERY_KEY, 'tok'])?.status).toBe('error')
    // React Query deliberately retains the last successful data on a refetch
    // error; the request-boundary predicate must still reject it.
    expect(client.getQueryData([...ACTOR_QUERY_KEY, 'tok'])).toEqual(actorPayload(permissions))
    expect(hasRepoPermissionAtRequest(client, 'repos:execute')).toBe(false)
    expect(screen.queryByTestId('repos-refresh-repo-1')).toBeNull()
    expect(screen.queryByTestId('repos-delete-repo-1')).toBeNull()
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([])
  })

  test.each([
    {
      permission: 'repos:create' as const,
      batchAction: 'create',
      refresh: false,
      repoDelete: false,
      newGroup: true,
      editGroup: false,
      deleteGroup: false,
    },
    {
      permission: 'repos:update' as const,
      batchAction: null,
      refresh: false,
      repoDelete: false,
      newGroup: false,
      editGroup: true,
      deleteGroup: false,
    },
    {
      permission: 'repos:delete' as const,
      batchAction: null,
      refresh: false,
      repoDelete: true,
      newGroup: false,
      editGroup: false,
      deleteGroup: true,
    },
    {
      permission: 'repos:execute' as const,
      batchAction: 'retry',
      refresh: true,
      repoDelete: false,
      newGroup: false,
      editGroup: false,
      deleteGroup: false,
    },
  ])('$permission exposes only its own controls', async (expected) => {
    if (expected.permission === 'repos:execute') localStorage.setItem('repo-import-batch-id', 'b1')
    installFetch(['repos:read', expected.permission])
    const { client } = renderPage()

    await screen.findByTestId('repos-row-repo-1')
    await waitForActor(client)
    const batchAction = screen.queryByTestId('repos-batch-import-button')
    expect(batchAction?.getAttribute('data-repo-action') ?? null).toBe(expected.batchAction)
    expect(screen.queryByTestId('repos-refresh-repo-1') !== null).toBe(expected.refresh)
    expect(screen.queryByTestId('repos-delete-repo-1') !== null).toBe(expected.repoDelete)

    fireEvent.click(screen.getByTestId('repos-tab-groups'))
    await screen.findByTestId('repo-group-row-group-1')
    expect(screen.queryByTestId('repo-groups-new') !== null).toBe(expected.newGroup)
    expect(screen.queryByTestId('repo-group-edit-group-1') !== null).toBe(expected.editGroup)
    expect(screen.queryByTestId('repo-group-delete-group-1') !== null).toBe(expected.deleteGroup)
  })
})

describe('/repos runtime permission downgrade', () => {
  const allPermissions: Permission[] = [
    'repos:read',
    'repos:create',
    'repos:update',
    'repos:delete',
    'repos:execute',
  ]

  test('closes create, update, and delete dialogs as soon as their grant disappears', async () => {
    const calls = installFetch(allPermissions)
    const { client } = renderPage()
    await screen.findByTestId('repos-row-repo-1')
    await waitForActor(client)

    fireEvent.click(screen.getByTestId('repos-batch-import-button'))
    expect(await screen.findByTestId('batch-import-dialog')).toBeTruthy()
    fireEvent.change(screen.getByTestId('batch-import-textarea'), {
      target: { value: 'https://example.test/new.git' },
    })
    const staleStart = screen.getByTestId('batch-import-start')
    const startClick = vi.fn()
    staleStart.addEventListener('click', startClick)
    act(() => {
      client.setQueryData(
        [...ACTOR_QUERY_KEY, 'tok'],
        actorPayload(allPermissions.filter((permission) => permission !== 'repos:create')),
      )
      expect(staleStart.isConnected).toBe(true)
      fireEvent.click(staleStart)
    })
    expect(startClick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId('batch-import-dialog')).toBeNull())
    expect(calls.filter((call) => call.pathname === '/api/cached-repos/batch-import')).toEqual([])

    setPermissions(client, allPermissions)
    fireEvent.click(screen.getByTestId('repos-tab-groups'))
    await screen.findByTestId('repo-group-row-group-1')

    fireEvent.click(screen.getByTestId('repo-groups-new'))
    expect(await screen.findByTestId('repo-group-editor-dialog')).toBeTruthy()
    setPermissions(
      client,
      allPermissions.filter((permission) => permission !== 'repos:create'),
    )
    await waitFor(() => expect(screen.queryByTestId('repo-group-editor-dialog')).toBeNull())

    setPermissions(client, allPermissions)
    fireEvent.click(await screen.findByTestId('repo-group-edit-group-1'))
    expect(await screen.findByTestId('repo-group-editor-dialog')).toBeTruthy()
    const staleSave = screen.getByTestId('repo-group-save') as HTMLButtonElement
    await waitFor(() => expect(staleSave.disabled).toBe(false))
    const saveClick = vi.fn()
    staleSave.addEventListener('click', saveClick)
    act(() => {
      client.setQueryData(
        [...ACTOR_QUERY_KEY, 'tok'],
        actorPayload(allPermissions.filter((permission) => permission !== 'repos:update')),
      )
      expect(staleSave.isConnected).toBe(true)
      fireEvent.click(staleSave)
    })
    expect(saveClick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId('repo-group-editor-dialog')).toBeNull())
    expect(
      calls.filter((call) => call.pathname === '/api/repo-groups/group-1' && call.method === 'PUT'),
    ).toEqual([])

    setPermissions(client, allPermissions)
    fireEvent.click(await screen.findByTestId('repo-group-delete-group-1'))
    await waitFor(() => expect(document.querySelector('.confirm-dialog')).not.toBeNull())
    const staleGroupDelete = document.querySelector(
      '.confirm-dialog .btn--danger',
    ) as HTMLButtonElement
    const groupDeleteClick = vi.fn()
    staleGroupDelete.addEventListener('click', groupDeleteClick)
    act(() => {
      client.setQueryData(
        [...ACTOR_QUERY_KEY, 'tok'],
        actorPayload(allPermissions.filter((permission) => permission !== 'repos:delete')),
      )
      expect(staleGroupDelete.isConnected).toBe(true)
      fireEvent.click(staleGroupDelete)
    })
    expect(groupDeleteClick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.querySelector('.confirm-dialog')).toBeNull())
    expect(
      calls.filter(
        (call) => call.pathname === '/api/repo-groups/group-1' && call.method === 'DELETE',
      ),
    ).toEqual([])

    setPermissions(client, allPermissions)
    fireEvent.click(screen.getByTestId('repos-tab-repos'))
    fireEvent.click(await screen.findByTestId('repos-delete-repo-1'))
    expect(await screen.findByTestId('repos-delete-confirm')).toBeTruthy()
    const staleRepoDelete = screen.getByTestId('repos-delete-confirm-action')
    const repoDeleteClick = vi.fn()
    staleRepoDelete.addEventListener('click', repoDeleteClick)
    act(() => {
      client.setQueryData(
        [...ACTOR_QUERY_KEY, 'tok'],
        actorPayload(allPermissions.filter((permission) => permission !== 'repos:delete')),
      )
      expect(staleRepoDelete.isConnected).toBe(true)
      fireEvent.click(staleRepoDelete)
    })
    expect(repoDeleteClick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId('repos-delete-confirm')).toBeNull())
    expect(
      calls.filter(
        (call) => call.pathname === '/api/cached-repos/repo-1' && call.method === 'DELETE',
      ),
    ).toEqual([])
  })

  test('group delete 409 keeps the named target open and force retry sends exactly one second request', async () => {
    const control: FetchControl = {
      groupDeleteResponses: [
        new Response(
          JSON.stringify({
            ok: false,
            code: 'repo-group-has-references',
            message: 'group is referenced',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
        new Response(
          JSON.stringify({
            ok: true,
            archivedMemories: 0,
            detachedReferences: 1,
            disabledSchedules: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ],
    }
    const calls = installFetch(allPermissions, control)
    const { client } = renderPage()
    await waitForActor(client)
    fireEvent.click(screen.getByTestId('repos-tab-groups'))
    await screen.findByTestId('repo-group-delete-group-1')
    fireEvent.click(screen.getByTestId('repo-group-delete-group-1'))
    const dialog = document.querySelector('.confirm-dialog') as HTMLElement
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))

    const force = await screen.findByRole('button', { name: 'Force delete' })
    const forceDialog = document.querySelector('.confirm-dialog') as HTMLElement
    expect(dialog.isConnected).toBe(false)
    expect(within(forceDialog).getByText(/Browseable group/)).toBeTruthy()
    expect(within(forceDialog).queryByRole('alert')).toBeNull()
    expect(
      calls.filter(
        (call) => call.pathname === '/api/repo-groups/group-1' && call.method === 'DELETE',
      ),
    ).toHaveLength(1)

    fireEvent.click(force)
    await screen.findByTestId('repo-group-delete-report')
    await waitFor(() => expect(document.querySelector('.confirm-dialog')).toBeNull())
    expect(
      calls
        .filter((call) => call.pathname === '/api/repo-groups/group-1' && call.method === 'DELETE')
        .map((call) => call.search),
    ).toEqual(['', '?force=1'])
  })

  test('delete downgrade closes a 409 force session and its connected stale force handler is inert', async () => {
    const control: FetchControl = {
      groupDeleteResponses: [
        new Response(
          JSON.stringify({
            ok: false,
            code: 'repo-group-has-references',
            message: 'group is referenced',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ],
    }
    const calls = installFetch(allPermissions, control)
    const { client } = renderPage()
    await waitForActor(client)
    fireEvent.click(screen.getByTestId('repos-tab-groups'))
    await screen.findByTestId('repo-group-delete-group-1')
    fireEvent.click(screen.getByTestId('repo-group-delete-group-1'))
    fireEvent.click(
      within(document.querySelector('.confirm-dialog') as HTMLElement).getByRole('button', {
        name: 'Delete',
      }),
    )
    const staleForce = await screen.findByRole('button', { name: 'Force delete' })
    const forceClick = vi.fn()
    staleForce.addEventListener('click', forceClick)

    act(() => {
      client.setQueryData(
        [...ACTOR_QUERY_KEY, 'tok'],
        actorPayload(allPermissions.filter((permission) => permission !== 'repos:delete')),
      )
      expect(staleForce.isConnected).toBe(true)
      fireEvent.click(staleForce)
    })
    expect(forceClick).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.querySelector('.confirm-dialog')).toBeNull())
    expect(
      calls.filter(
        (call) => call.pathname === '/api/repo-groups/group-1' && call.method === 'DELETE',
      ),
    ).toHaveLength(1)
  })

  test('an in-flight 409 callback after delete downgrade cannot restore force UI or stale errors', async () => {
    const deleteResponse = deferred<Response>()
    const control: FetchControl = { groupDeleteResponses: [deleteResponse.promise] }
    const calls = installFetch(allPermissions, control)
    const { client } = renderPage()
    await waitForActor(client)
    fireEvent.click(screen.getByTestId('repos-tab-groups'))
    await screen.findByTestId('repo-group-delete-group-1')
    fireEvent.click(screen.getByTestId('repo-group-delete-group-1'))
    fireEvent.click(
      within(document.querySelector('.confirm-dialog') as HTMLElement).getByRole('button', {
        name: 'Delete',
      }),
    )
    await waitFor(() =>
      expect(
        calls.filter(
          (call) => call.pathname === '/api/repo-groups/group-1' && call.method === 'DELETE',
        ),
      ).toHaveLength(1),
    )

    setPermissions(
      client,
      allPermissions.filter((permission) => permission !== 'repos:delete'),
    )
    await waitFor(() => expect(document.querySelector('.confirm-dialog')).toBeNull())

    await act(async () => {
      deleteResponse.resolve(
        new Response(
          JSON.stringify({
            ok: false,
            code: 'repo-group-has-references',
            message: 'group is referenced',
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      )
      await deleteResponse.promise
    })

    expect(screen.queryByRole('button', { name: 'Force delete' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    setPermissions(client, allPermissions)
    await screen.findByTestId('repo-group-delete-group-1')
    expect(screen.queryByRole('button', { name: 'Force delete' })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      calls.filter(
        (call) => call.pathname === '/api/repo-groups/group-1' && call.method === 'DELETE',
      ),
    ).toHaveLength(1)
  })

  test('connected stale refresh and delete handlers cannot dispatch in the render-lag window', async () => {
    const calls = installFetch(allPermissions)
    const { client } = renderPage()
    await screen.findByTestId('repos-row-repo-1')
    await waitForActor(client)
    const staleRefresh = screen.getByTestId('repos-refresh-repo-1')
    const staleDelete = screen.getByTestId('repos-delete-repo-1')
    const refreshClick = vi.fn()
    const deleteClick = vi.fn()
    staleRefresh.addEventListener('click', refreshClick)
    staleDelete.addEventListener('click', deleteClick)

    act(() => {
      client.setQueryData([...ACTOR_QUERY_KEY, 'tok'], actorPayload(['repos:read']))
      expect(staleRefresh.isConnected).toBe(true)
      expect(staleDelete.isConnected).toBe(true)
      fireEvent.click(staleRefresh)
      fireEvent.click(staleDelete)
    })
    expect(refreshClick).toHaveBeenCalledTimes(1)
    expect(deleteClick).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.queryByTestId('repos-refresh-repo-1')).toBeNull()
      expect(screen.queryByTestId('repos-delete-repo-1')).toBeNull()
    })

    expect(
      calls.filter(
        (call) =>
          call.pathname.includes('/refresh') ||
          (call.pathname === '/api/cached-repos/repo-1' && call.method === 'DELETE'),
      ),
    ).toEqual([])
  })
})
