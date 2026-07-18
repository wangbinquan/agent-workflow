// Supplementary coverage for the loop-wrapper exit condition evaluator
// (design.md §6.4 port-count-lt). The pre-existing exit-condition.test.ts only
// ever exercises port-count-lt with the DEFAULT separator '\n' and simple
// one-token-per-line content; scheduler.test.ts likewise uses '\n' over
// 'a\nb\nc'. This file locks the untested boundaries of the count logic in
// exitCondition.ts (line 69-72):
//
//   const sep = cond.separator ?? '\n'
//   const count = portContent.length === 0 ? 0
//     : portContent.split(sep).filter((p) => p.length > 0).length
//   return count < cond.n
//
// Specifically it regression-locks:
//   1. A CUSTOM single-char separator (',') with consecutive / trailing
//      separators — the `.filter(p => p.length > 0)` drops the empty tokens,
//      so 'a,,b,' counts as 2 (['a','b']), not 4.
//   2. A CUSTOM multi-char separator (', ') that is ABSENT from the content —
//      split yields a single whole-string token, count === 1 (proven via the
//      n:1 → false / n:2 → true pair).
//   3. parseExitCondition coercions: a non-finite n (NaN) → 0 (because
//      !Number.isFinite) and a zero-length custom separator '' → default '\n'.
//
// Regression intent: a user setting separator=', ' on content joined by '\n'
// would count the WHOLE thing as 1 token (an easy off-by-many); these tests
// freeze that behavior so any future refactor that changes the filter or the
// separator coercion turns red.

import { describe, expect, test } from 'bun:test'

import {
  evaluateExitCondition,
  parseExitCondition,
  type ExitCondition,
} from '../src/services/exitCondition'

describe('evaluateExitCondition — port-count-lt custom separator + empty-token filtering', () => {
  test('consecutive/trailing separators are filtered out (sep ",", "a,,b," counts as 2)', () => {
    // split(',') = ['a', '', 'b', ''] → filter(length > 0) = ['a', 'b'] → count 2
    const cond: ExitCondition = {
      kind: 'port-count-lt',
      nodeId: 'a',
      portName: 'p',
      n: 3,
      separator: ',',
    }
    expect(evaluateExitCondition(cond, 'a,,b,')).toBe(true) // 2 < 3
    // Pin the exact count: 2 < 2 is false, 2 < 1 is false.
    expect(evaluateExitCondition({ ...cond, n: 2 }, 'a,,b,')).toBe(false)
    expect(evaluateExitCondition({ ...cond, n: 1 }, 'a,,b,')).toBe(false)
  })

  test('multi-char separator absent from content yields a single whole-string token (count === 1)', () => {
    // No ', ' present in 'one\ntwo\nthree' → split yields ['one\ntwo\nthree']
    // → count 1. Prove count === 1 via the n:1 → false / n:2 → true pair.
    const base = {
      kind: 'port-count-lt' as const,
      nodeId: 'a',
      portName: 'p',
      separator: ', ',
    }
    const content = 'one\ntwo\nthree'
    expect(evaluateExitCondition({ ...base, n: 1 }, content)).toBe(false) // 1 < 1 → false
    expect(evaluateExitCondition({ ...base, n: 2 }, content)).toBe(true) // 1 < 2 → true
  })

  test('multi-char separator present is counted normally', () => {
    // 'one, two, three'.split(', ') = ['one','two','three'] → count 3
    const cond: ExitCondition = {
      kind: 'port-count-lt',
      nodeId: 'a',
      portName: 'p',
      n: 4,
      separator: ', ',
    }
    expect(evaluateExitCondition(cond, 'one, two, three')).toBe(true) // 3 < 4
    expect(evaluateExitCondition({ ...cond, n: 3 }, 'one, two, three')).toBe(false) // 3 < 3 → false
  })

  test('empty content short-circuits to count 0 regardless of custom separator', () => {
    const cond: ExitCondition = {
      kind: 'port-count-lt',
      nodeId: 'a',
      portName: 'p',
      n: 1,
      separator: ', ',
    }
    expect(evaluateExitCondition(cond, '')).toBe(true) // 0 < 1
  })
})

describe('parseExitCondition — port-count-lt boundary coercions', () => {
  test('non-finite, missing, and non-positive n are rejected', () => {
    const cond = parseExitCondition({
      kind: 'port-count-lt',
      nodeId: 'a',
      portName: 'p',
      n: NaN,
      separator: '',
    })
    expect(cond).toBeNull()
    expect(parseExitCondition({ kind: 'port-count-lt', nodeId: 'a', portName: 'p' })).toBeNull()
    expect(
      parseExitCondition({ kind: 'port-count-lt', nodeId: 'a', portName: 'p', n: 0 }),
    ).toBeNull()
  })

  test('a valid custom separator is preserved verbatim', () => {
    const cond = parseExitCondition({
      kind: 'port-count-lt',
      nodeId: 'a',
      portName: 'p',
      n: 2,
      separator: ', ',
    })
    expect(cond).toEqual({
      kind: 'port-count-lt',
      nodeId: 'a',
      portName: 'p',
      n: 2,
      separator: ', ',
    })
  })
})
