// DiffView — RFC-005 PR-E T34（最初版本）→ RFC-010 重构。
//
// 当前形态：薄壳，三种 granularity（word / line / block）全部 delegate 到
// MarkdownDiffView 走渲染态内联 diff。
//
// 历史：原实现是 jsdiff + 左右两栏源码红绿块 + 标题 slug 滚动同步；
// RFC-010 把 word 模式换成 prose 渲染态后又把 line / block 也并入同一管线，
// 旧 pane / scroll-sync / _internal helper 整体删除（不留死代码）。
//
// 公开接口（DiffViewProps、DiffGranularity）保持不变，调用方 reviews.detail
// 零改动。

import type { AnchorWrapInput } from '@/components/prose/rehypeWrapAnchors'
import { MarkdownDiffView } from './MarkdownDiffView'

export type DiffGranularity = 'word' | 'line' | 'block'

export interface DiffViewProps {
  left: string
  right: string
  granularity: DiffGranularity
  /** 仅用于在外层标题栏展示版本号 / decision，不影响 diff 渲染。 */
  leftLabel?: string
  rightLabel?: string
  /** RFC-241 阶段 2:上一版检视意见锚(透传 MarkdownDiffView)。 */
  priorAnchors?: ReadonlyArray<AnchorWrapInput>
}

export function DiffView({
  left,
  right,
  granularity,
  leftLabel,
  rightLabel,
  priorAnchors,
}: DiffViewProps) {
  return (
    <div className="diff-view diff-view--inline" data-granularity={granularity}>
      {(leftLabel !== undefined || rightLabel !== undefined) && (
        <div className="diff-view__inline-labels">
          {leftLabel !== undefined && <span className="diff-view__label muted">{leftLabel}</span>}
          {rightLabel !== undefined && <span className="diff-view__label muted">{rightLabel}</span>}
        </div>
      )}
      <MarkdownDiffView
        left={left}
        right={right}
        granularity={granularity}
        priorAnchors={priorAnchors}
      />
    </div>
  )
}
