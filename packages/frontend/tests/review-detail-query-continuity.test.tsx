// RFC-198 PR4 — review detail query continuity regression coverage.
//
// These tests exist because React Query can expose `error` and previously loaded
// `data` at the same time after a background refetch fails. The review routes
// used to treat every error as a full-page failure, hiding the document and its
// decision controls even though usable cached data was still available.

import type { ReactNode } from 'react'
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
import type {
  DocVersion,
  DocVersionWithBodyAndComments,
  ReviewDetail,
} from '@agent-workflow/shared'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  }
})

vi.mock('../src/hooks/useTaskSync', () => ({ useTaskSync: () => {} }))
vi.mock('../src/components/shell/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import { api } from '../src/api/client'
import i18n from '../src/i18n'
import { Route as RootRoute } from '../src/routes/__root'
import { Route as ReviewRoute } from '../src/routes/reviews.detail'
import { MultiDocReviewView } from '../src/components/review/MultiDocReviewView'
import { clearToken, setToken } from '../src/stores/auth'

function doc(id: string): DocVersion {
  return {
    id,
    taskId: 'task-1',
    reviewNodeId: 'review-node',
    reviewNodeRunId: 'run',
    sourceNodeId: 'source-node',
    sourcePortName: 'document',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: `runs/task-1/${id}.md`,
    commentsJson: '[]',
    decision: 'pending',
    decisionReason: null,
    promptSnapshot: null,
    createdAt: 0,
    decidedAt: null,
    decidedBy: null,
  }
}

function makeDetail(multi: boolean): ReviewDetail {
  return {
    summary: {
      nodeRunId: 'run',
      taskId: 'task-1',
      taskName: 'Example task',
      workflowId: 'workflow-1',
      workflowName: 'Example workflow',
      reviewNodeId: 'review-node',
      title: 'Review document',
      description: 'Check the generated document.',
      currentVersionIndex: 1,
      reviewIteration: 0,
      decision: 'pending',
      awaitingReview: true,
      shardKey: null,
      isMultiDoc: multi,
      createdAt: 0,
      decidedAt: null,
    },
    currentVersion: doc('doc-1'),
    currentBody: '# Cached review document\n\nStill available.',
    comments: [],
    rerunnableOnReject: [],
    rerunnableOnIterate: [],
    ...(multi
      ? {
          documents: [
            {
              docVersionId: 'doc-1',
              itemIndex: 0,
              itemPath: 'doc-1.md',
              title: 'Cached document',
              selection: 'unselected' as const,
              commentCount: 0,
            },
          ],
        }
      : {}),
  }
}

function makeDiffDetail(): ReviewDetail {
  const detail = makeDetail(false)
  return {
    ...detail,
    summary: { ...detail.summary, currentVersionIndex: 2 },
    currentVersion: { ...detail.currentVersion, versionIndex: 2 },
    currentBody: '# Current version\n\nnew text',
  }
}

function versionBody(id: string, body: string): DocVersionWithBodyAndComments {
  return {
    ...doc(id),
    versionIndex: 1,
    decision: 'iterated',
    body,
    comments: [],
  }
}

function queryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnMount: 'always' } },
  })
}

const taskStub = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/$id',
  component: () => null,
})
const reviewRouteTree = RootRoute.addChildren([ReviewRoute, taskStub])

