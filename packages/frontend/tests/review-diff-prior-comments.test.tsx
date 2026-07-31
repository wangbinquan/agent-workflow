// RFC-241 — diff 模式「上一版检视意见」侧栏回归(design v6:v1 只读列表
// §测试 1-6 + 阶段 2 锚定 §测试 7-10)。三层:
//   组件级(#1-#3、#5-#6):侧栏内容/排序/行号/空态/只读性 + i18n/CSS 锁
//   锚定级(#7-#10,阶段 2):harness 同时挂 MarkdownDiffView(带
//     priorAnchors,hast 阶段包 mark)与侧栏——
//     - context/del 命中、跨 text 节点整组 mark、点击整组 data-active +
//       scrollIntoView
//     - ins-排除不改变命中;strict 次数不足 → 未定位回退绝不 clamp 错钉
//     - word 档表格校验:含 ins 回退、纯删减 del+context 残缝回退(聚焦
//       复核 P1)、纯 DEL 整表保留、line 档不校验(分档生效)
//     - word 档 katex 整树出流:锚在公式回退、其后锚不受计数污染
//   路由级集成(INT-1/2,v1 实现门 P1):真实 ReviewDetailPage 挂载——
//     - diff on → 侧栏出现,行号按 **priorBody**(上一版)计算
//     - historical 视图 + diffMode 残留 true → 侧栏不渲染
//   #4 保留源码序锁作纵深(historical 早退先行于侧栏渲染点);#11 部分
//   由既有套件承担(rehypeWrapAnchors 无 opts 行为 / ReviewDocPane 零回
//   归),此处补一条「diff 路径禁用 legacy wrapAnchorsInDom」源码锁。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useRef, type ReactNode } from 'react'
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
import { MarkdownDiffView } from '../src/components/review/MarkdownDiffView'
import { PriorCommentsSidebar } from '../src/components/review/PriorCommentsSidebar'
import type { DiffGranularity } from '../src/components/review/DiffView'
import { clearToken, setToken } from '../src/stores/auth'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const REVIEWS_DETAIL_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')

// ---------------------------------------------------------------------------
// 组件级夹具:harness 同挂 diff 文档(真实 hast 包 mark)与侧栏
// ---------------------------------------------------------------------------

const BODY = ['# 标题', '', '第一段内容甲乙丙。', '', '第二段内容丁戊己。'].join('\n')

const mkComment = (
  id: string,
  offsetStart: number,
  text: string,
  occurrenceIndex = 0,
  body = BODY,
  selectedText?: string,
): ReviewComment => ({
  id,
  docVersionId: 'dv-prior',
  anchor: {
    sectionPath: '## 标题',
    paragraphIdx: 0,
    offsetStart,
    offsetEnd: Math.min(offsetStart + (selectedText?.length ?? 4), body.length),
    selectedText: selectedText ?? body.slice(offsetStart, offsetStart + 4),
    contextBefore: '',
    contextAfter: '',
    occurrenceIndex,
  },
  commentText: text,
  author: 'user-1',
  authorRole: 'owner',
  createdAt: 1_700_000_000_000,
})

function Harness({
  comments,
  left,
  right,
  granularity = 'word',
}: {
  comments: ReviewComment[]
  left: string
  right: string
  granularity?: DiffGranularity
}) {
  const docRef = useRef<HTMLDivElement>(null)
  const anchors = comments.map((c) => ({
    commentId: c.id,
    selectedText: c.anchor.selectedText,
    occurrenceIndex: c.anchor.occurrenceIndex,
  }))
  return (
    <>
      <div className="review-diff-doc" ref={docRef}>
        <MarkdownDiffView
          left={left}
          right={right}
          granularity={granularity}
          priorAnchors={anchors}
        />
      </div>
      <PriorCommentsSidebar
        comments={comments}
        body={left}
        versionIndex={3}
        docRef={docRef}
        granularity={granularity}
        currentBody={right}
      />
    </>
  )
}

const mountSidebar = (
  comments: ReviewComment[],
  opts: { left?: string; right?: string; granularity?: DiffGranularity } = {},
) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Harness
        comments={comments}
        left={opts.left ?? BODY}
        right={opts.right ?? BODY}
        granularity={opts.granularity}
      />
    </QueryClientProvider>,
  )

