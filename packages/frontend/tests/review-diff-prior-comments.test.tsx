// RFC-241 — diff 模式「上一版检视意见」只读侧栏回归(design v3 §测试策略
// + 实现门 P1/P2 补强)。两层:
//   组件级(#1-#3、#5-#6):侧栏内容/排序/行号/空态/只读性 + i18n/CSS 锁
//   路由级集成(INT-1/2,实现门 P1):真实 ReviewDetailPage 挂载——
//     - diff on → 侧栏出现,行号按 **priorBody**(上一版)计算(两版行号
//       不同的 fixture 区分接线;body 误接 currentBody 立刻红)
//     - 同 fixture 含当前版评论:.prior-comments 内零 actions,容器外
//       当前版侧栏 actions 照常存在(设计 §测试 2 的对照断言)
//     - historical 视图 + diffMode 残留 true → 侧栏不渲染(设计门一轮
//       P1 专项;文本序锁可被移出 slot 绕过,集成断言不可绕)
//   #4 保留源码序锁作纵深(historical 早退先行于侧栏渲染点)。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import type {
  DocVersion,
  DocVersionWithBodyAndComments,
  ReviewComment,
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
import { PriorCommentsSidebar } from '../src/components/review/PriorCommentsSidebar'
import { clearToken, setToken } from '../src/stores/auth'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const REVIEWS_DETAIL_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')

// ---------------------------------------------------------------------------
// 组件级夹具
// ---------------------------------------------------------------------------

const BODY = ['# 标题', '', '第一段内容甲乙丙。', '', '第二段内容丁戊己。'].join('\n')

const mkComment = (
  id: string,
  offsetStart: number,
  text: string,
  occurrenceIndex = 0,
  body = BODY,
): ReviewComment => ({
  id,
  docVersionId: 'dv-prior',
  anchor: {
    sectionPath: '## 标题',
    paragraphIdx: 0,
    offsetStart,
    offsetEnd: Math.min(offsetStart + 4, body.length),
    selectedText: body.slice(offsetStart, offsetStart + 4),
    contextBefore: '',
    contextAfter: '',
    occurrenceIndex,
  },
  commentText: text,
  author: 'user-1',
  authorRole: 'owner',
  createdAt: 1_700_000_000_000,
})

const mountSidebar = (comments: ReviewComment[]) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PriorCommentsSidebar comments={comments} body={BODY} versionIndex={3} />
    </QueryClientProvider>,
  )

// ---------------------------------------------------------------------------
// 路由级夹具(review-detail-query-continuity 同款脚手架)
// ---------------------------------------------------------------------------

const PRIOR_BODY = [
  'pad line one',
  'pad line two',
  'pad line three',
  'TARGET phrase here',
  '',
].join('\n')
const CURRENT_BODY = ['# Current version', '', 'TARGET phrase here', ''].join('\n')

function doc(id: string, versionIndex: number): DocVersion {
  return {
    id,
    taskId: 'task-1',
    reviewNodeId: 'review-node',
    reviewNodeRunId: 'run',
    sourceNodeId: 'source-node',
    sourcePortName: 'document',
    versionIndex,
    reviewIteration: 0,
    bodyPath: `runs/task-1/${id}.md`,
    commentsJson: '[]',
    decision: versionIndex === 2 ? 'pending' : 'iterated',
    decisionReason: null,
    promptSnapshot: null,
    createdAt: 0,
    decidedAt: null,
    decidedBy: null,
  }
}

function makeDetail(): ReviewDetail {
  const currentComment = mkComment(
    'cur-1',
    CURRENT_BODY.indexOf('TARGET'),
    '当前版意见',
    0,
    CURRENT_BODY,
  )
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
      currentVersionIndex: 2,
      reviewIteration: 0,
      decision: 'pending',
      awaitingReview: true,
      shardKey: null,
      isMultiDoc: false,
      createdAt: 0,
      decidedAt: null,
    },
    currentVersion: doc('doc-2', 2),
    currentBody: CURRENT_BODY,
    comments: [{ ...currentComment, docVersionId: 'doc-2' }],
    rerunnableOnReject: [],
    rerunnableOnIterate: [],
  }
}

