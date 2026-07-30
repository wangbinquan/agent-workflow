// RFC-239 §1.4 — hunk ↔ symbol mapping for the structure-annotated diff.
//
// Design-gate P0-1 domain rules, all encoded here:
//  - side choice: added/modified/renamed/MOVED → after+new; removed → before+old;
//    a missing chosen-side node falls back to the other side.
//  - a hunk side with count===0 is an EMPTY range (pure-add old side /
//    pure-delete new side) and never participates in overlap.
//  - a symbol with no range, or a file with no hunks → null (no jump).
//  - closed-interval endpoint equality counts as overlap.
//  - zero overlap (declaration untouched, e.g. comment-only line moves) →
//    nearest hunk by start-line distance; ties break to the SMALLER start.

import type { SymbolChange, SymbolNode } from '@agent-workflow/shared'
import type { HunkInfo } from './changeReview'

type Side = 'old' | 'new'

function sideRange(h: HunkInfo, side: Side): { start: number; end: number } | null {
  const start = side === 'old' ? h.oldStart : h.newStart
  const count = side === 'old' ? h.oldCount : h.newCount
  if (count === 0) return null
  return { start, end: start + count - 1 }
}

function chooseSide(change: SymbolChange): { node: SymbolNode; side: Side } | null {
  const preferAfter = change.changeType !== 'removed'
  const primary = preferAfter ? change.after : change.before
  const fallback = preferAfter ? change.before : change.after
  if (primary?.range !== undefined) {
    return { node: primary, side: preferAfter ? 'new' : 'old' }
  }
  if (fallback?.range !== undefined) {
    return { node: fallback, side: preferAfter ? 'old' : 'new' }
  }
  return null
}

/** The hunk a symbol row should jump to, or null when unmappable. */
export function hunkForSymbol(change: SymbolChange, hunks: readonly HunkInfo[]): HunkInfo | null {
  if (hunks.length === 0) return null
  const chosen = chooseSide(change)
  if (chosen === null) return null
  const range = chosen.node.range
  if (range === undefined) return null

  let best: HunkInfo | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const h of hunks) {
    const r = sideRange(h, chosen.side)
    if (r === null) continue
    // closed-interval overlap (endpoint equality overlaps)
    if (r.start <= range.endLine && range.startLine <= r.end) return h
    const distance = r.start > range.endLine ? r.start - range.endLine : range.startLine - r.end
    if (
      distance < bestDistance ||
      (distance === bestDistance &&
        best !== null &&
        r.start < (sideRange(best, chosen.side)?.start ?? Infinity))
    ) {
      bestDistance = distance
      best = h
    }
  }
  return best
}

/** The innermost symbol containing `line` on `side` (smallest enclosing
 *  range wins), or null. Drives the hunk badges + the sticky current-symbol
 *  bar on the diff. */
export function symbolAtLine(
  changes: readonly SymbolChange[],
  side: Side,
  line: number,
): SymbolChange | null {
  let best: SymbolChange | null = null
  let bestSpan = Number.POSITIVE_INFINITY
  for (const c of changes) {
    const node = side === 'new' ? (c.after ?? c.before) : (c.before ?? c.after)
    const range = node?.range
    if (range === undefined) continue
    if (line < range.startLine || line > range.endLine) continue
    const span = range.endLine - range.startLine
    if (span < bestSpan) {
      bestSpan = span
      best = c
    }
  }
  return best
}

/** Owning symbol for a hunk (badge on the hunk header): the innermost symbol
 *  at the hunk's first content line — new side normally, old side for a
 *  pure-delete hunk. */
export function symbolForHunk(
  changes: readonly SymbolChange[],
  hunk: HunkInfo,
): SymbolChange | null {
  if (hunk.newCount > 0) return symbolAtLine(changes, 'new', hunk.newStart)
  if (hunk.oldCount > 0) return symbolAtLine(changes, 'old', hunk.oldStart)
  return null
}
