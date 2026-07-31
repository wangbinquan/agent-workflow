// RFC-241 — 评审意见的展示排序比较器,从 ReviewDocPane 的 sortedComments
// 抽出共享:offsetStart 升序 → occurrenceIndex 升序。当前版侧栏
// (ReviewDocPane)与上一版只读侧栏(PriorCommentsSidebar)必须同序,
// 这里是唯一事实源。

import type { ReviewComment } from '@agent-workflow/shared'

export function compareReviewComments(a: ReviewComment, b: ReviewComment): number {
  if (a.anchor.offsetStart !== b.anchor.offsetStart) {
    return a.anchor.offsetStart - b.anchor.offsetStart
  }
  return a.anchor.occurrenceIndex - b.anchor.occurrenceIndex
}