function priorVersionBody(): DocVersionWithBodyAndComments {
  const priorComment = mkComment(
    'prior-1',
    PRIOR_BODY.indexOf('TARGET'),
    '上一版意见:请修正术语',
    0,
    PRIOR_BODY,
  )
  return {
    ...doc('doc-1', 1),
    body: PRIOR_BODY,
    comments: [{ ...priorComment, docVersionId: 'doc-1' }],
  }
}

function installApiRoutes(): void {
  ;(api.get as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
    if (url === '/api/reviews/run') return Promise.resolve(makeDetail())
    if (url === '/api/reviews/run/versions')
      return Promise.resolve([doc('doc-2', 2), doc('doc-1', 1)])
    if (url === '/api/reviews/run/versions/doc-1') return Promise.resolve(priorVersionBody())
    if (url === '/api/config') return Promise.resolve({})
    return Promise.reject(new Error(`unexpected GET ${url}`))
  })
}

const taskStub = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/$id',
  component: () => null,
})
const reviewRouteTree = RootRoute.addChildren([ReviewRoute, taskStub])

function renderRoute() {
  const router = createRouter({
    routeTree: reviewRouteTree,
    history: createMemoryHistory({ initialEntries: ['/reviews/run'] }),
  })
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnMount: 'always' } },
        })
      }
    >
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  setToken('test-token')
  ;(api.get as ReturnType<typeof vi.fn>).mockReset()
  ;(api.post as ReturnType<typeof vi.fn>).mockReset()
  ;(api.post as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 'user-1', username: 'alice', displayName: 'Alice', role: 'user', status: 'active' },
  ])
})

afterEach(() => {
  cleanup()
  clearToken()
})

// ---------------------------------------------------------------------------
// 组件级
// ---------------------------------------------------------------------------

