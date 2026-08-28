// RFC-149 — multi-doc review 'decided' state lock (deliberate behavior change).
//
// Before RFC-149 the multi-doc page derived a single `awaiting` boolean, so a
// CURRENT round that had already been decided rendered exactly like a
// read-only historical round: the round decision buttons and the per-doc
// accept/exclude bar vanished from the DOM. The single-doc page always kept
// its decision buttons visible-but-disabled in that state. RFC-149 introduces
// the three-state `ReviewPaneMode` ('awaiting' | 'decided' | 'historical');
// this file locks the new 'decided' contract:
//   - round decision buttons (approve / iterate / reject) RENDER but are
//     DISABLED;
//   - the per-doc accept / exclude buttons RENDER but are DISABLED;
//   - Q/W hotkeys do not fire the selection PATCH;
//   - the decision info block for the decided round renders.
// Historical rounds keep hiding everything (multidoc-historical-round.test.tsx).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { fireEvent, render, screen } from '@testing-library/react'
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
import i18n from '../src/i18n'

function doc(id: string): DocVersion {
  return {
    id,
    taskId: 't',
    reviewNodeId: 'rev',
    reviewNodeRunId: 'run',
    sourceNodeId: 'src',
    sourcePortName: 'cases',
    versionIndex: 1,
    reviewIteration: 1,
    bodyPath: `runs/t/${id}.md`,
    commentsJson: '[]',
    decision: 'approved',
    decisionReason: null,
    promptSnapshot: null,
    createdAt: 0,
    decidedAt: 1751000000000,
    decidedBy: 'u-alice',
  }
}

// Current round, already decided: awaitingReview=false + approved versions.
const detail: ReviewDetail = {
  capabilities: {
    scope: 'task',
    canAddComment: true,
    canEditOwnComments: true,
    canDeleteOwnComments: true,
    canManageAnyComments: false,
    canSelectDocuments: true,
    canDecide: true,
  },
  summary: {
    nodeRunId: 'run',
    taskId: 't',
    taskName: 'T',
    workflowId: 'w',
    workflowName: 'W',
    reviewNodeId: 'rev',
    title: 'Review cases',
    description: '',
    currentVersionIndex: 1,
    reviewIteration: 1,
    decision: 'approved',
    awaitingReview: false,
    shardKey: null,
    isMultiDoc: true,
    createdAt: 0,
    decidedAt: 1751000000000,
  },
  currentVersion: doc('d0'),
  currentBody: '# Decided round body',
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
    },
    {
      docVersionId: 'd1',
      itemIndex: 1,
      itemPath: 'cases/b.md',
      title: 'Case B',
      selection: 'not_accepted',
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

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.post as ReturnType<typeof vi.fn>).mockReset()
  ;(api.patch as ReturnType<typeof vi.fn>).mockReset()
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/reviews/run') return Promise.resolve(detail)
    if (url === '/api/config') return Promise.resolve({})
    return Promise.resolve(undefined)
  })
  // useUserLookup resolves the decider id via POST /api/users/lookup.
  ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([])
  ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
})

describe('MultiDocReviewView — decided current round (mode="decided")', () => {
  test('round decision buttons render but are disabled (single-doc parity)', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    // All three round-level decision buttons are IN the DOM…
    const approve = screen.getByTestId('multidoc-approve') as HTMLButtonElement
    const iterate = screen.getByText('Revise per comments').closest('button')
    const reject = screen.getByText('Reject').closest('button')
    expect(iterate).not.toBeNull()
    expect(reject).not.toBeNull()
    // …but every one is disabled: the round was already decided. Note both
    // documents are decided (allDecided=true), so approve's disabled state can
    // only come from the mode gate, not the selection-progress gate.
    expect(approve.disabled).toBe(true)
    expect((iterate as HTMLButtonElement).disabled).toBe(true)
    expect((reject as HTMLButtonElement).disabled).toBe(true)
  })

  test('per-document accept / exclude buttons render but are disabled', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    const accept = screen.getByTestId('multidoc-accept') as HTMLButtonElement
    const notAccept = screen.getByTestId('multidoc-not-accept') as HTMLButtonElement
    expect(accept.disabled).toBe(true)
    expect(notAccept.disabled).toBe(true)
  })

  test('Q/W hotkeys do not fire the selection PATCH on a decided round', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    fireEvent.keyDown(window, { key: 'q' })
    fireEvent.keyDown(window, { key: 'w' })
    expect(api.patch).not.toHaveBeenCalled()
  })

  test('decision info block renders for the decided current round', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    expect(screen.getByTestId('review-decision-info')).toBeTruthy()
    expect(screen.getByText('approved')).toBeTruthy()
  })
  test('decided 轮选中正文不得弹出加评论 popover（实现门 medium 回归）', async () => {
    // 新评论创建是 awaiting 专属写入口——decided 轮只能拿到服务端
    // review-not-awaiting 拒绝，前端必须整链不暴露（onMouseUp 不挂 /
    // popover 不渲染）。
    const { container } = wrap(<MultiDocReviewView nodeRunId="run" />)
    await screen.findByText('Case A')
    const docEl = container.querySelector('.review-detail__body')
    expect(docEl).not.toBeNull()
    fireEvent.mouseUp(docEl!)
    await Promise.resolve()
    expect(container.querySelector('[class*="popover"]')).toBeNull()
  })
})
