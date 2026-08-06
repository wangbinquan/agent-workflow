// RFC-258 §4.1 — map a file's diff hunks onto WORKTREE-side line ranges for
// the full-file view's change gutter. Pure: the hunk BODY rows drive the
// ranges — the header's newCount includes CONTEXT rows, so using it painted
// unchanged lines as modified (user report: "diff 改了 2 行,全文标了一大段").
// Only '+' rows produce ranges: a '+' run preceded by a '-' run is a
// modification; an isolated '+' run is an addition. Deleted rows have no
// worktree line (they live in the hunk view).

import type { HunkInfo } from './changeReview'

export interface ChangedRange {
  start: number
  end: number
  type: 'added' | 'modified'
}

export function fullFileRanges(
  lines: readonly string[],
  hunks: readonly HunkInfo[],
): ChangedRange[] {
  const raw: ChangedRange[] = []
  for (const h of hunks) {
    let newLine = h.newStart
    let oldLeft = h.oldCount
    let newLeft = h.newCount
    let pendingDel = false
    let run: ChangedRange | null = null
    const flushRun = (): void => {
      if (run !== null) raw.push(run)
      run = null
    }
    for (let i = h.headerIndex + 1; oldLeft > 0 || newLeft > 0; i++) {
      const row = lines[i]
      if (row === undefined) break
      const marker = row[0] ?? ' '
      if (marker === '\\') continue // "\ No newline" — consumes no counters
      if (marker === '+') {
        const type = pendingDel ? 'modified' : 'added'
        if (run !== null && run.type === type && run.end === newLine - 1) run.end = newLine
        else {
          flushRun()
          run = { start: newLine, end: newLine, type }
        }
        newLine += 1
        newLeft -= 1
      } else if (marker === '-') {
        pendingDel = true
        flushRun()
        oldLeft -= 1
      } else {
        pendingDel = false
        flushRun()
        newLine += 1
        oldLeft -= 1
        newLeft -= 1
      }
    }
    flushRun()
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
