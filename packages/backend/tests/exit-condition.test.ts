// Exit condition evaluator unit tests. Covers all four built-in kinds —
// port-empty / port-not-empty / port-equals / port-count-lt — plus the
// parser's tolerance for missing or malformed input.
//
// port-not-empty was added for the RFC-023 clarify use case: wrap the
// (agent → clarify → agent) cycle in a wrapper-loop, watch the agent's
// real output port, and exit the loop the moment the agent stops asking
// back and finally produces output.

import { describe, expect, test } from 'bun:test'

import {
  evaluateExitCondition,
  parseExitCondition,
  type ExitCondition,
} from '../src/services/exitCondition'

describe('parseExitCondition', () => {
  test('parses port-empty with nodeId + portName', () => {
    const cond = parseExitCondition({ kind: 'port-empty', nodeId: 'agent', portName: 'design' })
    expect(cond).toEqual({ kind: 'port-empty', nodeId: 'agent', portName: 'design' })
  })

  test('parses port-not-empty with nodeId + portName (RFC-023 clarify use case)', () => {
    const cond = parseExitCondition({ kind: 'port-not-empty', nodeId: 'agent', portName: 'design' })
    expect(cond).toEqual({ kind: 'port-not-empty', nodeId: 'agent', portName: 'design' })
  })

  test('parses port-equals with value default of "" when missing', () => {
    const cond = parseExitCondition({ kind: 'port-equals', nodeId: 'a', portName: 'p' })
    expect(cond).toEqual({ kind: 'port-equals', nodeId: 'a', portName: 'p', value: '' })
  })

  test('parses port-count-lt with default separator "\\n" when missing', () => {
    const cond = parseExitCondition({ kind: 'port-count-lt', nodeId: 'a', portName: 'p', n: 3 })
    expect(cond).toEqual({
      kind: 'port-count-lt',
      nodeId: 'a',
      portName: 'p',
      n: 3,
      separator: '\n',
    })
  })

  test('returns null for malformed input (missing fields, unknown kind, non-object)', () => {
    expect(parseExitCondition(null)).toBeNull()
    expect(parseExitCondition('port-empty')).toBeNull()
    expect(parseExitCondition({ kind: 'port-empty' })).toBeNull() // missing nodeId
    expect(parseExitCondition({ kind: 'unknown', nodeId: 'a', portName: 'p' })).toBeNull()
  })
})

describe('evaluateExitCondition — port-empty', () => {
  const cond: ExitCondition = { kind: 'port-empty', nodeId: 'a', portName: 'p' }
  test('true for "" / whitespace-only', () => {
    expect(evaluateExitCondition(cond, '')).toBe(true)
    expect(evaluateExitCondition(cond, '   \n\t')).toBe(true)
  })
  test('false for any non-whitespace content', () => {
    expect(evaluateExitCondition(cond, 'x')).toBe(false)
    expect(evaluateExitCondition(cond, '\nfoo\n')).toBe(false)
  })
})

describe('evaluateExitCondition — port-not-empty (RFC-023 clarify exit)', () => {
  const cond: ExitCondition = { kind: 'port-not-empty', nodeId: 'a', portName: 'p' }
  test('true the moment the port produces any non-whitespace content', () => {
    expect(evaluateExitCondition(cond, 'design content')).toBe(true)
    expect(evaluateExitCondition(cond, '\nfoo\n')).toBe(true)
  })
  test('false while the port is still empty (loop should keep iterating)', () => {
    expect(evaluateExitCondition(cond, '')).toBe(false)
    expect(evaluateExitCondition(cond, '   \n\t')).toBe(false)
  })
  test('is the exact inverse of port-empty over the same input', () => {
    const inv: ExitCondition = { kind: 'port-empty', nodeId: 'a', portName: 'p' }
    for (const sample of ['', ' ', '\n', 'x', 'multi\nline\n']) {
      expect(evaluateExitCondition(cond, sample)).toBe(!evaluateExitCondition(inv, sample))
    }
  })
})

describe('evaluateExitCondition — port-equals', () => {
  const cond: ExitCondition = { kind: 'port-equals', nodeId: 'a', portName: 'p', value: 'done' }
  test('true only on exact match (no trim)', () => {
    expect(evaluateExitCondition(cond, 'done')).toBe(true)
    expect(evaluateExitCondition(cond, 'done\n')).toBe(false)
    expect(evaluateExitCondition(cond, 'Done')).toBe(false)
  })
})

describe('evaluateExitCondition — port-count-lt', () => {
  const cond: ExitCondition = {
    kind: 'port-count-lt',
    nodeId: 'a',
    portName: 'p',
    n: 2,
    separator: '\n',
  }
  test('counts non-empty tokens and compares < n', () => {
    expect(evaluateExitCondition(cond, '')).toBe(true) // 0 < 2
    expect(evaluateExitCondition(cond, 'one')).toBe(true) // 1 < 2
    expect(evaluateExitCondition(cond, 'one\ntwo')).toBe(false) // 2 < 2 → false
    expect(evaluateExitCondition(cond, 'one\ntwo\nthree')).toBe(false)
  })
})
