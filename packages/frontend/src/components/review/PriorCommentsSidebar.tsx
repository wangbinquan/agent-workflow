// RFC-241 — diff 模式的「上一版检视意见」只读侧栏(阶段 2:锚定版)。
//
// 阶段 2 把 v1 的静态列表升级为与当前版侧栏同款的「锚点对齐 + 碰撞避让」
// 气泡布局:mark 由 MarkdownDiffView 在 hast 阶段包好(strict / 排除
// diff-ins·katex / word 档表格校验,见 rehypeWrapAnchors opts),本组件
// 只做只读消费——按 mark 是否存在把意见分成「未定位」(分节列于顶部,
// cursor 默认)与「已锚定」(点击滚动 + 整组 data-active 高亮,cursor
// pointer),布局走共享 useCommentBubbles(orphanPlacement 'top')。
// 仍无任何编辑/删除交互;排序与当前版侧栏共用 compareReviewComments;
// 行号标签按上一版 body 计算(computeLineRange 内部钳制越界)。
// 时间戳不显示——与既有 comment-bubble 及版本详情页一致。

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReviewComment } from '@agent-workflow/shared'
import { AttributionChip } from '@/components/AttributionChip'
import { EmptyState } from '@/components/EmptyState'
import { useCommentBubbles, type ElementRefLike } from '@/hooks/useCommentBubbles'
import { useUserLookup } from '@/hooks/useUserLookup'
import { scrollToAnchorMark, setActiveAnchorMarks } from '@/lib/review/anchorMarks'
import { compareReviewComments } from '@/lib/review/commentOrder'
import { computeLineRange } from '@/lib/review/lineRange'
import { PRIOR_ANCHOR_MARK_CLASS } from './MarkdownDiffView'
import type { DiffGranularity } from './DiffView'

const MARK_SELECTOR = `mark.${PRIOR_ANCHOR_MARK_CLASS}`

export interface PriorCommentsSidebarProps {
  comments: ReviewComment[]
  /** 上一版文档正文——行号标签由 offset 对它计算,缺它无法复用
   *  computeLineRange(设计门一轮 P1)。 */
  body: string
  versionIndex: number
  /** diff 主列容器(.review-diff-doc)的 ref:mark 查询、气泡测量与
   *  滚动定位都以它为根。 */
  docRef: ElementRefLike
  /** 当前 diff 档位——与 currentBody 一起构成重锚定 effect 的依赖:
   *  merged DOM 由 (body, currentBody, granularity) 决定,任一变化后
   *  mark 集会整体重建,分类与高亮须重算。 */
  granularity: DiffGranularity
  currentBody: string
}

