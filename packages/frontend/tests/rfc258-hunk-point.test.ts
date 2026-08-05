// RFC-258 T7 (gate F-05) — hunk body row → (side, file line, col) over the
// FULL input domain: context rows advance both counters, '+' only new,
// '-' only old; deleted rows resolve to the BASE side; the marker column is
// never code; the no-newline marker row is inert.

import { describe, expect, test } from 'vitest'
import { hunkPointToFilePoint } from '../src/lib/hunkPoint'
import type { HunkInfo } from '../src/lib/changeReview'

// @@ -10,3 +20,4 @@ … body below (indexes relative to lines[])
const LINES = [
  'diff --git a/a.ts b/a.ts',
  '@@ -10,3 +20,4 @@',
  ' context_one', //   old 10 / new 20
  '-removed_line', //  old 11
  '+added_one', //     new 21
  '+added_two', //     new 22
  ' context_two', //   old 12 / new 23
  '\\ No newline at end of file',
]
const HUNK: HunkInfo = { headerIndex: 1, oldStart: 10, oldCount: 3, newStart: 20, newCount: 4 }

describe('hunkPointToFilePoint (F-05)', () => {
  test('context row resolves to the worktree with BOTH counters advanced', () => {
    expect(hunkPointToFilePoint(LINES, HUNK, 0, 3)).toEqual({
      side: 'worktree',
      line: 20,
      col: 2,
    })
    // the second context row sits after 1 del + 2 adds
    expect(hunkPointToFilePoint(LINES, HUNK, 4, 3)).toEqual({
      side: 'worktree',
      line: 23,
      col: 2,
    })
  })

  test('deleted row resolves to the BASE side at the OLD line', () => {
    expect(hunkPointToFilePoint(LINES, HUNK, 1, 2)).toEqual({ side: 'base', line: 11, col: 1 })
  })

  test('added rows resolve to consecutive NEW lines', () => {
    expect(hunkPointToFilePoint(LINES, HUNK, 2, 2)).toEqual({ side: 'worktree', line: 21, col: 1 })
    expect(hunkPointToFilePoint(LINES, HUNK, 3, 2)).toEqual({ side: 'worktree', line: 22, col: 1 })
  })

  test('marker column, negative rows and the no-newline marker are null', () => {
    expect(hunkPointToFilePoint(LINES, HUNK, 0, 1)).toBeNull() // the marker char
    expect(hunkPointToFilePoint(LINES, HUNK, -1, 5)).toBeNull()
    expect(hunkPointToFilePoint(LINES, HUNK, 5, 3)).toBeNull() // "\ No newline"
  })

  test('rows past the hunk body are null (never runs off the block)', () => {
    expect(hunkPointToFilePoint(LINES, HUNK, 99, 3)).toBeNull()
  })
})
