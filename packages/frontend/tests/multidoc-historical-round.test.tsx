// RFC-142 — 多文档评审历史轮只读视图（?round=<roundKey>）回归锁。
//
// 锁定 design D6/D7：
//   - 历史轮的文档导航来自该轮 members（不是当前轮 detail.documents），逐篇
//     正文 + 冻结评论走既有 /versions/:vid 端点；
//   - 只读横幅 + 决策信息块渲染；写入口全禁——无轮级决策按钮、无逐篇
//     采纳/不采纳按钮、Q/W 快捷键不再触发 selection PATCH；
//   - 未知 roundKey → alert 一次并 replace 回当前轮（对齐 RFC-013 未知
//     version 的处理）；
//   - ?round 指向当前轮（isCurrent）→ 等价无参，渲染交互视图。

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'
import type {
  DocVersion,
  DocVersionWithBodyAndComments,
  ReviewDetail,
  ReviewRoundSummary,
} from '@agent-workflow/shared'

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
    decision: 'pending',
    decisionReason: null,
    promptSnapshot: null,
    createdAt: 0,
    decidedAt: null,
    decidedBy: null,
  }
}

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
  currentVersion: doc('c0'),
  currentBody: '# Current round body',
  comments: [],
  rerunnableOnReject: [],
  rerunnableOnIterate: [],
  documents: [
    {
      docVersionId: 'c0',
      itemIndex: 0,
      itemPath: 'cases/a.md',
      title: 'Case A v2',
      selection: 'unselected',
      commentCount: 0,
    },
    {
      docVersionId: 'c1',
      itemIndex: 1,
      itemPath: 'cases/b.md',
      title: 'Case B v2',
      selection: 'unselected',
      commentCount: 0,
    },
  ],
}

const rounds: ReviewRoundSummary[] = [
  {
    roundKey: 'g1',
    reviewIteration: 0,
    roundGeneration: 1,
    decision: 'iterated',
    decisionReason: null,
    decidedAt: 1751000000000,
    decidedBy: 'u-alice',
    decidedByRole: 'owner',
    createdAt: 1750000000000,
    isCurrent: false,
    members: [
      {
        docVersionId: 'h0',
        itemIndex: 0,
        itemPath: 'cases/a.md',
        title: 'Hist A v1',
        selection: 'accepted',
        commentCount: 1,
        decision: 'iterated',
      },
      {
        docVersionId: 'h1',
        itemIndex: 1,
        itemPath: 'cases/b.md',
        title: 'Hist B v1',
        selection: 'not_accepted',
        commentCount: 0,
        decision: 'iterated',
      },
    ],
  },
  {
    roundKey: 'g2',
    reviewIteration: 1,
    roundGeneration: 2,
    decision: 'pending',
    decisionReason: null,
    decidedAt: null,
    decidedBy: null,
    decidedByRole: null,
    createdAt: 1751100000000,
    isCurrent: true,
    members: [
      {
        docVersionId: 'c0',
        itemIndex: 0,
        itemPath: 'cases/a.md',
        title: 'Case A v2',
        selection: 'unselected',
        commentCount: 0,
        decision: 'pending',
      },
    ],
  },
]

function histVersion(id: string, title: string): DocVersionWithBodyAndComments {
  return {
    ...doc(id),
    reviewIteration: 0,
    decision: 'iterated',
    decidedAt: 1751000000000,
    decidedBy: 'u-alice',
    body: `# ${title}\n\nfrozen body of ${id}`,
    comments:
      id === 'h0'
        ? [
            {
              id: 'cm1',
              docVersionId: 'h0',
              anchor: {
                sectionPath: `# ${title}`,
                paragraphIdx: 0,
                offsetStart: 0,
                offsetEnd: 6,
                selectedText: 'frozen',
                contextBefore: '',
                contextAfter: ' body',
                occurrenceIndex: 1,
              },
              commentText: 'frozen comment from round 1',
              author: 'u-alice',
              authorRole: 'owner',
              createdAt: 1750500000000,
            },
          ]
        : [],
  }
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
  // 未知 roundKey 的 replace 回跳目标（component 里 navigate 到该路由）。
  const reviewsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/reviews/$nodeRunId',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, tasksRoute, reviewsRoute]),
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
  ;(api.patch as ReturnType<typeof vi.fn>).mockReset()
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/reviews/run') return Promise.resolve(detail)
    if (url === '/api/reviews/run/rounds') return Promise.resolve(rounds)
    if (url === '/api/reviews/run/versions/h0')
      return Promise.resolve(histVersion('h0', 'Hist A v1'))
    if (url === '/api/reviews/run/versions/h1')
      return Promise.resolve(histVersion('h1', 'Hist B v1'))
    if (url === '/api/config') return Promise.resolve({})
    return Promise.resolve(undefined)
  })
  ;(api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true })
})

describe('MultiDocReviewView — historical round (?round=)', () => {
  test('历史轮：成员导航 + 冻结评论 + 只读横幅 + 决策信息块；写入口全禁', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" historicalRoundKey="g1" />)
    // 导航列表来自该轮 members，而非当前轮 documents。
    expect(await screen.findByText('Hist A v1')).toBeTruthy()
    expect(screen.getByText('Hist B v1')).toBeTruthy()
    expect(screen.queryByText('Case A v2')).toBeNull()
    // 只读横幅 + 回到当前轮。
    expect(screen.getByRole('status').textContent).toContain('Read-only')
    expect(screen.getByRole('status').textContent).toContain('round 1')
    expect(screen.getByText('Back to current round')).toBeTruthy()
    // 决策信息块（轮级 iterated → chip + 决策人，无原因行）。
    expect(screen.getByTestId('review-decision-info')).toBeTruthy()
    expect(screen.queryByTestId('review-decision-reason')).toBeNull()
    // 写入口全禁。
    expect(screen.queryByTestId('multidoc-approve')).toBeNull()
    expect(screen.queryByTestId('multidoc-accept')).toBeNull()
    expect(screen.queryByTestId('multidoc-not-accept')).toBeNull()
    // 首篇正文 + 冻结评论经 /versions/:vid 而来。
    expect(await screen.findByText('frozen comment from round 1')).toBeTruthy()
    expect(api.get).toHaveBeenCalledWith(
      '/api/reviews/run/versions/h0',
      undefined,
      expect.anything(),
    )
    // Q 快捷键不触发 selection PATCH（awaiting=false）。
    fireEvent.keyDown(window, { key: 'q' })
    expect(api.patch).not.toHaveBeenCalled()
  })

  test('?round 指向当前轮 → 等价无参：交互视图照常（决策按钮在）', async () => {
    wrap(<MultiDocReviewView nodeRunId="run" historicalRoundKey="g2" />)
    expect(await screen.findByText('Case A v2')).toBeTruthy()
    expect(screen.getByTestId('multidoc-approve')).toBeTruthy()
    expect(screen.queryByText('Back to current round')).toBeNull()
  })

  test('未知 roundKey → alert 一次并回落当前视图', async () => {
    // jsdom 不带 window.alert 实现——直接挂 stub（spyOn 会因 undefined 报错）。
    const alertStub = vi.fn()
    const original = window.alert
    window.alert = alertStub as unknown as typeof window.alert
    try {
      wrap(<MultiDocReviewView nodeRunId="run" historicalRoundKey="nope" />)
      await waitFor(() => expect(alertStub).toHaveBeenCalledTimes(1))
      expect(String(alertStub.mock.calls[0]![0])).toContain('nope')
    } finally {
      window.alert = original
    }
  })
})