const docMarks = (container: HTMLElement, id: string): HTMLElement[] =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      `.review-diff-doc mark.prior-comment-anchor[data-comment-id="${id}"]`,
    ),
  )

const orphanHeader = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('.prior-comments__orphan-header')

const bubble = (container: HTMLElement, id: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`.prior-comments .comment-bubble[data-comment-id="${id}"]`)

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
// 组件级(v1 面:内容 / 只读性 / 空态 / 源码与 i18n / CSS 锁)
// ---------------------------------------------------------------------------

describe('RFC-241 上一版检视意见只读侧栏(组件级)', () => {
  test('#1 三条意见:role=complementary、来源版本标注、排序与行号标签', () => {
    // 三条全部可锚定(左右同文 → 全 context),DOM 序 = comparator 序。
    const { container } = mountSidebar([
      mkComment('c-late', 17, '后面的意见'),
      mkComment('c-early', 6, '前面的意见'),
      mkComment('c-mid', 10, '中间的意见'),
    ])
    const aside = container.querySelector('[role="complementary"]')
    expect(aside).not.toBeNull()
    expect(aside?.getAttribute('aria-label') ?? '').toContain('v3')
    const items = Array.from(container.querySelectorAll('article.comment-bubble'))
    expect(items.length).toBe(3)
    expect(items.map((a) => a.getAttribute('data-comment-id'))).toEqual([
      'c-early',
      'c-mid',
      'c-late',
    ])
    expect(items[0]?.querySelector('.comment-bubble__line-ref')?.textContent ?? '').not.toBe('')
    expect(items[0]?.querySelector('.comment-bubble__body')?.textContent).toBe('前面的意见')
    expect(items[0]?.querySelector('.comment-bubble__attribution')).not.toBeNull()
    expect(orphanHeader(container)).toBeNull()
  })

  test('#2 只读性(容器作用域):无 actions、无 textbox、无按钮', () => {
    const { container } = mountSidebar([
      mkComment('c1', 6, '意见一'),
      mkComment('c2', 17, '意见二'),
    ])
    const aside = container.querySelector('[role="complementary"]') as HTMLElement
    const scoped = within(aside)
    expect(aside.querySelectorAll('.comment-bubble__actions').length).toBe(0)
    expect(scoped.queryAllByRole('textbox').length).toBe(0)
    expect(scoped.queryAllByRole('button').length).toBe(0)
  })

  test('#3 零条意见 → EmptyState 可见(不隐藏侧栏、无未定位分节)', () => {
    const { container } = mountSidebar([])
    expect(container.querySelector('[role="complementary"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="prior-comments-empty"]')).not.toBeNull()
    expect(orphanHeader(container)).toBeNull()
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
    // 阶段 2:diff 主列容器 ref 在侧栏之前接线(mark 查询域)
    expect(slotBody.indexOf('className="review-diff-doc"')).toBeLessThan(sidebarIdx)
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
      'priorCommentsUnanchored_one',
      'priorCommentsUnanchored_other',
    ]) {
      expect(zh).toMatch(new RegExp(key + ":\\s*'"))
      expect(en).toMatch(new RegExp(key + ":\\s*'"))
    }
    // 英文单数不得出现 "1 items"
    expect(en).toMatch(/priorCommentsCount_one:\s*'\{\{count\}\} item'/)
    expect(en).toMatch(/priorCommentsUnanchored_one:\s*'[^']*\{\{count\}\} item'/)
  })

  test('#6 布局 / 锚样式 / anchored 光标分级 CSS 源码锁', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(
      /\.review-diff-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(240px, 320px\)/,
    )
    expect(css).toMatch(
      /@media \(max-width: 1100px\)\s*\{\s*\.review-diff-layout\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/,
    )
    // 阶段 2:容器是定位上下文;气泡回归 absolute(base class),未定位
    // default 光标、已锚定恢复 pointer + hover 抬升
    expect(css).toMatch(/\.prior-comments\s*\{[^}]*position: relative/)
    expect(css).not.toMatch(/\.prior-comments \.comment-bubble\s*\{[^}]*position: static/)
    expect(css).toMatch(/\.prior-comments \.comment-bubble\s*\{[^}]*cursor: default/)
    expect(css).toMatch(/\.prior-comments \.comment-bubble--anchored\s*\{[^}]*cursor: pointer/)
    expect(css).toMatch(/\.prior-comments \.comment-bubble--anchored:hover\s*\{/)
    // mark:显式透明底(防 UA 黄底压 diff 红绿)+ 暗色变体 + 点状下划线
    expect(css).toMatch(/mark\.prior-comment-anchor\s*\{[^}]*background: transparent/)
    expect(css).toMatch(
      /mark\.prior-comment-anchor\s*\{[^}]*border-bottom: 1px dotted var\(--muted\)/,
    )
    expect(css).toMatch(
      /:root\[data-theme='dark'\] mark\.prior-comment-anchor\s*\{[^}]*background: transparent/,
    )
    expect(css).toMatch(/mark\.prior-comment-anchor\[data-active='true'\]/)
  })

  test('#11 源码锁:diff 锚定走 hast 插件,禁用 legacy 后挂载 DOM 突变', () => {
    // rehypeWrapAnchors 当年替换 wrapAnchorsInDom 的原因(body 变化撞
    // React reconciliation)对 diff 视图同样成立——granularity / 版本切换
    // 都会重建 merged DOM。
    for (const rel of [
      ['src', 'components', 'review', 'MarkdownDiffView.tsx'],
      ['src', 'components', 'review', 'PriorCommentsSidebar.tsx'],
      ['src', 'routes', 'reviews.detail.tsx'],
    ]) {
      const content = readFileSync(resolve(__dirname, '..', ...rel), 'utf8')
      expect(content).not.toContain("lib/review/wrapAnchorsInDom'")
    }
    const mdv = readFileSync(
      resolve(__dirname, '..', 'src', 'components', 'review', 'MarkdownDiffView.tsx'),
      'utf8',
    )
    expect(mdv).toContain('rehypeWrapAnchors')
    expect(mdv).toContain('strictOccurrence: true')
    expect(mdv).toContain("['diff-ins', 'katex', 'katex-error']")
    expect(mdv).toContain('excludeClasses: PRIOR_ANCHOR_EXCLUDE_CLASSES')
    expect(mdv).toContain("tableGuard: granularity === 'word'")
  })
})

