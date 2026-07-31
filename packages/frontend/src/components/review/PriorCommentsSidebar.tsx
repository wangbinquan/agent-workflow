// RFC-241 — diff 模式的「上一版检视意见」只读侧栏。
//
// 纯展示:复用 comment-bubble 视觉命名空间(样式层用 .prior-comments
// 覆盖为静态流 + cursor: default,见 styles.css),无任何编辑/删除/跳转
// 交互;行号标签复用 computeLineRange(需要该版本 body,offset 越界由其
// 内部钳制);排序与当前版侧栏共用 compareReviewComments 唯一事实源;
// 作者行沿用 AttributionChip(RFC-099 UI-only 语义)。时间戳不显示——
// 与既有 comment-bubble 及版本详情页一致(设计门二轮勘误)。

import { useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReviewComment } from '@agent-workflow/shared'
import { AttributionChip } from '@/components/AttributionChip'
import { EmptyState } from '@/components/EmptyState'
import { useUserLookup } from '@/hooks/useUserLookup'
import { compareReviewComments } from '@/lib/review/commentOrder'
import { computeLineRange } from '@/lib/review/lineRange'

export interface PriorCommentsSidebarProps {
  comments: ReviewComment[]
  /** 上一版文档正文——行号标签由 offset 对它计算,缺它无法复用
   *  computeLineRange(设计门一轮 P1)。 */
  body: string
  versionIndex: number
}

export function PriorCommentsSidebar({
  comments,
  body,
  versionIndex,
}: PriorCommentsSidebarProps): ReactElement {
  const { t } = useTranslation()
  const authors = useUserLookup(comments.map((c) => c.author))
  const sorted = useMemo(() => [...comments].sort(compareReviewComments), [comments])
  const title = t('reviews.priorCommentsTitle', { version: versionIndex })
  return (
    <aside className="prior-comments" role="complementary" aria-label={title}>
      <header className="prior-comments__header">
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
        sorted.map((c) => {
          const range = computeLineRange(body, c.anchor.offsetStart, c.anchor.offsetEnd)
          const lineLabel =
            range.start === range.end
              ? t('reviews.lineRef', { n: range.start })
              : t('reviews.lineRefRange', { start: range.start, end: range.end })
          return (
            <article key={c.id} className="comment-bubble" data-comment-id={c.id}>
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
        })
      )}
    </aside>
  )
}
