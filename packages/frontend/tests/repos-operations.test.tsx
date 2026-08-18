// RFC-246 — populated /repos behavior: business views and filters must not
// regress the existing refresh/delete mutations.

import type { CachedRepo } from '@agent-workflow/shared'
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

vi.mock('@/components/repos/RepoGroupEditor', () => ({
  RepoGroupEditor: ({ open }: { open: boolean }) => (
    <div data-testid="repo-group-editor-stub" data-open={String(open)} />
  ),
}))

import '../src/i18n'
import {
  filterRepoOperations,
  repoOperationsFacets,
  type RepoAutoRefreshFilter,
  type RepoOperationsView,
  type RepoSubmoduleFilter,
} from '../src/lib/operations-filters'
import {
  ReposRoute,
  shouldNormalizeRepoResourceLocation,
  validateReposSearch,
} from '../src/routes/repos'
import { setBaseUrl, setToken } from '../src/stores/auth'

function repo(id: string, overrides: Partial<CachedRepo> = {}): CachedRepo {
  return {
    id,
    urlRedacted: `git@example.com/org/${id}.git`,
    localPath: `/cache/${id}`,
    defaultBranch: 'main',
    lastFetchedAt: '2026-08-01T00:00:00.000Z',
    lastAutoRefreshAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    referencingTaskCount: 0,
    hasSubmodules: false,
    lastSubmoduleSyncOk: null,
    lastSubmoduleSyncError: null,
    ...overrides,
  }
}

interface RecordedCall {
  url: string
  method: string
}

function installFetch(items: CachedRepo[]): RecordedCall[] {
  const calls: RecordedCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = request.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      calls.push({ url, method })
      const parsed = new URL(url)
      // RFC-311 T28:页面走服务端分页封套;mock 用 lib 的 filterRepoOperations /
      // repoOperationsFacets 充当服务端语义参考实现(与后端 oracle 同源)。
      const isPagedList =
        parsed.pathname === '/api/cached-repos' &&
        method === 'GET' &&
        parsed.searchParams.has('limit')
      const body = url.endsWith('/api/auth/me')
        ? {
            permissions: [
              'repos:read',
              'repos:create',
              'repos:update',
              'repos:delete',
              'repos:execute',
            ],
          }
        : isPagedList
          ? {
              items: filterRepoOperations(items, {
                view: (parsed.searchParams.get('view') ?? 'all') as RepoOperationsView,
                q: parsed.searchParams.get('q') ?? '',
                submodules: (parsed.searchParams.get('submodules') ?? 'all') as RepoSubmoduleFilter,
                autoRefresh: (parsed.searchParams.get('auto_refresh') ??
                  'all') as RepoAutoRefreshFilter,
              }),
              nextCursor: null,
              facets: repoOperationsFacets(items),
            }
          : method === 'GET'
            ? { items }
            : { ok: true }
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
  const memoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/memory',
    validateSearch: (search: Record<string, unknown>) => ({
      ...(search.tab === 'all' ? { tab: 'all' as const } : {}),
    }),
    component: () => <h1>Memory Library</h1>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([reposRoute, memoryRoute]),
    history: createMemoryHistory({ initialEntries: ['/repos?tab=repos'] }),
  })
  render(
    <QueryClientProvider client={client}>
      {/* The focused test tree intentionally differs from the generated app tree. */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return { client, router }
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

describe('/repos operations surface (RFC-246)', () => {
  test('normalizes invalid tabs only while the committed route is /repos', () => {
    expect(shouldNormalizeRepoResourceLocation('/repos', '/repos?tab=all')).toBe(true)
    expect(shouldNormalizeRepoResourceLocation('/memory', '/memory?tab=all')).toBe(false)
  })

  test('does not replace a committed Memory navigation back to /repos', async () => {
    installFetch([])
    const { router } = renderPage()
    await screen.findByTestId('repos-empty')

    await act(async () => {
      await router.navigate({ to: '/memory', search: { tab: 'all' } })
    })

    await screen.findByRole('heading', { name: 'Memory Library' })
    expect(router.state.location.href).toBe('/memory?tab=all')
  })

  test('keeps the route-owned editor unmounted until the user opens it', async () => {
    installFetch([])
    renderPage()

    await screen.findByTestId('repos-empty')
    expect(screen.queryByTestId('repo-group-editor-stub')).toBeNull()

    fireEvent.click(screen.getByTestId('repos-tab-groups'))
    await screen.findByTestId('repo-groups-empty')
    fireEvent.click(screen.getAllByTestId('repo-groups-new')[0]!)
    expect((await screen.findByTestId('repo-group-editor-stub')).getAttribute('data-open')).toBe(
      'true',
    )
  })

  test('business views, search, and submodule filter compose', async () => {
    installFetch([
      repo('used', { referencingTaskCount: 2 }),
      repo('attention', {
        defaultBranch: 'release/next',
        hasSubmodules: true,
        lastSubmoduleSyncOk: false,
        lastSubmoduleSyncError: 'boom',
      }),
      repo('unused'),
    ])
    renderPage()
    await screen.findByTestId('repos-row-used')

    // RFC-311 T28:过滤/搜索下推服务端后,切换是异步往返(keepPreviousData
    // 保留旧行直到新页返回)——断言改为等待收敛;搜索经 350ms 去抖。
    fireEvent.click(screen.getByTestId('repos-view-referenced'))
    await waitFor(() => expect(screen.queryByTestId('repos-row-unused')).toBeNull())
    expect(screen.getByTestId('repos-row-used')).toBeTruthy()

    fireEvent.click(screen.getByTestId('repos-view-all'))
    fireEvent.change(screen.getByTestId('repos-search'), { target: { value: 'release/next' } })
    await waitFor(() => expect(screen.queryByTestId('repos-row-used')).toBeNull(), {
      timeout: 3000,
    })
    expect(screen.getByTestId('repos-row-attention')).toBeTruthy()

    fireEvent.change(screen.getByTestId('repos-search'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('repos-filter-button'))
    const dialog = await screen.findByTestId('repos-filter-dialog')
    fireEvent.click(within(dialog).getByRole('radio', { name: 'With' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply filters' }))
    await waitFor(() => expect(screen.queryByTestId('repos-row-unused')).toBeNull(), {
      timeout: 3000,
    })
    expect(screen.getByTestId('repos-row-attention')).toBeTruthy()
  })

  test('refresh, direct delete, and referenced force-delete keep their endpoints', async () => {
    const calls = installFetch([repo('unused'), repo('used', { referencingTaskCount: 2 })])
    const { client } = renderPage()
    await screen.findByTestId('repos-row-unused')

    const unused = screen.getByTestId('repos-row-unused')
    fireEvent.click(within(unused).getByRole('button', { name: 'Refresh' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: 'http://daemon.test/api/cached-repos/unused/refresh',
        method: 'POST',
      }),
    )
    // Avoid the successful refresh invalidation racing the delete assertion.
    await client.cancelQueries({ queryKey: ['cached-repos'] })
    fireEvent.click(within(unused).getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: 'http://daemon.test/api/cached-repos/unused',
        method: 'DELETE',
      }),
    )

    const used = screen.getByTestId('repos-row-used')
    fireEvent.click(within(used).getByRole('button', { name: 'Delete' }))
    const confirm = await screen.findByTestId('repos-delete-confirm')
    fireEvent.click(within(confirm).getByTestId('repos-delete-confirm-action'))
    await waitFor(() =>
      expect(calls).toContainEqual({
        url: 'http://daemon.test/api/cached-repos/used?force=1',
        method: 'DELETE',
      }),
    )
  })
})