// ---------------------------------------------------------------------------
// 阶段 2 锚定(#7-#10)
// ---------------------------------------------------------------------------

describe('RFC-241 阶段 2:上一版意见锚定', () => {
  test('#7 context 命中:跨 text 节点整组 mark;点击 → 整组 data-active + scrollIntoView', () => {
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy
    const left = ['开头一段。', '', '甲**乙**丙丁戊。', ''].join('\n')
    const c = mkComment('c-span', 0, '跨节点意见', 1, left, '甲乙丙')
    const { container } = mountSidebar([c], { left, right: left })
    // 加粗把「甲乙丙」拆成 3 个 text 节点 → 同 comment-id 多段 mark
    const marks = docMarks(container, 'c-span')
    expect(marks.length).toBeGreaterThanOrEqual(2)
    expect(marks.map((m) => m.textContent).join('')).toBe('甲乙丙')
    expect(orphanHeader(container)).toBeNull()
    const b = bubble(container, 'c-span')
    expect(b?.className).toContain('comment-bubble--anchored')
    fireEvent.click(b as HTMLElement)
    for (const m of docMarks(container, 'c-span')) {
      expect(m.getAttribute('data-active')).toBe('true')
    }
    expect(b?.className).toContain('comment-bubble--active')
    expect(scrollSpy).toHaveBeenCalled()
  })

  test('#8 锚文本被删:mark 落 .diff-del 内,仍视为已锚定', () => {
    const left = ['段落甲乙丙丁保留。', ''].join('\n')
    const right = ['段落丁保留。', ''].join('\n')
    const c = mkComment('c-del', 0, '被删的文字', 1, left, '甲乙丙')
    const { container } = mountSidebar([c], { left, right })
    const marks = docMarks(container, 'c-del')
    expect(marks.length).toBeGreaterThanOrEqual(1)
    expect(marks[0]?.closest('.diff-del')).not.toBeNull()
    expect(orphanHeader(container)).toBeNull()
    expect(bubble(container, 'c-del')?.className).toContain('comment-bubble--anchored')
  })

  test('#9a ins-排除:当前版新增相同字样不改变命中', () => {
    const left = ['前文字段。', '', '唯一TOKEN在此。', ''].join('\n')
    const right = ['前文字段。', '', '新增TOKEN字样。', '', '唯一TOKEN在此。', ''].join('\n')
    const c = mkComment('c-ins', 0, '排除新增', 1, left, 'TOKEN')
    const { container } = mountSidebar([c], { left, right })
    const marks = docMarks(container, 'c-ins')
    expect(marks.length).toBe(1)
    // 命中的是 context 里的 TOKEN,不在新增段(.diff-ins)内
    expect(marks[0]?.closest('.diff-ins')).toBeNull()
    expect(orphanHeader(container)).toBeNull()
  })

  test('#9b strict:次数不足 → 未定位回退,绝不 clamp 错钉', () => {
    const left = ['只出现一次的短语。', ''].join('\n')
    const c = mkComment('c-strict', 0, '次数不足', 5, left, '短语')
    const { container } = mountSidebar([c], { left, right: left })
    expect(docMarks(container, 'c-strict').length).toBe(0)
    expect(orphanHeader(container)).not.toBeNull()
    const b = bubble(container, 'c-strict')
    expect(b).not.toBeNull()
    expect(b?.className).not.toContain('comment-bubble--anchored')
  })

  test('#9c word 档表格校验:含 ins 回退;del+context 残缝回退;纯 DEL 整表保留;line 档不校验', () => {
    // (i) 含 ins:cell 编辑产生 del+ins → context 锚回退
    const tblLeft = ['| A | B |', '| --- | --- |', '| foo | old |', ''].join('\n')
    const tblRight = ['| A | B |', '| --- | --- |', '| foo | new |', ''].join('\n')
    const cFoo = mkComment('c-tbl-ins', 0, '表内 context', 1, tblLeft, 'foo')
    {
      const { container } = mountSidebar([cFoo], { left: tblLeft, right: tblRight })
      const table = container.querySelector('.review-diff-doc table')
      expect(table).not.toBeNull()
      expect(table?.querySelector('.diff-ins')).not.toBeNull()
      expect(docMarks(container, 'c-tbl-ins').length).toBe(0)
      expect(orphanHeader(container)).not.toBeNull()
      cleanup()
    }
    // (ii) 纯删减配对表残缝(聚焦复核 P1):删一行 + 另一行删词 → 无 ins、
    // 有 del、有 context,旧行序已被配对重排,必须回退
    const resLeft = ['| A | B |', '| --- | --- |', '| x | a b |', '| y | c |', ''].join('\n')
    const resRight = ['| A | B |', '| --- | --- |', '| x | a |', ''].join('\n')
    const cX = mkComment('c-tbl-res', 0, '残缝 context', 1, resLeft, 'x')
    {
      const { container } = mountSidebar([cX], { left: resLeft, right: resRight })
      const table = container.querySelector('.review-diff-doc table')
      expect(table).not.toBeNull()
      // 前置断言锁 fixture 形态:确实无 ins、有 del(否则残缝场景失真)
      expect(table?.querySelector('.diff-ins')).toBeNull()
      expect(table?.querySelector('.diff-del')).not.toBeNull()
      expect(docMarks(container, 'c-tbl-res').length).toBe(0)
      expect(orphanHeader(container)).not.toBeNull()
      cleanup()
    }
    // (iii) 纯 DEL 原子化整表(right 删掉整表):全部文本在 del 内、无
    // context → 保序保字面,锚定保留
    const wholeLeft = ['前文。', '', '| A | B |', '| --- | --- |', '| foo | bar |', ''].join('\n')
    const wholeRight = ['前文。', ''].join('\n')
    const cWhole = mkComment('c-tbl-del', 0, '整表被删', 1, wholeLeft, 'foo')
    {
      const { container } = mountSidebar([cWhole], { left: wholeLeft, right: wholeRight })
      expect(docMarks(container, 'c-tbl-del').length).toBeGreaterThanOrEqual(1)
      expect(orphanHeader(container)).toBeNull()
      cleanup()
    }
    // (iv) 分档生效:同 (i) 的表在 line 档为行级保序,不校验、不丢锚
    {
      const { container } = mountSidebar([cFoo], {
        left: tblLeft,
        right: tblRight,
        granularity: 'line',
      })
      expect(docMarks(container, 'c-tbl-ins').length).toBeGreaterThanOrEqual(1)
      expect(orphanHeader(container)).toBeNull()
    }
  })

  test('#9d word 档 katex 整树出流:锚在公式回退,其后锚不受计数污染', () => {
    const left = ['公式 $legacyterm+delta$ 之后是唯一尾句。', ''].join('\n')
    const right = ['公式 $newterm+delta$ 之后是唯一尾句。', ''].join('\n')
    const cMath = mkComment('c-math', 0, '锚在公式', 1, left, 'legacyterm')
    const cAfter = mkComment('c-after', 0, '公式后文', 1, left, '唯一尾句')
    const { container } = mountSidebar([cMath, cAfter], { left, right })
    // katex 输出存在且整树出流
    expect(container.querySelector('.review-diff-doc .katex')).not.toBeNull()
    expect(docMarks(container, 'c-math').length).toBe(0)
    const after = docMarks(container, 'c-after')
    expect(after.length).toBeGreaterThanOrEqual(1)
    expect(after[0]?.closest('.katex')).toBeNull()
    expect(orphanHeader(container)).not.toBeNull()
  })

  test('#9d2 katex 排除消除计数污染:selectedText 同现于公式内时不错钉(实现门 P2-2)', () => {
    // 源域 't1' 出现三次:句首、公式内、句尾;锚指句尾却按「排除 katex 后
    // 的流」应命中第 2 次。KaTeX html 输出把公式内 't1' 拆进相邻 span,但
    // collectTextSegments 拼接后仍连续——若不排除 .katex,occ=2 会错钉进
    // 公式;排除后钉中句尾 t1。
    const left = ['前 t1 中 $t1+9$ 后 t1。', ''].join('\n')
    const right = ['前 t1 中 $t2+9$ 后 t1。', ''].join('\n')
    const c = mkComment('c-pollute', 0, '计数污染探针', 2, left, 't1')
    const { container } = mountSidebar([c], { left, right })
    expect(container.querySelector('.review-diff-doc .katex')).not.toBeNull()
    const marks = docMarks(container, 'c-pollute')
    expect(marks.length).toBeGreaterThanOrEqual(1)
    expect(marks[0]?.closest('.katex')).toBeNull()
    // 钉的是「后」之后的句尾 t1,不是句首那次
    expect(marks[0]?.previousSibling?.textContent ?? '').toContain('后')
    expect(orphanHeader(container)).toBeNull()
  })

  test('#10 未定位分节:位于顶部、计数、光标类名分级', () => {
    const left = BODY
    const anchored1 = mkComment('c-a', 6, '锚定一')
    const anchored2 = mkComment('c-b', 17, '锚定二')
    const orphan = mkComment('c-o', 0, '未定位', 9, left, '第一段')
    const { container } = mountSidebar([anchored1, orphan, anchored2], { left, right: left })
    const header = orphanHeader(container)
    expect(header).not.toBeNull()
    expect(header?.textContent ?? '').toContain('1')
    // DOM 序:未定位分节标题 → 未定位气泡 → 已锚定气泡(comparator 序)
    const aside = container.querySelector('.prior-comments') as HTMLElement
    const flow = Array.from(
      aside.querySelectorAll<HTMLElement>('.prior-comments__orphan-header, article.comment-bubble'),
    )
    expect(flow[0]?.className).toContain('prior-comments__orphan-header')
    expect(flow.slice(1).map((el) => el.getAttribute('data-comment-id'))).toEqual([
      'c-o',
      'c-a',
      'c-b',
    ])
    expect(bubble(container, 'c-o')?.className).not.toContain('comment-bubble--anchored')
    expect(bubble(container, 'c-a')?.className).toContain('comment-bubble--anchored')
    expect(bubble(container, 'c-b')?.className).toContain('comment-bubble--anchored')
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
      // 阶段 2:context 存在的 TARGET 短语已锚定(mark 进 diff 文档)
      await waitFor(() => {
        expect(
          document.querySelectorAll('mark.prior-comment-anchor[data-comment-id="prior-1"]').length,
        ).toBeGreaterThan(0)
      })
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
