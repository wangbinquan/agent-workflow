// RFC-258 §4.2 (gate F-05) — map a click inside a unified-diff hunk BODY onto
// a (side, file line, file col) point. Pure state machine over the hunk's
// prefixed rows:
//   ' ' context → both counters advance; the click resolves to the WORKTREE
//   '+' added   → new counter only; resolves to the WORKTREE side
//   '-' deleted → old counter only; resolves to the BASE side
// The leading marker column is not code: col 1 returns null, code col = col-1.

import type { HunkInfo } from './changeReview'

export interface FilePoint {
  side: 'base' | 'worktree'
  line: number
  col: number
}

/**
 * `lines` is the diff block's full line array; `bodyRowIdx` is 0-based within
 * the hunk body (row 0 = the first line AFTER the `@@` header); `colInRow` is
 * the 1-based column inside that rendered row INCLUDING the marker char.
 */
export function hunkPointToFilePoint(
  lines: readonly string[],
  hunk: HunkInfo,
  bodyRowIdx: number,
  colInRow: number,
): FilePoint | null {
  if (bodyRowIdx < 0 || colInRow <= 1) return null
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  // impl-gate P2-3 — the body is bounded by the hunk's own counters; walking
  // past them would treat the NEXT @@ header as a context row.
  let oldLeft = hunk.oldCount
  let newLeft = hunk.newCount
  for (let i = 0; ; i++) {
    if (oldLeft <= 0 && newLeft <= 0) return null
    const row = lines[hunk.headerIndex + 1 + i]
    if (row === undefined) return null
    const marker = row[0] ?? ' '
    if (marker === '\\') {
      // "\ No newline at end of file" — not code, consumes no counters
      if (i === bodyRowIdx) return null
      continue
    }
    if (i === bodyRowIdx) {
      switch (marker) {
        case '+':
          return { side: 'worktree', line: newLine, col: colInRow - 1 }
        case '-':
          return { side: 'base', line: oldLine, col: colInRow - 1 }
        default:
          return { side: 'worktree', line: newLine, col: colInRow - 1 }
      }
    }
    switch (marker) {
      case '+':
        newLine += 1
        newLeft -= 1
        break
      case '-':
        oldLine += 1
        oldLeft -= 1
        break
      default:
        oldLine += 1
        newLine += 1
        oldLeft -= 1
        newLeft -= 1
        break
    }
  }
}