describe('RFC-241 上一版检视意见只读侧栏(组件级)', () => {
  test('#1 三条意见:role=complementary、来源版本标注、排序与行号标签', () => {
    const { container } = mountSidebar([
      mkComment('c-late', 30, '后面的意见'),
      mkComment('c-early', 10, '前面的意见'),
      mkComment('c-mid', 30, '同起点后出现', 1),
    ])
    const aside = container.querySelector('[role="complementary"]')
    expect(aside).not.toBeNull()
    expect(aside?.getAttribute('aria-label') ?? '').toContain('v3')
    const items = Array.from(container.querySelectorAll('article.comment-bubble'))
    expect(items.length).toBe(3)
    expect(items.map((a) => a.getAttribute('data-comment-id'))).toEqual([
      'c-early',
      'c-late',
      'c-mid',
    ])
    expect(items[0]?.querySelector('.comment-bubble__line-ref')?.textContent ?? '').not.toBe('')
    expect(items[0]?.querySelector('.comment-bubble__body')?.textContent).toBe('前面的意见')
    expect(items[0]?.querySelector('.comment-bubble__attribution')).not.toBeNull()
  })

  test('#2 只读性(容器作用域):无 actions、无 textbox、无按钮', () => {
    const { container } = mountSidebar([
      mkComment('c1', 10, '意见一'),
      mkComment('c2', 30, '意见二'),
    ])
    const aside = container.querySelector('[role="complementary"]') as HTMLElement
    const scoped = within(aside)
    expect(aside.querySelectorAll('.comment-bubble__actions').length).toBe(0)
    expect(scoped.queryAllByRole('textbox').length).toBe(0)
    expect(scoped.queryAllByRole('button').length).toBe(0)
  })

  test('#3 零条意见 → EmptyState 可见(不隐藏侧栏)', () => {
    const { container } = mountSidebar([])
    expect(container.querySelector('[role="complementary"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="prior-comments-empty"]')).not.toBeNull()
  })

  test('#4 historical 互斥源码序锁(纵深防御;主证据在 INT-2 集成断言)', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx.split('<PriorCommentsSidebar').length - 1).toBe(1)
    const slotStart = tsx.indexOf('const auxiliaryBodySlot')
    expect(slotStart).toBeGreaterThan(0)
    const slotBody = tsx.slice(slotStart)
    const historicalEarlyReturn = slotBody.indexOf("mode === 'historical'")
    const diffModeGate = slotBody.indexOf('if (!diffMode) return undefined')
    const sidebarIdx = slotBody.indexOf('<PriorCommentsSidebar')
    expect(historicalEarlyReturn).toBeGreaterThan(0)
    expect(diffModeGate).toBeGreaterThan(historicalEarlyReturn)
    expect(sidebarIdx).toBeGreaterThan(diffModeGate)
    expect(slotBody.indexOf('className="review-diff-layout"')).toBeLessThan(sidebarIdx)
  })

  test('#5 i18n key zh/en 齐备(count 为复数对)', () => {
    const zh = readFileSync(resolve(__dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf8')
    const en = readFileSync(resolve(__dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf8')
    expect(zh).toMatch(/priorCommentsTitle:\s*string/)
    for (const key of [
      'priorCommentsTitle',
      'priorCommentsCount_one',
      'priorCommentsCount_other',
      'priorCommentsEmpty',
    ]) {
      expect(zh).toMatch(new RegExp(key + ":\\s*'"))
      expect(en).toMatch(new RegExp(key + ":\\s*'"))
    }
    // 英文单数不得出现 "1 items"
    expect(en).toMatch(/priorCommentsCount_one:\s*'\{\{count\}\} item'/)
  })

  test('#6 布局与只读覆盖 CSS 源码锁', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(
      /\.review-diff-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(240px, 320px\)/,
    )
    expect(css).toMatch(
      /@media \(max-width: 1100px\)\s*\{\s*\.review-diff-layout\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/,
    )
    expect(css).toMatch(/\.prior-comments \.comment-bubble\s*\{[^}]*position: static/)
    expect(css).toMatch(/\.prior-comments \.comment-bubble\s*\{[^}]*cursor: default/)
    expect(css).toMatch(/\.prior-comments \.comment-bubble:hover\s*\{/)
  })
})

// ---------------------------------------------------------------------------
// 路由级集成(实现门 P1)
// ---------------------------------------------------------------------------

describe('RFC-241 路由级集成(真实 ReviewDetailPage)', () => {
  test(
    'INT-1 diff on → 侧栏出现,行号按上一版 body 计算;容器外当前版 actions 照常',
    { timeout: 20000 },
    async () => {
      installApiRoutes()
      renderRoute()
      // 就绪信号用 Word radio(正文文本会被当前版评论的 anchor mark 拆碎,
      // findByText 整串匹配不可靠)
      fireEvent.click(await screen.findByRole('radio', { name: 'Word' }, { timeout: 5000 }))
      const aside = await screen.findByRole('complementary', undefined, { timeout: 5000 })
      expect(aside.getAttribute('aria-label') ?? '').toContain('v1')
      expect(within(aside).getByText('上一版意见:请修正术语')).toBeTruthy()
      // 行号按 PRIOR_BODY 计算:TARGET 在上一版第 4 行(当前版为第 3 行;
      // body 误接 currentBody 时此断言立刻红)
      expect(within(aside).getByText('Line 4')).toBeTruthy()
      expect(within(aside).queryByText('Line 3')).toBeNull()
      expect(aside.querySelectorAll('.comment-bubble__actions').length).toBe(0)
      await waitFor(() => {
        expect(document.querySelectorAll('.comment-bubble__actions').length).toBeGreaterThan(0)
      })
    },
  )

  test('INT-2 historical 视图 + diffMode 残留 true → 侧栏不渲染', { timeout: 20000 }, async () => {
    installApiRoutes()
    const router = renderRoute()
    fireEvent.click(await screen.findByRole('radio', { name: 'Word' }, { timeout: 5000 }))
    await screen.findByRole('complementary', undefined, { timeout: 5000 })
    await act(async () => {
      await router.navigate({
        to: '/reviews/$nodeRunId',
        params: { nodeRunId: 'run' },
        search: { version: 'doc-1' },
      })
    })
    await waitFor(() => {
      expect(screen.queryByRole('complementary')).toBeNull()
    })
    expect(await screen.findByText(/pad line one/, undefined, { timeout: 5000 })).toBeTruthy()
  })
})
