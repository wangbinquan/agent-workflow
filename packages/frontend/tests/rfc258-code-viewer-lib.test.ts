// RFC-258 T5 — the pure layers under CodeViewer: hunk→full-file change
// ranges, fold segmentation, and the identifier tokenizer (gate F-10: `#`
// private names match explicitly; unicode letters are OUT of the identifier
// domain by design).

import { describe, expect, test } from 'vitest'
import { fullFileRanges, foldSegments } from '../src/lib/fullFileRanges'
import { tokenAt } from '../src/lib/identifierClick'
import type { HunkInfo } from '../src/lib/changeReview'

const hunk = (
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
): HunkInfo => ({
  headerIndex: 0,
  oldStart,
  oldCount,
  newStart,
  newCount,
})

describe('fullFileRanges', () => {
  test('add-only hunk → added; mixed hunk → modified; pure delete dropped', () => {
    expect(fullFileRanges([hunk(10, 0, 11, 3)])).toEqual([{ start: 11, end: 13, type: 'added' }])
    expect(fullFileRanges([hunk(5, 2, 5, 4)])).toEqual([{ start: 5, end: 8, type: 'modified' }])
    expect(fullFileRanges([hunk(9, 3, 9, 0)])).toEqual([])
  })

  test('touching ranges merge; mixed types collapse to modified', () => {
    expect(fullFileRanges([hunk(1, 0, 1, 3), hunk(2, 2, 4, 2)])).toEqual([
      { start: 1, end: 5, type: 'modified' },
    ])
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
