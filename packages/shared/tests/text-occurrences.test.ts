// RFC-326 T1 — the ONE implementation of "which occurrence is the N-th".
//
// Three consumers (backend canonicaliser, collaboration anchor resolver, web
// highlighter) used to keep their own copies; the highlighter's had drifted to
// overlapping counting. These tests pin the shared semantics: non-overlapping,
// left-to-right, 1-based visitor index, early stop, exact total.

import { describe, expect, test } from 'bun:test'

import { findAllOccurrences, forEachOccurrence } from '../src/textOccurrences'

describe('findAllOccurrences', () => {
  test('returns 0-based offsets in document order', () => {
    expect(findAllOccurrences('a-b-a-b-a', 'a')).toEqual([0, 4, 8])
  })

  test('is NON-overlapping: `aa` in `aaaa` is two occurrences, not three', () => {
    expect(findAllOccurrences('aaaa', 'aa')).toEqual([0, 2])
  })

  test('empty needle never matches', () => {
    expect(findAllOccurrences('anything', '')).toEqual([])
  })

  test('counts UTF-16 code units, so CJK offsets line up with String.prototype.slice', () => {
    const body = '订单状态 order_status 订单状态'
    const offsets = findAllOccurrences(body, '订单状态')
    expect(offsets).toEqual([0, 18])
    expect(body.slice(offsets[1]!, offsets[1]! + 4)).toBe('订单状态')
  })
})

describe('forEachOccurrence', () => {
  test('visits with a 1-based index and returns the exact total', () => {
    const seen: Array<[number, number]> = []
    const total = forEachOccurrence('x.x.x', 'x', (offset, index) => {
      seen.push([offset, index])
    })
    expect(seen).toEqual([
      [0, 1],
      [2, 2],
      [4, 3],
    ])
    expect(total).toBe(3)
  })

  test('returning false stops the scan and the count reflects what was visited', () => {
    let visited = 0
    const total = forEachOccurrence('x.x.x.x', 'x', () => {
      visited += 1
      return visited < 2
    })
    expect(visited).toBe(2)
    expect(total).toBe(2)
  })

  test('agrees with findAllOccurrences on overlapping needles', () => {
    const offsets: number[] = []
    forEachOccurrence('aaaa', 'aa', (offset) => {
      offsets.push(offset)
    })
    expect(offsets).toEqual(findAllOccurrences('aaaa', 'aa'))
  })

  test('empty needle visits nothing and returns 0', () => {
    let calls = 0
    expect(
      forEachOccurrence('abc', '', () => {
        calls += 1
      }),
    ).toBe(0)
    expect(calls).toBe(0)
  })
})
