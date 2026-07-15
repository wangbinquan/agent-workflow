// RFC-198 PR5 — unknown review version/round search values canonicalize with
// replace and surface a one-shot in-app warning that cannot replay from history.

import { StrictMode, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DocVersion, ReviewDetail, ReviewRoundSummary } from '@agent-workflow/shared'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  }
})
vi.mock('../src/hooks/useTaskSync', () => ({ useTaskSync: () => {} }))
vi.mock('../src/components/shell/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('../src/components/review/ReviewDocPane', () => ({
  ReviewDocPane: ({ body }: { body?: string }) => (
    <div data-testid="review-body">{body?.replace(/^# /, '')}</div>
  ),
}))

import { api } from '../src/api/client'
import i18n from '../src/i18n'
import { Route as RootRoute } from '../src/routes/__root'
import { Route as ReviewRoute } from '../src/routes/reviews.detail'
import { clearToken, setToken } from '../src/stores/auth'

function version(nodeRunId: string): DocVersion {
  return {
    id: `${nodeRunId}-current`,
    taskId: `task-${nodeRunId}`,
    reviewNodeId: 'review-node',
    reviewNodeRunId: nodeRunId,
    sourceNodeId: 'source-node',
    sourcePortName: 'document',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: `runs/${nodeRunId}/current.md`,
    commentsJson: '[]',
    decision: 'pending',
    decisionReason: null,
    promptSnapshot: null,
    createdAt: 0,
    decidedAt: null,
    decidedBy: null,
  }
}

function detail(nodeRunId: string, multi: boolean): ReviewDetail {
  const current = version(nodeRunId)
  return {
    summary: {
      nodeRunId,
      taskId: `task-${nodeRunId}`,
      taskName: `Task ${nodeRunId}`,
      workflowId: 'workflow',
      workflowName: 'Workflow',
      reviewNodeId: 'review-node',
      title: `Review ${nodeRunId}`,
      description: '',
      currentVersionIndex: 1,
      reviewIteration: 0,
      decision: 'pending',
      awaitingReview: true,
      shardKey: null,
      isMultiDoc: multi,
      createdAt: 0,
      decidedAt: null,
    },
    currentVersion: current,
    currentBody: `# Current ${nodeRunId}`,
    comments: [],
    rerunnableOnReject: [],
    rerunnableOnIterate: [],
    ...(multi
      ? {
          documents: [
            {
              docVersionId: current.id,
              itemIndex: 0,
              itemPath: 'doc.md',
              title: 'Current document',
              selection: 'unselected' as const,
              commentCount: 0,
            },
          ],
        }
      : {}),
  }
}

function currentRound(nodeRunId: string): ReviewRoundSummary {
  return {
    roundKey: 'g1',
    reviewIteration: 0,
    roundGeneration: 1,
    decision: 'pending',
    decisionReason: null,
    decidedAt: null,
    decidedBy: null,
    decidedByRole: null,
    createdAt: 0,
    isCurrent: true,
    members: [
      {
        docVersionId: `${nodeRunId}-current`,
        itemIndex: 0,
        itemPath: 'doc.md',
        title: 'Current document',
        selection: 'unselected',
        commentCount: 0,
        decision: 'pending',
      },
    ],
  }
}

const beforeRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/before',
  component: () => <div data-testid="before-page" />,
})
const taskRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/$id',
  component: () => null,
})
const routeTree = RootRoute.addChildren([ReviewRoute, beforeRoute, taskRoute])

function renderReview(initialEntries: string[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  })
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries }),
  })
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        {/* The test route tree intentionally omits unrelated product routes. */}
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <RouterProvider router={router as any} />
      </QueryClientProvider>
    </StrictMode>,
  )
  return { client, router }
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setToken('test-token')
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    const versions = url.match(/^\/api\/reviews\/([^/]+)\/versions$/)
    if (versions !== null) return Promise.resolve([version(decodeURIComponent(versions[1]!))])
    const rounds = url.match(/^\/api\/reviews\/([^/]+)\/rounds$/)
    if (rounds !== null) return Promise.resolve([currentRound(decodeURIComponent(rounds[1]!))])
    const current = url.match(/^\/api\/reviews\/([^/]+)$/)
    if (current !== null) {
      const nodeRunId = decodeURIComponent(current[1]!)
      return Promise.resolve(detail(nodeRunId, nodeRunId.startsWith('multi')))
    }
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('/reviews/$nodeRunId unknown search warnings', () => {
  test('unknown version survives replace, clears on route-id change, and is dismissible', async () => {
    const { router } = renderReview(['/reviews/single-one?version=missing-version'])

    const warning = await screen.findByTestId('review-invalid-version-warning')
    expect(warning.textContent).toContain('missing-version')
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    expect(screen.getByTestId('review-invalid-version-warning')).toBe(warning)

    await act(async () => {
      await router.navigate({
        to: '/reviews/$nodeRunId',
        params: { nodeRunId: 'single-two' },
        search: {},
      })
    })
    await screen.findByText('Current single-two')
    expect(screen.queryByTestId('review-invalid-version-warning')).toBeNull()

    await act(async () => {
      await router.navigate({
        to: '/reviews/$nodeRunId',
        params: { nodeRunId: 'single-two' },
        search: { version: 'another-missing' },
      })
    })
    const nextWarning = await screen.findByTestId('review-invalid-version-warning')
    fireEvent.click(within(nextWarning).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByTestId('review-invalid-version-warning')).toBeNull())
  })

  test('replace removes the bad version entry, so Back/Forward and a fresh canonical mount do not replay', async () => {
    const { router } = renderReview(['/before', '/reviews/single-one?version=missing-version'])
    await screen.findByTestId('review-invalid-version-warning')
    await waitFor(() => expect(router.state.location.search).toEqual({}))

    router.history.back()
    await screen.findByTestId('before-page')
    router.history.forward()
    await screen.findByText('Current single-one')
    expect(screen.queryByTestId('review-invalid-version-warning')).toBeNull()

    cleanup()
    renderReview(['/reviews/single-one'])
    await screen.findByText('Current single-one')
    expect(screen.queryByTestId('review-invalid-version-warning')).toBeNull()
  })

  test('unknown multi-doc round survives replace, then route-id and Back/Forward cannot replay it', async () => {
    const { router } = renderReview(['/before', '/reviews/multi-one?round=missing-round'])

    const warning = await screen.findByTestId('review-invalid-round-warning')
    expect(warning.textContent).toContain('missing-round')
    await waitFor(() => expect(router.state.location.search).toEqual({}))
    expect(screen.getByTestId('review-invalid-round-warning')).toBe(warning)

    await act(async () => {
      await router.navigate({
        to: '/reviews/$nodeRunId',
        params: { nodeRunId: 'multi-two' },
        search: {},
      })
    })
    await screen.findByText('Current multi-two')
    expect(screen.queryByTestId('review-invalid-round-warning')).toBeNull()

    router.history.back()
    await screen.findByText('Current multi-one')
    expect(screen.queryByTestId('review-invalid-round-warning')).toBeNull()
    router.history.back()
    await screen.findByTestId('before-page')
    router.history.forward()
    await screen.findByText('Current multi-one')
    expect(screen.queryByTestId('review-invalid-round-warning')).toBeNull()
  })
})
