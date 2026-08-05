// RFC-258 §4.1 — map a file's diff hunks onto WORKTREE-side line ranges for
// the full-file view's change gutter. Pure: hunk coords in, merged 1-based
// [start,end] ranges out. A pure-delete hunk has no worktree lines and is
// dropped (the full view renders the worktree side; deletions live in the
// hunk view).

import type { HunkInfo } from './changeReview'

export interface ChangedRange {
  start: number
  end: number
  type: 'added' | 'modified'
}

export function fullFileRanges(hunks: readonly HunkInfo[]): ChangedRange[] {
  const raw: ChangedRange[] = []
  for (const h of hunks) {
    if (h.newCount === 0) continue // pure delete — nothing on the worktree side
    raw.push({
      start: h.newStart,
      end: h.newStart + h.newCount - 1,
      type: h.oldCount === 0 ? 'added' : 'modified',
    })
  }
  raw.sort((a, b) => a.start - b.start)
  // merge touching/overlapping ranges; mixed types merge to 'modified'
  const out: ChangedRange[] = []
  for (const r of raw) {
    const last = out[out.length - 1]
    if (last !== undefined && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end)
      if (last.type !== r.type) last.type = 'modified'
    } else {
      out.push({ ...r })
    }
  }
  return out
}

export interface FoldSegment {
  start: number
  end: number
  folded: boolean
}

const FOLD_MIN_LINES = 21
const CONTEXT_LINES = 3

/** Split [1..totalLines] into visible/folded segments: unchanged stretches
 *  longer than 20 lines fold, keeping CONTEXT_LINES around changed ranges and
 *  the focus line's stretch open. */
export function foldSegments(
  totalLines: number,
  changed: readonly ChangedRange[],
  focusLine?: number,
): FoldSegment[] {
  if (totalLines <= 0) return []
  const keep = new Array<boolean>(totalLines + 1).fill(false)
  const markKeep = (from: number, to: number): void => {
    for (let i = Math.max(1, from); i <= Math.min(totalLines, to); i++) keep[i] = true
  }
  for (const r of changed) markKeep(r.start - CONTEXT_LINES, r.end + CONTEXT_LINES)
  if (focusLine !== undefined) markKeep(focusLine - CONTEXT_LINES, focusLine + CONTEXT_LINES)

  const out: FoldSegment[] = []
  let segStart = 1
  let segKeep = keep[1] ?? false
  for (let i = 2; i <= totalLines + 1; i++) {
    const k = i <= totalLines ? (keep[i] ?? false) : !segKeep // force flush at end
    if (k !== segKeep) {
      out.push({ start: segStart, end: i - 1, folded: !segKeep })
      segStart = i
      segKeep = k
    }
  }
  // short unchanged stretches don't fold — flip them back to visible
  for (const s of out) {
    if (s.folded && s.end - s.start + 1 < FOLD_MIN_LINES) s.folded = false
  }
  // merge neighbours that ended up with the same folded flag
  const merged: FoldSegment[] = []
  for (const s of out) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.folded === s.folded) last.end = s.end
    else merged.push({ ...s })
  }
  return merged
}