export function PriorCommentsSidebar({
  comments,
  body,
  versionIndex,
  docRef,
  granularity,
  currentBody,
}: PriorCommentsSidebarProps): ReactElement {
  const { t } = useTranslation()
  const authors = useUserLookup(comments.map((c) => c.author))
  const sorted = useMemo(() => [...comments].sort(compareReviewComments), [comments])

  const containerRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLElement>(null)
  const orphanHeaderRef = useRef<HTMLDivElement>(null)
  const headerEls = useMemo(() => [headerRef, orphanHeaderRef], [])

  // 未定位集合:strict 次数不足、命中排除子树(diff-ins / katex)、word 档
  // 表格校验落空——在 DOM 上统一表现为「该意见无 mark」,只读查询即可分类,
  // 不需要渲染期副信道。
  const [unanchoredIds, setUnanchoredIds] = useState<ReadonlySet<string>>(() => new Set())
  const [activeId, setActiveId] = useState<string | null>(null)

  useLayoutEffect(() => {
    const root = docRef.current
    const next = new Set<string>()
    for (const c of comments) {
      if (
        root === null ||
        root.querySelector(`${MARK_SELECTOR}[data-comment-id="${c.id}"]`) === null
      ) {
        next.add(c.id)
      }
    }
    setUnanchoredIds((prev) => {
      if (prev.size === next.size && [...next].every((id) => prev.has(id))) return prev
      return next
    })
  }, [docRef, comments, body, currentBody, granularity])

  // active 整组高亮:merged DOM 重建(granularity / body 变化)会丢掉
  // data-active 属性,依赖里带上重建键以便重打。
  useEffect(() => {
    if (docRef.current === null) return
    setActiveAnchorMarks(docRef.current, activeId, MARK_SELECTOR)
  }, [docRef, activeId, unanchoredIds, body, currentBody, granularity])

  const orphans = sorted.filter((c) => unanchoredIds.has(c.id))
  const anchored = sorted.filter((c) => !unanchoredIds.has(c.id))

  const { bubbleTops, bubblesMinHeight } = useCommentBubbles({
    markdownRef: docRef,
    bubblesRef: containerRef,
    sortedComments: sorted,
    enabled: true,
    sidebarWidth: 0,
    editingId: null,
    markSelector: MARK_SELECTOR,
    headerEls,
    orphanPlacement: 'top',
    // 切档重建 merged DOM(comments/body 不变)后 mark 位置全变,显式触发
    // 重测;再携带分类摘要(实现门 P2-1)——anchored↔orphan 翻转会增删
    // 「未定位」分节标题、重排气泡分组,重分类后的 render 必须立即重测,
    // 不依赖 ResizeObserver 撞尺寸差兜底。
    remeasureKey: `${granularity}:${orphans.length}`,
  })
  const title = t('reviews.priorCommentsTitle', { version: versionIndex })

  const renderBubble = (c: ReviewComment, isAnchored: boolean): ReactElement => {
    const range = computeLineRange(body, c.anchor.offsetStart, c.anchor.offsetEnd)
    const lineLabel =
      range.start === range.end
        ? t('reviews.lineRef', { n: range.start })
        : t('reviews.lineRefRange', { start: range.start, end: range.end })
    const top = bubbleTops.get(c.id)
    return (
      <article
        key={c.id}
        className={
          'comment-bubble' +
          (isAnchored ? ' comment-bubble--anchored' : '') +
          (isAnchored && activeId === c.id ? ' comment-bubble--active' : '')
        }
        data-comment-id={c.id}
        style={top !== undefined ? { top: `${top}px` } : undefined}
        onClick={
          isAnchored
            ? () => {
                setActiveId(c.id)
                if (docRef.current !== null) {
                  scrollToAnchorMark(docRef.current, c.id, MARK_SELECTOR)
                }
              }
            : undefined
        }
      >
        <header className="comment-bubble__section" title={c.anchor.sectionPath}>
          {c.anchor.sectionPath || t('reviews.sidebarTitle')}
          <span className="comment-bubble__line-ref">{lineLabel}</span>
        </header>
        <blockquote className="comment-bubble__quote" title={c.anchor.selectedText}>
          {c.anchor.selectedText}
        </blockquote>
        <p className="comment-bubble__body">{c.commentText}</p>
        <footer className="comment-bubble__attribution">
          <AttributionChip
            userId={c.author}
            role={c.authorRole ?? null}
            user={authors.get(c.author)}
          />
        </footer>
      </article>
    )
  }

  return (
    <aside
      className="prior-comments"
      role="complementary"
      aria-label={title}
      ref={containerRef}
      style={bubblesMinHeight > 0 ? { minHeight: `${bubblesMinHeight}px` } : undefined}
    >
      <header className="prior-comments__header" ref={headerRef}>
        <span className="prior-comments__title">{title}</span>
        <span className="prior-comments__count">
          {t('reviews.priorCommentsCount', { count: comments.length })}
        </span>
      </header>
      {sorted.length === 0 ? (
        <EmptyState
          size="compact"
          title={t('reviews.priorCommentsEmpty')}
          data-testid="prior-comments-empty"
        />
      ) : (
        <>
          {orphans.length > 0 && (
            <div className="prior-comments__orphan-header" ref={orphanHeaderRef}>
              {t('reviews.priorCommentsUnanchored', { count: orphans.length })}
            </div>
          )}
          {orphans.map((c) => renderBubble(c, false))}
          {anchored.map((c) => renderBubble(c, true))}
        </>
      )}
    </aside>
  )
}
