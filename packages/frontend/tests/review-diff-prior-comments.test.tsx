// RFC-241 — diff 模式「上一版检视意见」只读侧栏回归(design v3 §测试策略
// 6 项)。组件级渲染断言 + 路由/样式源码锁:
//   1/3 侧栏内容(role=complementary、排序、行号、来源版本标注)与空态
//   2   只读性以 .prior-comments 容器为作用域(fixture 同时含当前版评论
//       语境下,容器内不得出现任何 actions/textbox)
//   4   historical 互斥:侧栏只能存在于 auxiliaryBodySlot 的 diff 分支、
//       在 historical 早退之后(源码序锁——diffMode 是本地 state,进入
//       historical 视图不重置,条件缺失会冒出孤立侧栏)
//   5   i18n key zh/en 齐备
//   6   布局:.review-diff-layout 两栏 + ≤1100px 堆叠 + comment-bubble
//       静态流/只读覆盖(cursor、hover 阴影)——CSS 源码锁

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, within } from '@testing-library/react'
import type { ReviewComment } from '@agent-workflow/shared'
import { api } from '../src/api/client'
import { PriorCommentsSidebar } from '../src/components/review/PriorCommentsSidebar'
import '../src/i18n'

beforeEach(() => {
  // useUserLookup 的 POST /api/users/lookup 在 api client 层打桩(setup.ts
  // 网络守卫禁止真实请求逃逸)。
  vi.spyOn(api, 'post').mockResolvedValue([
    { id: 'user-1', username: 'alice', displayName: 'Alice', role: 'user', status: 'active' },
  ] as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const REVIEWS_DETAIL_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')

const BODY = ['# 标题', '', '第一段内容甲乙丙。', '', '第二段内容丁戊己。'].join('\n')

const mkComment = (
  id: string,
  offsetStart: number,
  text: string,
  occurrenceIndex = 0,
): ReviewComment => ({
  id,
  docVersionId: 'dv-prior',
  anchor: {
    sectionPath: '## 标题',
    paragraphIdx: 0,
    offsetStart,
    offsetEnd: Math.min(offsetStart + 4, BODY.length),
    selectedText: BODY.slice(offsetStart, offsetStart + 4),
    contextBefore: '',
    contextAfter: '',
    occurrenceIndex,
  },
  commentText: text,
  author: 'user-1',
  authorRole: 'owner',
  createdAt: 1_700_000_000_000,
})

const mount = (comments: ReviewComment[]) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PriorCommentsSidebar comments={comments} body={BODY} versionIndex={3} />
    </QueryClientProvider>,
  )

describe('RFC-241 上一版检视意见只读侧栏', () => {
  test('#1 三条意见:role=complementary、来源版本标注、排序与行号标签', () => {
    const { container } = mount([
      mkComment('c-late', 30, '后面的意见'),
      mkComment('c-early', 10, '前面的意见'),
      mkComment('c-mid', 30, '同起点后出现', 1),
    ])
    const aside = container.querySelector('[role="complementary"]')
    expect(aside).not.toBeNull()
    expect(aside?.getAttribute('aria-label') ?? '').toContain('v3')
    const items = Array.from(container.querySelectorAll('article.comment-bubble'))
    expect(items.length).toBe(3)
    // 排序:offsetStart 升序 → occurrenceIndex 升序(commentOrder 唯一事实源)
    expect(items.map((a) => a.getAttribute('data-comment-id'))).toEqual([
      'c-early',
      'c-late',
      'c-mid',
    ])
    // 行号标签由上一版 body 计算,非空
    expect(items[0]?.querySelector('.comment-bubble__line-ref')?.textContent ?? '').not.toBe('')
    // 意见正文与作者行可见
    expect(items[0]?.querySelector('.comment-bubble__body')?.textContent).toBe('前面的意见')
    expect(items[0]?.querySelector('.comment-bubble__attribution')).not.toBeNull()
  })

  test('#2 只读性(容器作用域):无 actions、无 textbox、无按钮', () => {
    const { container } = mount([mkComment('c1', 10, '意见一'), mkComment('c2', 30, '意见二')])
    const aside = container.querySelector('[role="complementary"]') as HTMLElement
    const scoped = within(aside)
    expect(aside.querySelectorAll('.comment-bubble__actions').length).toBe(0)
    expect(scoped.queryAllByRole('textbox').length).toBe(0)
    expect(scoped.queryAllByRole('button').length).toBe(0)
  })

  test('#3 零条意见 → EmptyState 可见(不隐藏侧栏)', () => {
    const { container } = mount([])
    expect(container.querySelector('[role="complementary"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="prior-comments-empty"]')).not.toBeNull()
  })

  test('#4 historical 互斥源码序锁:侧栏仅在 auxiliaryBodySlot 的 diff 分支、historical 早退之后', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    // 只允许一个渲染点
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
    // 侧栏与 DiffView 同层包在 .review-diff-layout 内
    expect(slotBody.indexOf('className="review-diff-layout"')).toBeLessThan(sidebarIdx)
  })

  test('#5 i18n key zh/en 齐备', () => {
    const zh = readFileSync(resolve(__dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf8')
    const en = readFileSync(resolve(__dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf8')
    expect(zh).toMatch(/priorCommentsTitle:\s*string/)
    for (const key of ['priorCommentsTitle', 'priorCommentsCount', 'priorCommentsEmpty']) {
      expect(zh).toMatch(new RegExp(key + ":\\s*'"))
      expect(en).toMatch(new RegExp(key + ":\\s*'"))
    }
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
