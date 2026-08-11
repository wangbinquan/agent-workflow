// P-4-05: token accumulation from opencode JSON events.
//
// Unit-tests the pure event→token accumulator in runner.ts. End-to-end
// behavior is covered indirectly by scheduler.test.ts.

import { describe, expect, test } from 'bun:test'
import { accumulateTokens } from '../src/services/runtime/opencode/events'

interface Acc {
  input: number
  output: number
  cacheCreate: number
  cacheRead: number
  total: number
}

function emptyAcc(): Acc {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }
}

describe('accumulateTokens', () => {
  test('top-level tokens object (snake_case)', () => {
    const a = emptyAcc()
    accumulateTokens(
      {
        type: 'step-finish',
        tokens: { input: 100, output: 50, cache_creation: 10, cache_read: 5 },
      },
      a,
    )
    expect(a).toEqual({ input: 100, output: 50, cacheCreate: 10, cacheRead: 5, total: 165 })
  })

  test('nested under part', () => {
    const a = emptyAcc()
    accumulateTokens({ type: 'text', part: { type: 'text', tokens: { input: 20, output: 30 } } }, a)
    expect(a.total).toBe(50)
  })

  test('cumulative across multiple events', () => {
    const a = emptyAcc()
    accumulateTokens({ tokens: { input: 10, output: 5 } }, a)
    accumulateTokens({ tokens: { input: 7, output: 3 } }, a)
    expect(a.input).toBe(17)
    expect(a.output).toBe(8)
    expect(a.total).toBe(25)
  })

  test('Anthropic-style usage with snake_case (prompt_tokens / completion_tokens)', () => {
    const a = emptyAcc()
    accumulateTokens({ usage: { prompt_tokens: 42, completion_tokens: 13 } }, a)
    expect(a.input).toBe(42)
    expect(a.output).toBe(13)
  })

  test('top-level input_tokens / output_tokens (Bedrock-style)', () => {
    const a = emptyAcc()
    accumulateTokens({ input_tokens: 5, output_tokens: 7 }, a)
    expect(a.input).toBe(5)
    expect(a.output).toBe(7)
    expect(a.total).toBe(12)
  })

  test('events without tokens are ignored', () => {
    const a = emptyAcc()
    accumulateTokens({ type: 'tool_use', name: 'read' }, a)
    accumulateTokens({}, a)
    expect(a.total).toBe(0)
  })
})