function renderSingle(client = queryClient(), initialEntry = '/reviews/run') {
  const router = createRouter({
    routeTree: reviewRouteTree,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  render(
    <QueryClientProvider client={client}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return client
}

function renderMulti(client = queryClient()) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <MultiDocReviewView nodeRunId="run" />,
  })
  const task = createRoute({
    getParentRoute: () => root,
    path: '/tasks/$id',
    component: () => null,
  })
  const router = createRouter({
    routeTree: root.addChildren([index, task]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return client
}

function detailRequestCount(): number {
  return (api.get as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([url]) => url === '/api/reviews/run',
  ).length
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setToken('test-token')
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.post as ReturnType<typeof vi.fn>).mockReset()
  ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([])
})

afterEach(() => {
  cleanup()
  clearToken()
})

describe('/reviews/$nodeRunId shared query states', () => {
  test('initial loading keeps a PageHeader visible', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<never>(() => {}))

    renderSingle()

    expect(await screen.findByRole('heading', { level: 1, name: 'run' })).toBeTruthy()
    expect(screen.getByTestId('loading-state')).toBeTruthy()
  })

  test('initial error keeps the PageHeader and exposes Retry', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'))

    renderSingle()

    expect(await screen.findByRole('heading', { level: 1, name: 'run' })).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('offline')
    const before = detailRequestCount()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(detailRequestCount()).toBeGreaterThan(before))
  })

  test('stale refetch error keeps the document, decision controls, and task heading', async () => {
    const client = queryClient()
    client.setQueryData(['reviews', 'detail', 'run'], makeDetail(false))
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('refresh failed'))

    renderSingle(client)

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: /Example task \/ Review document · v1/,
    })
    expect(heading.closest('header')?.classList.contains('page__header')).toBe(true)
    expect(screen.getByTestId('review-detail-task-link').getAttribute('href')).toBe('/tasks/task-1')
    expect(screen.getByText('Cached review document')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('refresh failed')
  })

  test('?version surfaces an initial version-list error and Retry without hiding a loaded body', async () => {
    const detail = makeDetail(false)
    const historical = versionBody('doc-old', '# Historical version\n\nold text')
    let versionsFail = true
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/reviews/run') return Promise.resolve(detail)
      if (url === '/api/reviews/run/versions') {
        return versionsFail
          ? Promise.reject(new Error('version list failed'))
          : Promise.resolve([historical, detail.currentVersion])
      }
      if (url === '/api/reviews/run/versions/doc-old') return Promise.resolve(historical)
      return Promise.resolve([])
    })

    renderSingle(queryClient(), '/reviews/run?version=doc-old')

    expect(await screen.findByText('Historical version')).toBeTruthy()
    const versionError = await screen.findByTestId('review-versions-error')
    expect(versionError.textContent).toContain('version list failed')
    versionsFail = false
    fireEvent.click(versionError.querySelector('button')!)
    await waitFor(() => expect(screen.queryByTestId('review-versions-error')).toBeNull())
    expect(screen.getByText('Historical version')).toBeTruthy()
  })

  test('?version body initial failure never falls back to current prose and Retry recovers', async () => {
    const detail = makeDetail(false)
    const historical = versionBody('doc-old', '# Historical recovered\n\nold text')
    let bodyFail = true
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/reviews/run') return Promise.resolve(detail)
      if (url === '/api/reviews/run/versions') {
        return Promise.resolve([historical, detail.currentVersion])
      }
      if (url === '/api/reviews/run/versions/doc-old') {
        return bodyFail
          ? Promise.reject(new Error('historical body failed'))
          : Promise.resolve(historical)
      }
      return Promise.resolve([])
    })

    renderSingle(queryClient(), '/reviews/run?version=doc-old')

    const bodyError = await screen.findByTestId('review-historical-body-error')
    expect(bodyError.textContent).toContain('historical body failed')
    expect(screen.queryByText('Cached review document')).toBeNull()
    bodyFail = false
    fireEvent.click(bodyError.querySelector('button')!)
    expect(await screen.findByText('Historical recovered')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  test('?version stale body error keeps cached historical prose and Retry refreshes in place', async () => {
    const client = queryClient()
    const detail = makeDetail(false)
    const historical = versionBody('doc-old', '# Cached historical\n\nold text')
    client.setQueryData(['reviews', 'detail', 'run'], detail)
    client.setQueryData(['reviews', 'versions', 'run'], [historical, detail.currentVersion])
    client.setQueryData(['reviews', 'version-body', 'run', 'doc-old'], historical)
    let bodyFail = true
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/reviews/run') return Promise.resolve(detail)
      if (url === '/api/reviews/run/versions') {
        return Promise.resolve([historical, detail.currentVersion])
      }
      if (url === '/api/reviews/run/versions/doc-old') {
        return bodyFail
          ? Promise.reject(new Error('historical refresh failed'))
          : Promise.resolve(historical)
      }
      return Promise.resolve([])
    })

    renderSingle(client, '/reviews/run?version=doc-old')

    expect(await screen.findByText('Cached historical')).toBeTruthy()
    const staleBodyError = await screen.findByTestId('review-historical-body-stale-error')
    expect(staleBodyError.textContent).toContain('historical refresh failed')
    bodyFail = false
    fireEvent.click(staleBodyError.querySelector('button')!)
    await waitFor(() =>
      expect(screen.queryByTestId('review-historical-body-stale-error')).toBeNull(),
    )
    expect(screen.getByText('Cached historical')).toBeTruthy()
  })

  test('diff version-list failure replaces current prose with ErrorBanner until Retry succeeds', async () => {
    const detail = makeDiffDetail()
    const prior = versionBody('doc-old', '# Prior version\n\nold text')
    let versionsFail = true
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/reviews/run') return Promise.resolve(detail)
      if (url === '/api/reviews/run/versions') {
        return versionsFail
          ? Promise.reject(new Error('diff versions failed'))
          : Promise.resolve([detail.currentVersion, prior])
      }
      if (url === '/api/reviews/run/versions/doc-old') return Promise.resolve(prior)
      return Promise.resolve([])
    })

    renderSingle()
    await screen.findByText('Current version')
    fireEvent.click(screen.getByRole('radio', { name: 'Word' }))

    const versionsError = await screen.findByTestId('review-diff-versions-error')
    expect(versionsError.textContent).toContain('diff versions failed')
    expect(screen.queryByText('Current version')).toBeNull()
    expect(document.querySelector('.diff-view')).toBeNull()
    versionsFail = false
    fireEvent.click(versionsError.querySelector('button')!)
    await waitFor(() => expect(document.querySelector('.diff-view')).not.toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test('diff stale body error preserves cached diff and Retry refreshes it in place', async () => {
    const client = queryClient()
    const detail = makeDiffDetail()
    const prior = versionBody('doc-old', '# Cached prior\n\nold text')
    client.setQueryData(['reviews', 'detail', 'run'], detail)
    client.setQueryData(['reviews', 'versions', 'run'], [detail.currentVersion, prior])
    client.setQueryData(['reviews', 'version-body', 'run', 'doc-old'], prior)
    let bodyFail = true
    ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/reviews/run') return Promise.resolve(detail)
      if (url === '/api/reviews/run/versions') {
        return Promise.resolve([detail.currentVersion, prior])
      }
      if (url === '/api/reviews/run/versions/doc-old') {
        return bodyFail
          ? Promise.reject(new Error('diff body refresh failed'))
          : Promise.resolve(prior)
      }
      return Promise.resolve([])
    })

    renderSingle(client)
    await screen.findByText('Current version')
    fireEvent.click(screen.getByRole('radio', { name: 'Word' }))

    await waitFor(() => expect(document.querySelector('.diff-view')).not.toBeNull())
    const staleDiffError = await screen.findByTestId('review-diff-body-stale-error')
    expect(staleDiffError.textContent).toContain('diff body refresh failed')
    bodyFail = false
    fireEvent.click(staleDiffError.querySelector('button')!)
    await waitFor(() => expect(screen.queryByTestId('review-diff-body-stale-error')).toBeNull())
    expect(document.querySelector('.diff-view')).not.toBeNull()
  })
})

describe('MultiDocReviewView shared query states', () => {
  test('initial error keeps a PageHeader and exposes Retry', async () => {
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'))

    renderMulti()

    expect(await screen.findByRole('heading', { level: 1, name: 'Reviews' })).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('offline')
    const before = detailRequestCount()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(detailRequestCount()).toBeGreaterThan(before))
  })

  test('stale refetch error keeps the document navigator and round decisions visible', async () => {
    const client = queryClient()
    client.setQueryData(['reviews', 'detail', 'run'], makeDetail(true))
    ;(api.get as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('refresh failed'))

    renderMulti(client)

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'Example task / Review document',
    })
    expect(heading.closest('header')?.classList.contains('page__header')).toBe(true)
    expect(screen.getByTestId('review-multidoc-task-link').getAttribute('href')).toBe(
      '/tasks/task-1',
    )
    expect(screen.getByText('Cached document')).toBeTruthy()
    expect(screen.getByTestId('multidoc-approve')).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toContain('refresh failed')
  })
})
