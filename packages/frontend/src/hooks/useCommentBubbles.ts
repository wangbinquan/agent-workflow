// RFC-241 阶段 2 — 从 ReviewDocPane 抽取的「意见气泡随锚点定位」DOM 测量
// hook(computeBubbleLayout 的 DOM 包装)。抽取动机:上一版只读侧栏
// (PriorCommentsSidebar)要复用同一套「测锚点 → 碰撞避让布局 → 注入
// top + minHeight」机制,但 mark 选择器 / header floor 元素 / 未定位气泡
// 落位三处此前硬编码在 ReviewDocPane 内。参数化契约(design v6 §机制 2):
//   - markSelector:锚 mark 的 CSS 选择器前缀(当前版
//     'mark.comment-anchor',上一版 'mark.prior-comment-anchor')。
//   - headerEls:计入 headerFloor 的显式元素 ref 列表(不再硬编码
//     '.review-detail__sidebar-header';上一版侧栏把标题 + 「未定位」分节
//     两个元素都计入)。缺席 ref 计 0;至少一个在场时 floor = Σ高度 + gap,
//     与旧单元素公式逐字节等价。
//   - orphanPlacement:未定位气泡落位,默认 'bottom' 保 ReviewDocPane
//     现行为;上一版侧栏传 'top'。
// 调用方须保证 headerEls 数组引用稳定(useMemo / 模块常量),否则每次
// render 都重跑测量 effect。

import { anchorMarkSelector } from '@/lib/review/anchorMarks'
import { useLayoutEffect, useState } from 'react'
import type { ReviewComment } from '@agent-workflow/shared'
import { BUBBLE_GAP_PX, computeBubbleLayout } from '@/lib/review/bubbleLayout'

/** 结构性 ref 形状(readonly current),兼容 HTMLDivElement 等具体元素 ref。 */
export interface ElementRefLike {
  readonly current: HTMLElement | null
}

export interface UseCommentBubblesParams {
  markdownRef: ElementRefLike
  bubblesRef: ElementRefLike
  sortedComments: ReviewComment[]
  enabled: boolean
  /** 重测键:侧栏宽度变化需重测(无可变宽度的调用方传 0)。 */
  sidebarWidth: number
  /** 重测键:行内编辑开合需立即重测(无编辑态的调用方传 null)。 */
  editingId: string | null
  markSelector: string
  headerEls: ReadonlyArray<ElementRefLike>
  orphanPlacement?: 'top' | 'bottom'
  /** 额外重测键:文档 DOM 会在 sortedComments 之外的输入下重建时传入
   *  (上一版侧栏传 diff granularity——切档重建 merged DOM 后 mark 位置
   *  全变,不能只靠 ResizeObserver 撞尺寸变化兜底)。 */
  remeasureKey?: unknown
}

export function useCommentBubbles(params: UseCommentBubblesParams): {
  bubbleTops: Map<string, number>
  bubblesMinHeight: number
} {
  const {
    markdownRef,
    bubblesRef,
    sortedComments,
    enabled,
    sidebarWidth,
    editingId,
    markSelector,
    headerEls,
    orphanPlacement,
    remeasureKey,
  } = params
  const [bubbleTops, setBubbleTops] = useState<Map<string, number>>(new Map())
  const [bubblesMinHeight, setBubblesMinHeight] = useState<number>(0)

  useLayoutEffect(() => {
    if (markdownRef.current === null || bubblesRef.current === null) return
    if (!enabled) return

    const measure = (): void => {
      const root = markdownRef.current
      const col = bubblesRef.current
      if (root === null || col === null) return
      const colTop = col.getBoundingClientRect().top
      let headerSum = 0
      let anyHeader = false
      for (const ref of headerEls) {
        if (ref.current === null) continue
        anyHeader = true
        headerSum += ref.current.offsetHeight
      }
      const headerFloor = anyHeader ? headerSum + BUBBLE_GAP_PX : 0
      const located: { id: string; top: number; height: number }[] = []
      const orphans: { id: string; height: number }[] = []
      for (const c of sortedComments) {
        const bubble = col.querySelector<HTMLElement>(`.comment-bubble[data-comment-id="${c.id}"]`)
        const h = bubble?.getBoundingClientRect().height ?? 0
        // RFC-326:重叠代码锚的共享原子段只在 data-comment-ids 里带后开始的那条 id。
        const el = root.querySelector<HTMLElement>(anchorMarkSelector(markSelector, c.id))
        if (el === null) {
          orphans.push({ id: c.id, height: h })
          continue
        }
        const rect = el.getBoundingClientRect()
        located.push({ id: c.id, top: rect.top - colTop, height: h })
      }
      const { tops, minHeight } = computeBubbleLayout({
        located,
        orphans,
        headerFloor,
        rootHeight: root.getBoundingClientRect().height,
        orphanPlacement,
      })
      setBubbleTops(tops)
      setBubblesMinHeight(minHeight)
    }

    measure()

    const ro = new ResizeObserver(() => measure())
    ro.observe(markdownRef.current)
    ro.observe(bubblesRef.current)
    bubblesRef.current
      .querySelectorAll<HTMLElement>('.comment-bubble')
      .forEach((b) => ro.observe(b))
    const onResize = (): void => measure()
    window.addEventListener('resize', onResize)
    const onScroll = (): void => measure()
    window.addEventListener('scroll', onScroll, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onScroll, true)
    }
    // editingId in deps so opening/closing inline edit re-measures immediately.
  }, [
    markdownRef,
    bubblesRef,
    sortedComments,
    enabled,
    sidebarWidth,
    editingId,
    markSelector,
    headerEls,
    orphanPlacement,
    remeasureKey,
  ])

  return { bubbleTops, bubblesMinHeight }
}
