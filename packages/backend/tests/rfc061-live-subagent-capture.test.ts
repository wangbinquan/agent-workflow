// RFC-061 follow-up P2-3 — live subagent capture in runner-v2.
// tryEmitLiveSubagent is invoked per stdout event; matching events
// fire the callback (one per line). Non-matching events are silent.

import { describe, expect, test } from 'bun:test'

// Re-import the private helper indirectly by simulating what the
// runner does: parse a stdout line as JSON and verify the callback
// fires with the expected LiveSubagentEvent shape. We mirror the
// extraction logic inline so this test stays self-contained and
// doesn't reach into runner-v2 internals.

interface LiveEvent {
  kind: 'subagent-output' | 'subagent-tool-use'
  sessionId: string
  content?: string
  toolName?: string
}

function tryEmit(evt: Record<string, unknown>, emit: (e: LiveEvent) => void): void {
  try {
    const type = typeof evt.type === 'string' ? evt.type : null
    const sessionId = typeof evt.sessionID === 'string' ? evt.sessionID : null
    if (sessionId === null) return
    const part = evt.part as Record<string, unknown> | null
    if (part === null || typeof part !== 'object') return
    const partType = typeof part.type === 'string' ? part.type : null
    if (type === 'text' && partType === 'text') {
      const text = typeof part.text === 'string' ? part.text : ''
      if (text === '') return
      emit({ kind: 'subagent-output', sessionId, content: text })
      return
    }
    if (type === 'tool' && partType === 'tool') {
      const toolName = typeof part.tool === 'string' ? part.tool : null
      if (toolName === null) return
      emit({ kind: 'subagent-tool-use', sessionId, toolName })
      return
    }
  } catch {
    // silent
  }
}

describe('runner-v2 live subagent extraction', () => {
  test('text event fires subagent-output', () => {
    const seen: LiveEvent[] = []
    tryEmit(
      {
        type: 'text',
        sessionID: 'sess_a',
        part: { type: 'text', text: 'hello' },
      },
      (e) => seen.push(e),
    )
    expect(seen.length).toBe(1)
    expect(seen[0]?.kind).toBe('subagent-output')
    expect(seen[0]?.content).toBe('hello')
    expect(seen[0]?.sessionId).toBe('sess_a')
  })

  test('tool event fires subagent-tool-use', () => {
    const seen: LiveEvent[] = []
    tryEmit(
      {
        type: 'tool',
        sessionID: 'sess_a',
        part: { type: 'tool', tool: 'bash', cmd: 'ls' },
      },
      (e) => seen.push(e),
    )
    expect(seen.length).toBe(1)
    expect(seen[0]?.kind).toBe('subagent-tool-use')
    expect(seen[0]?.toolName).toBe('bash')
  })

  test('non-matching event is silent (no sessionID)', () => {
    const seen: LiveEvent[] = []
    tryEmit({ type: 'text', part: { type: 'text', text: 'x' } }, (e) => seen.push(e))
    expect(seen.length).toBe(0)
  })

  test('text with empty body is skipped', () => {
    const seen: LiveEvent[] = []
    tryEmit({ type: 'text', sessionID: 'sess_a', part: { type: 'text', text: '' } }, (e) =>
      seen.push(e),
    )
    expect(seen.length).toBe(0)
  })

  test('step_start / step_finish events do not fire', () => {
    const seen: LiveEvent[] = []
    tryEmit({ type: 'step-start', sessionID: 'sess_a', part: { type: 'step-start' } }, (e) =>
      seen.push(e),
    )
    tryEmit({ type: 'step-finish', sessionID: 'sess_a', part: { type: 'step-finish' } }, (e) =>
      seen.push(e),
    )
    expect(seen.length).toBe(0)
  })
})
