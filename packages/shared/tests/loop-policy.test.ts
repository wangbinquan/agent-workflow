// RFC-236 — the loop max-iteration policy is opt-in and strictly typed.
// Missing must remain false forever so old workflows cannot silently change
// from exhausted/failure to best-effort continuation after an upgrade.

import { describe, expect, test } from 'bun:test'
import { readContinueOnMaxIterations } from '../src/loopPolicy'

describe('readContinueOnMaxIterations', () => {
  test.each([
    ['missing defaults to false', {}, false],
    ['explicit false stays false', { continueOnMaxIterations: false }, false],
    ['explicit true enables continuation', { continueOnMaxIterations: true }, true],
  ] as const)('%s', (_name, node, expected) => {
    expect(readContinueOnMaxIterations(node)).toBe(expected)
  })

  test.each([
    ['null', null],
    ['string true', 'true'],
    ['number one', 1],
    ['array', []],
    ['object', {}],
  ] as const)('%s is invalid instead of being coerced', (_name, value) => {
    expect(readContinueOnMaxIterations({ continueOnMaxIterations: value })).toBeNull()
  })
})
