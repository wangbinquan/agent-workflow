// RFC-129 — multi-document review "已变更 / Changed" badge. Locks that a document
// whose inherited selection went stale (content changed since the human last
// judged it) shows the advisory badge, and that non-stale documents do not.
// Asserts on the testid (not the i18n text) so it is locale-race-free.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'
import type { DocVersion, ReviewDetail } from '@agent-workflow/shared'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }
})
vi.mock('../src/hooks/useTaskSync', () => ({ useTaskSync: () => {} }))

import { api } from '../src/api/client'
import { MultiDocReviewView } from '../src/components/review/MultiDocReviewView'

function doc(id: string): DocVersion {
  return {
    id,
    taskId: 't',
    reviewNodeId: 'rev',
    reviewNodeRunId: 'run',
    sourceNodeId: 'src',
    sourcePortName: 'cases',
    versionIndex: 2,
    reviewIteration: 1,
    bodyPath: `runs/t/${id}.md`,
    commentsJson: '[]',
    decision: 'pending',
    decisionReason: null,
    promptSnapshot: null,
    createdAt: 0,
    decidedAt: null,
    decidedBy: null,
  }
}

// Round 2 (inherited): a.md carried accepted + content changed → stale; b.md
// carried not_accepted + unchanged → not stale; c.md unselected → not stale.
const detail: ReviewDetail = {
  summary: {
    nodeRunId: 'run',
    taskId: 't',
    taskName: 'T',
    workflowId: 'w',
    workflowName: 'W',
    reviewNodeId: 'rev',
    title: 'Review cases',
    description: '',
    currentVersionIndex: 2,
    reviewIteration: 1,
    decision: 'pending',
    awaitingReview: true,
    shardKey: null,
    isMultiDoc: true,
    createdAt: 0,
    decidedAt: null,
  },
  currentVersion: doc('d0'),
  currentBody: '# Active document body\n\ntext',
  comments: [],
  rerunnableOnReject: [],
  rerunnableOnIterate: [],
  documents: [
    {
      docVersionId: 'd0',
      itemIndex: 0,
      itemPath: 'cases/a.md',
      title: 'Case A',
      selection: 'accepted',
      commentCount: 0,
      stale: true,
    },
    {
      docVersionId: 'd1',
      itemIndex: 1,
      itemPath: 'cases/b.md',
      title: 'Case B',
      selection: 'not_accepted',
      commentCount: 0,
      stale: false,
    },
    {
      docVersionId: 'd2',
      itemIndex: 2,
      itemPath: 'cases/c.md',
      title: 'Case C',
      selection: 'unselected',
      commentCount: 0,
    },
  ],
}

function wrap(node: React.ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  const rootRoute = createRootRoute({
    component: () => (
      <>
        {node}
        <Outlet />
      </>
    ),
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  const tasksRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, tasksRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/reviews/run') return Promise.resolve(detail)
    if (url === '/api/config') return Promise.resolve({})
    return Promise.resolve(undefined)
  })
})

describe('RFC-129 — multi-doc stale badge', () => {
  test('shows the "已变更" badge only for documents whose inherited selection is stale', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    // Exactly one stale badge (d0), reachable by its testid (locale-independent).
    const badges = screen.getAllByTestId('multidoc-stale-badge')
    expect(badges.length).toBe(1)
    // It sits on the Case A row, not Case B / Case C.
    const rowA = screen.getByText('Case A').closest('button')
    expect(rowA?.contains(badges[0]!)).toBe(true)
  })

  test('source lock — badge uses the shared <StatusChip kind="warn"> primitive (no self-rolled chrome)', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '../src/components/review/MultiDocReviewView.tsx'),
      'utf8',
    )
    expect(src).toContain('data-testid="multidoc-stale-badge"')
    expect(src).toContain('kind="warn"')
    expect(src).toContain('d.stale')
    expect(src).toContain("t('reviews.multiDoc.changed')")
  })
})
