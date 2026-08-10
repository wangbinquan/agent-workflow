// RFC-111 PR-B — claude stream-json → NormalizedEvent parsing. Shapes verified
// hands-on (design §6.1): session_id (snake_case), assistant message.content[]
// mixing text/thinking/tool_use, result.usage cumulative tokens, is_error.

import { describe, expect, it } from 'bun:test'
import {
  observeSystemEvent,
  parseEvent,
  parseResultError,
} from '@/services/runtime/claudeCode/events'

describe('claude parseEvent (RFC-111 PR-B)', () => {
  it('system/init → step_start + session id', () => {
    const ev = parseEvent(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'opus' }),
    )
    expect(ev?.kind).toBe('step_start')
    expect(ev?.sessionId).toBe('s1')
    expect(ev?.tokens).toBeUndefined()
  })

  it('assistant turn concatenates text parts → text, kind=text', () => {
    const ev = parseEvent(
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: {
          content: [
            { type: 'text', text: 'hello ' },
            { type: 'text', text: 'world' },
          ],
        },
      }),
    )
    expect(ev?.kind).toBe('text')
    expect(ev?.text).toBe('hello world')
  })

  it('assistant turn with a tool_use part reads as kind=tool_use', () => {
    const ev = parseEvent(
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'tool_use', name: 'Bash' }] },
      }),
    )
    expect(ev?.kind).toBe('tool_use')
    expect(ev?.text).toBeNull()
  })

  it('thinking-only turn reads as reasoning', () => {
    const ev = parseEvent(
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'thinking', thinking: '...' }] },
      }),
    )
    expect(ev?.kind).toBe('reasoning')
  })

  it('result token delta maps claude snake_case → normalized; no double-count on assistant', () => {
    const assistant = parseEvent(
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: { content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 99 } },
      }),
    )
    // per-turn assistant usage is NOT accumulated (result is the cumulative source)
    expect(assistant?.tokens).toBeUndefined()

    const result = parseEvent(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's1',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      }),
    )
    expect(result?.kind).toBe('step_finish')
    expect(result?.tokens).toEqual({ input: 10, output: 5, cacheRead: 3, cacheCreate: 2 })
  })

  it('non-JSON / falsy → null (pump raw-text fallback)', () => {
    expect(parseEvent('not json')).toBeNull()
    expect(parseEvent('null')).toBeNull()
    expect(parseEvent('0')).toBeNull()
  })

  // Transcript JSONL lines (subagent capture) carry an ISO `timestamp`; surfacing
  // it keeps captured rows on the real event timeline instead of the (much later)
  // capture-walk wall clock — the SessionTab bucket sort is (ts, id).
  it('ISO timestamp is surfaced in ms; absent/garbage → undefined', () => {
    const withTs = parseEvent(
      JSON.stringify({
        type: 'user',
        session_id: 's1',
        timestamp: '2026-07-07T04:50:52.174Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      }),
    )
    expect(withTs?.timestamp).toBe(Date.parse('2026-07-07T04:50:52.174Z'))

    const numeric = parseEvent(
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        timestamp: 1751864000000,
        message: { content: [] },
      }),
    )
    expect(numeric?.timestamp).toBe(1751864000000)

    const without = parseEvent(
      JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [] } }),
    )
    expect(without?.timestamp).toBeUndefined()

    const garbage = parseEvent(
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        timestamp: 'not-a-date',
        message: { content: [] },
      }),
    )
    expect(garbage?.timestamp).toBeUndefined()
  })
})

describe('claude parseResultError (RFC-111 PR-B)', () => {
  it('flags is_error=true and surfaces the message', () => {
    const r = parseResultError(
      JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Not logged in · Please run /login',
      }),
    )
    expect(r?.isError).toBe(true)
    expect(r?.message).toContain('Not logged in')
  })

  it('returns null for non-result lines', () => {
    expect(parseResultError('{"type":"assistant"}')).toBeNull()
    expect(parseResultError('garbage')).toBeNull()
  })
})

describe('RFC-273 claude system event observation', () => {
  it('maps result is_error without retaining result text', () => {
    expect(
      observeSystemEvent(
        JSON.stringify({ type: 'result', is_error: true, result: 'secret diagnostic' }),
      ),
    ).toEqual({ runtimeEventType: 'result', terminalResult: 'error' })
    expect(observeSystemEvent(JSON.stringify({ type: 'result', is_error: false }))).toEqual({
      runtimeEventType: 'result',
      terminalResult: 'success',
    })
    expect(observeSystemEvent(JSON.stringify({ type: '<unsafe>' }))).toEqual({
      runtimeEventType: null,
      terminalResult: null,
    })
  })
})
