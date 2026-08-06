// RFC-258 T5 — the pure layers under CodeViewer: hunk→full-file change
// ranges, fold segmentation, and the identifier tokenizer (gate F-10: `#`
// private names match explicitly; unicode letters are OUT of the identifier
// domain by design).

import { describe, expect, test } from 'vitest'
import { fullFileRanges, foldSegments } from '../src/lib/fullFileRanges'
import { tokenAt } from '../src/lib/identifierClick'
import type { HunkInfo } from '../src/lib/changeReview'

describe('fullFileRanges (body-driven — header newCount includes context, user bug)', () => {
  // block: header + body rows; hunk covers old 10,4 → new 10,5
  const LINES = [
    '@@ -10,4 +10,5 @@',
    ' ctx one', //      new 10  (context — must NOT be painted)
    '-old line', //     (base only)
    '+new line', //     new 11  modified (follows a '-')
    ' ctx two', //      new 12  context
    '+pure add', //     new 13  added (no preceding '-')
    ' ctx three', //    new 14  context
  ]
  const HUNK: HunkInfo = { headerIndex: 0, oldStart: 10, oldCount: 4, newStart: 10, newCount: 5 }

  test("only '+' rows paint; context rows never do (2-line diff paints 2 lines)", () => {
    expect(fullFileRanges(LINES, [HUNK])).toEqual([
      { start: 11, end: 11, type: 'modified' },
      { start: 13, end: 13, type: 'added' },
    ])
  })

  test('a consecutive +run after a -run is one modified range', () => {
    const lines = ['@@ -1,2 +1,3 @@', '-a', '-b', '+x', '+y', '+z']
    const hunk: HunkInfo = { headerIndex: 0, oldStart: 1, oldCount: 2, newStart: 1, newCount: 3 }
    expect(fullFileRanges(lines, [hunk])).toEqual([{ start: 1, end: 3, type: 'modified' }])
  })

  test('pure delete paints nothing on the worktree side', () => {
    const lines = ['@@ -5,2 +5,0 @@', '-gone', '-also gone']
    const hunk: HunkInfo = { headerIndex: 0, oldStart: 5, oldCount: 2, newStart: 5, newCount: 0 }
    expect(fullFileRanges(lines, [hunk])).toEqual([])
  })

  test('touching ranges merge; mixed types collapse to modified', () => {
    const lines = [
      '@@ -1,1 +1,2 @@',
      '+added one', //  new 1 added
      '-old', //        base
      '+changed', //    new 2 modified — touches new 1 → merged modified
    ]
    const hunk: HunkInfo = { headerIndex: 0, oldStart: 1, oldCount: 1, newStart: 1, newCount: 2 }
    expect(fullFileRanges(lines, [hunk])).toEqual([{ start: 1, end: 2, type: 'modified' }])
  })
})

describe('foldSegments', () => {
  test('long unchanged stretch folds, keeping 3 context lines around a change', () => {
    const segs = foldSegments(100, [{ start: 50, end: 52, type: 'modified' }])
    expect(segs).toEqual([
      { start: 1, end: 46, folded: true },
      { start: 47, end: 55, folded: false },
      { start: 56, end: 100, folded: true },
    ])
  })

  test('short unchanged stretches stay visible; focus line opens its stretch', () => {
    expect(foldSegments(15, [{ start: 8, end: 8, type: 'added' }])).toEqual([
      { start: 1, end: 15, folded: false },
    ])
    const withFocus = foldSegments(200, [], 100)
    expect(withFocus.some((s) => !s.folded && s.start <= 100 && 100 <= s.end)).toBe(true)
  })

  test('empty file → no segments', () => {
    expect(foldSegments(0, [])).toEqual([])
  })
})

describe('tokenAt (F-10)', () => {
  const line = 'const x = this.#secret + verifyManifest(a_b, $q)'

  test('hits inside a plain identifier and at its first char', () => {
    expect(tokenAt(line, 7)).toBe('x')
    expect(tokenAt(line, 26)).toBe('verifyManifest')
  })

  test('#private matches WITH the # prefix', () => {
    const hashCol = line.indexOf('#secret') + 1
    expect(tokenAt(line, hashCol)).toBe('#secret')
    expect(tokenAt(line, hashCol + 3)).toBe('#secret')
  })

  test('underscore/dollar identifiers; operators and spaces return null', () => {
    expect(tokenAt(line, line.indexOf('a_b') + 2)).toBe('a_b')
    expect(tokenAt(line, line.indexOf('$q') + 1)).toBe('$q')
    expect(tokenAt(line, line.indexOf('=') + 1)).toBeNull()
    expect(tokenAt(line, line.indexOf(' + ') + 2)).toBeNull()
  })

  test('out-of-range and end-exclusive columns return null', () => {
    expect(tokenAt('ab', 0)).toBeNull()
    expect(tokenAt('ab', 3)).toBeNull() // col past the last char
    expect(tokenAt('ab cd', 3)).toBeNull() // the space between tokens
  })
})
