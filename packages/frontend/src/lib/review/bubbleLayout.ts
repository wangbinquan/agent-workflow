// RFC-082 — pure bubble-layout math, extracted from reviews.detail.tsx's
// measure() pass so it can be unit-tested without a DOM.
//
// The review comment sidebar positions each bubble at its anchor's measured
// vertical offset, then bumps any bubble down if it would overlap the one above
// (gap = BUBBLE_GAP_PX). The DOM measurement (getBoundingClientRect on anchors
// and bubbles) stays in the `useCommentBubbles` hook; THIS function takes the
// already-measured positions/heights and produces the final `top` map + the
// column's min-height. Keeping it pure backs the source-level regression locks
// for the RFC-009 bubble behavior (header floor, collision-avoidance, orphan
// stacking) that the extraction must not change.

export const BUBBLE_GAP_PX = 8

/** One comment whose anchor was found in the rendered markdown. */
export interface LocatedBubble {
  id: string
  /** Vertical offset of the anchor relative to the bubble column's top. */
  top: number
  /** Measured height of the bubble card. */
  height: number
}

/** One comment whose anchor is missing (orphan) — stacked at the bottom. */
export interface OrphanBubble {
  id: string
  height: number
}

export interface BubbleLayoutInput {
  located: LocatedBubble[]
  orphans: OrphanBubble[]
  /** Floor the first bubble must clear so it never slides under the sticky header. */
  headerFloor: number
  /** Rendered markdown body height — the column is at least this tall. */
  rootHeight: number
  gap?: number
}

export interface BubbleLayoutResult {
  tops: Map<string, number>
  minHeight: number
}

/**
 * Place located bubbles at their anchor offset (re-sorted by measured top for
 * defensiveness), pushing each down past the previous one by `gap`; orphans are
 * stacked after the last located bubble. Returns the per-comment `top` map and
 * the column min-height (max of the running cursor and the body height).
 *
 * Mirrors reviews.detail.tsx measure() lines: header floor → located cumulative
 * cursor → orphan stacking → minHeight = max(cursor, rootHeight).
 */
export function computeBubbleLayout(input: BubbleLayoutInput): BubbleLayoutResult {
  const gap = input.gap ?? BUBBLE_GAP_PX
  // Defensive re-sort: sortedComments is already in anchor.offsetStart order,
  // but a block-reordering markdown plugin could place anchors out of that
  // order visually. Sort by measured top so the cursor walk is monotonic.
  const located = [...input.located].sort((a, b) => a.top - b.top)
  const tops = new Map<string, number>()
  let cursor = input.headerFloor
  for (const item of located) {
    const top = Math.max(item.top, cursor)
    tops.set(item.id, top)
    cursor = top + item.height + gap
  }
  for (const item of input.orphans) {
    tops.set(item.id, cursor)
    cursor = cursor + item.height + gap
  }
  return { tops, minHeight: Math.max(cursor, input.rootHeight) }
}
