// RFC-111 PR-A — locks that `parseEvent` (the new normalized stdout-event
// entry the generic pump consumes) is byte-faithful to the pre-RFC-111 inline
// pump logic in runner.ts: same kind, same text extraction, same session-id
// capture, same token delta (cross-checked against accumulateTokens), and the
// SAME null-vs-event branch selection (`if (evt) {...} else {...}`). If this
// drifts, the opencode runtime's behavior changed under the abstraction.

import { describe, expect, it } from 'bun:test'
import {
  accumulateTokens,
  observeSystemEvent,
  parseEvent,
} from '@/services/runtime/opencode/events'
import type { RuntimeTokenUsage } from '@/services/runtime/types'

describe('parseEvent — kind / text / session / timestamp (RFC-111 PR-A)', () => {
  it('extracts nested part.text and kind=text', () => {
    const line = JSON.stringify({ type: 'text', part: { type: 'text', text: 'hello' } })
    const ev = parseEvent(line)
    expect(ev).not.toBeNull()
    expect(ev?.kind).toBe('text')
    expect(ev?.text).toBe('hello')
    expect(ev?.rawLine).toBe(line)
    expect(ev?.sessionId).toBeUndefined()
    expect(ev?.tokens).toBeUndefined()
  })

  it('captures sessionID (opencode snake-case) and non-text kinds', () => {
    const ev = parseEvent(JSON.stringify({ type: 'step_start', sessionID: 'opc_1' }))
    expect(ev?.kind).toBe('step_start')
    expect(ev?.sessionId).toBe('opc_1')
    expect(ev?.text).toBeNull()
  })

  it('maps the full inferEventKind enum + permission.asked alias', () => {
    expect(parseEvent('{"type":"tool_use"}')?.kind).toBe('tool_use')
    expect(parseEvent('{"type":"reasoning"}')?.kind).toBe('reasoning')
    expect(parseEvent('{"type":"error"}')?.kind).toBe('error')
    expect(parseEvent('{"type":"step_finish"}')?.kind).toBe('step_finish')
    expect(parseEvent('{"type":"permission.asked"}')?.kind).toBe('permission_asked')
    expect(parseEvent('{"type":"permission_asked"}')?.kind).toBe('permission_asked')
    expect(parseEvent('{"type":"whatever-unknown"}')?.kind).toBe('text') // default
  })

  it('passes through a numeric timestamp', () => {
    const ev = parseEvent(
      JSON.stringify({ type: 'text', timestamp: 123, part: { type: 'text', text: 'x' } }),
    )
    expect(ev?.timestamp).toBe(123)
  })
})

describe('parseEvent — null-vs-event branch fidelity (RFC-111 PR-A)', () => {
  it('returns null for non-JSON (pump raw-text fallback)', () => {
    expect(parseEvent('not json at all')).toBeNull()
  })

  it('returns null for falsy JSON values (matches the old `if (evt)` guard)', () => {
    expect(parseEvent('null')).toBeNull()
    expect(parseEvent('0')).toBeNull()
    expect(parseEvent('false')).toBeNull()
    expect(parseEvent('""')).toBeNull()
  })

  it('treats a truthy non-object as an event with kind=text, no text (legacy)', () => {
    const ev = parseEvent('123')
    expect(ev).not.toBeNull()
    expect(ev?.kind).toBe('text')
    expect(ev?.text).toBeNull()
    expect(ev?.tokens).toBeUndefined()
    expect(ev?.rawLine).toBe('123')
  })
})

describe('RFC-273 system event observation', () => {
  it('records only a safe type and maps step_finish to success', () => {
    expect(observeSystemEvent('{"type":"step_finish"}')).toEqual({
      runtimeEventType: 'step_finish',
      terminalResult: 'success',
    })
    expect(observeSystemEvent(JSON.stringify({ type: 'x\nsecret' }))).toEqual({
      runtimeEventType: null,
      terminalResult: null,
    })
    expect(observeSystemEvent(JSON.stringify({ type: 'x'.repeat(65) }))).toEqual({
      runtimeEventType: null,
      terminalResult: null,
    })
    expect(observeSystemEvent('not-json')).toEqual({
      runtimeEventType: null,
      terminalResult: null,
    })
  })
})

describe('parseEvent token delta == accumulateTokens (RFC-111 PR-A + RFC-103)', () => {
  // For each representative token-bearing event, the delta parseEvent returns
  // must equal what accumulateTokens would add to a zeroed accumulator.
  const cases: Array<{ name: string; evt: Record<string, unknown> }> = [
    { name: 'flat snake_case', evt: { type: 'step_finish', tokens: { input: 10, output: 5 } } },
    {
      name: 'nested cache object (RFC-103)',
      evt: { type: 'step_finish', tokens: { input: 10, output: 5, cache: { read: 3, write: 2 } } },
    },
    {
      name: 'message.usage shape',
      evt: { type: 'step_finish', message: { usage: { input_tokens: 7, output_tokens: 1 } } },
    },
    { name: 'no tokens', evt: { type: 'text', part: { type: 'text', text: 'x' } } },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const acc: RuntimeTokenUsage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 }
      accumulateTokens(c.evt, acc)
      const ev = parseEvent(JSON.stringify(c.evt))
      const delta = ev?.tokens ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
      expect(delta.input).toBe(acc.input)
      expect(delta.output).toBe(acc.output)
      expect(delta.cacheCreate).toBe(acc.cacheCreate)
      expect(delta.cacheRead).toBe(acc.cacheRead)
    })
  }
})
