// RFC-027: locks parseSessionTree behavior across happy paths, multi-tool
// folding, multi-level subagent recursion, capture-failed fallbacks, and
// out-of-order event ingestion. Renaming or restructuring this parser
// must keep this suite green so the Session view stays faithful to the
// raw event stream.

import { describe, expect, test } from 'bun:test'
import { parseSessionTree, type ParseSessionInputEvent } from '../src/sessionView'

let nextId = 0
function evt(
  partial: Partial<ParseSessionInputEvent> & { payload: object | string },
): ParseSessionInputEvent {
  nextId += 1
  const payload =
    typeof partial.payload === 'string' ? partial.payload : JSON.stringify(partial.payload)
  return {
    id: partial.id ?? nextId,
    ts: partial.ts ?? nextId * 10,
    kind: partial.kind ?? 'text',
    // Default to 'root' so tests that pass rootSessionId: 'root' work without
    // having to repeat the sessionId on every event.
    sessionId: partial.sessionId === undefined ? 'root' : partial.sessionId,
    parentSessionId: partial.parentSessionId ?? null,
    payload,
  }
}

describe('parseSessionTree — root composition', () => {
  test('promptText becomes the leading user message even with no events', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: 'hello world',
      startedAt: 100,
      primaryAgentName: 'coder',
      events: [],
    })
    expect(tree.sessionId).toBe('root')
    expect(tree.captureComplete).toBe(true)
    expect(tree.messages).toHaveLength(1)
    expect(tree.messages[0]).toMatchObject({ kind: 'user', text: 'hello world', ts: 100 })
  })

  test('single assistant text event becomes one block under root', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          kind: 'text',
          payload: {
            type: 'text',
            sessionID: 'root',
            messageID: 'm1',
            part: { type: 'text', text: 'Hi there.', time: { end: 1 } },
          },
        }),
      ],
    })
    expect(tree.messages).toHaveLength(1)
    expect(tree.messages[0]).toMatchObject({
      kind: 'assistant-text',
      text: 'Hi there.',
      messageId: 'm1',
    })
  })

  test('rootSessionId=null derives root key from first non-null sessionId in events', () => {
    const tree = parseSessionTree({
      rootSessionId: null,
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          sessionId: 'derived-root',
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'ok' } },
        }),
      ],
    })
    expect(tree.sessionId).toBe('derived-root')
  })
})

describe('parseSessionTree — tool calls', () => {
  test('regular tool call renders as tool-call with status + output from final state', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          kind: 'tool_use',
          payload: {
            type: 'tool_use',
            sessionID: 'root',
            part: {
              type: 'tool',
              callID: 'c1',
              tool: 'read_file',
              state: { status: 'completed', input: { path: 'x.ts' }, output: 'file contents' },
            },
          },
        }),
      ],
    })
    expect(tree.messages).toHaveLength(1)
    expect(tree.messages[0]).toMatchObject({
      kind: 'tool-call',
      toolName: 'read_file',
      status: 'completed',
      output: 'file contents',
    })
  })

  test('same callID across pending → completed folds into one block (last write wins)', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          kind: 'tool_use',
          payload: {
            type: 'tool_use',
            sessionID: 'root',
            part: { type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'pending' } },
          },
        }),
        evt({
          kind: 'tool_use',
          payload: {
            type: 'tool_use',
            sessionID: 'root',
            part: {
              type: 'tool',
              callID: 'c1',
              tool: 'bash',
              state: { status: 'completed', output: 'done' },
            },
          },
        }),
      ],
    })
    expect(tree.messages).toHaveLength(1)
    expect(tree.messages[0]).toMatchObject({
      kind: 'tool-call',
      status: 'completed',
      output: 'done',
    })
  })

  test('multiple tool calls and assistant text appear in event-time order', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          ts: 10,
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'A' }, messageID: 'm-a' },
        }),
        evt({
          ts: 20,
          kind: 'tool_use',
          payload: {
            type: 'tool_use',
            part: { type: 'tool', callID: 't1', tool: 'read_file', state: { status: 'completed' } },
          },
        }),
        evt({
          ts: 30,
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'B' }, messageID: 'm-b' },
        }),
      ],
    })
    const kinds = tree.messages.map((m) => m.kind)
    expect(kinds).toEqual(['assistant-text', 'tool-call', 'assistant-text'])
  })
})

describe('parseSessionTree — subagent nesting', () => {
  test('task tool with metadata.sessionID becomes a subagent-call wired to a child tree', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          sessionId: 'root',
          kind: 'tool_use',
          payload: {
            type: 'tool_use',
            sessionID: 'root',
            part: {
              type: 'tool',
              callID: 'task1',
              tool: 'task',
              metadata: { sessionID: 'child-1' },
              state: {
                status: 'completed',
                input: { subagent_type: 'auditor', prompt: 'review X' },
                output: 'audit done',
              },
            },
          },
        }),
        evt({
          sessionId: 'child-1',
          parentSessionId: 'root',
          kind: 'text',
          payload: {
            type: 'text',
            sessionID: 'child-1',
            messageID: 'c1-m1',
            part: { type: 'text', text: 'child says hi' },
          },
        }),
      ],
    })
    expect(tree.messages).toHaveLength(1)
    const sub = tree.messages[0]
    expect(sub.kind).toBe('subagent-call')
    if (sub.kind !== 'subagent-call') return
    expect(sub.childSessionId).toBe('child-1')
    expect(sub.childAgentName).toBe('auditor')
    expect(sub.childOutputFallback).toBe('audit done')
    expect(sub.child).not.toBeNull()
    expect(sub.child!.messages.map((m) => m.kind)).toEqual(['assistant-text'])
  })

  test('three-level nested subagent reconstructs full chain', () => {
    const evts: ParseSessionInputEvent[] = []
    // root → child-A → grand-B → great-C, each level emits a task tool + a text.
    const levels: Array<{
      self: string
      parent: string | null
      child: string | null
      agent: string
    }> = [
      { self: 'root', parent: null, child: 'child-A', agent: 'rootAgent' },
      { self: 'child-A', parent: 'root', child: 'grand-B', agent: 'midAgent' },
      { self: 'grand-B', parent: 'child-A', child: 'great-C', agent: 'leafAgent' },
      { self: 'great-C', parent: 'grand-B', child: null, agent: 'tinyAgent' },
    ]
    for (const lvl of levels) {
      if (lvl.child !== null) {
        evts.push(
          evt({
            sessionId: lvl.self,
            parentSessionId: lvl.parent,
            kind: 'tool_use',
            payload: {
              type: 'tool_use',
              sessionID: lvl.self,
              part: {
                type: 'tool',
                callID: `t-${lvl.self}`,
                tool: 'task',
                metadata: { sessionID: lvl.child },
                state: { status: 'completed', input: { subagent_type: lvl.agent } },
              },
            },
          }),
        )
      }
      evts.push(
        evt({
          sessionId: lvl.self,
          parentSessionId: lvl.parent,
          kind: 'text',
          payload: {
            type: 'text',
            sessionID: lvl.self,
            messageID: `m-${lvl.self}`,
            part: { type: 'text', text: `hi from ${lvl.self}` },
          },
        }),
      )
    }
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'rootAgent',
      events: evts,
    })

    // Walk down the chain.
    const a = tree.messages.find((m) => m.kind === 'subagent-call')
    expect(a?.kind).toBe('subagent-call')
    if (a?.kind !== 'subagent-call' || a.child === null) throw new Error('missing child A')
    const b = a.child.messages.find((m) => m.kind === 'subagent-call')
    if (b?.kind !== 'subagent-call' || b.child === null) throw new Error('missing child B')
    const c = b.child.messages.find((m) => m.kind === 'subagent-call')
    if (c?.kind !== 'subagent-call' || c.child === null) throw new Error('missing child C')
    expect(
      c.child.messages.some((m) => m.kind === 'assistant-text' && m.text === 'hi from great-C'),
    ).toBe(true)
  })

  test('subagent with metadata.sessionID but no bucket events still attaches an empty child with captureComplete=false', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          sessionId: 'root',
          kind: 'tool_use',
          payload: {
            type: 'tool_use',
            sessionID: 'root',
            part: {
              type: 'tool',
              callID: 'task1',
              tool: 'task',
              metadata: { sessionID: 'lost-child' },
              state: { status: 'completed', output: 'parent saw this' },
            },
          },
        }),
      ],
    })
    const sub = tree.messages[0]
    if (sub.kind !== 'subagent-call') throw new Error('expected subagent-call')
    expect(sub.child).not.toBeNull()
    expect(sub.child!.captureComplete).toBe(false)
    expect(sub.child!.messages).toHaveLength(0)
    expect(sub.childOutputFallback).toBe('parent saw this')
  })

  test('subagent_capture_failed marker flips child captureComplete to false', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          sessionId: 'root',
          kind: 'tool_use',
          payload: {
            type: 'tool_use',
            part: {
              type: 'tool',
              callID: 'task1',
              tool: 'task',
              metadata: { sessionID: 'child-x' },
              state: { status: 'completed', output: 'fallback text' },
            },
          },
        }),
        evt({
          sessionId: 'child-x',
          parentSessionId: 'root',
          kind: 'subagent_capture_failed',
          payload: { sessionID: 'child-x', reason: 'opencode-db-not-found' },
        }),
      ],
    })
    const sub = tree.messages[0]
    if (sub.kind !== 'subagent-call' || sub.child === null) throw new Error('child missing')
    expect(sub.child.captureComplete).toBe(false)
  })
})

describe('parseSessionTree — ordering + edge cases', () => {
  test('events delivered out of (ts, id) order are re-sorted in place', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          id: 200,
          ts: 100,
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'B' }, messageID: 'b' },
        }),
        evt({
          id: 100,
          ts: 50,
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'A' }, messageID: 'a' },
        }),
      ],
    })
    expect(tree.messages.map((m) => (m.kind === 'assistant-text' ? m.text : null))).toEqual([
      'A',
      'B',
    ])
  })

  test('events with identical ts use id as tiebreaker', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          id: 200,
          ts: 50,
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'late' }, messageID: 'b' },
        }),
        evt({
          id: 100,
          ts: 50,
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'early' }, messageID: 'a' },
        }),
      ],
    })
    expect(tree.messages.map((m) => (m.kind === 'assistant-text' ? m.text : null))).toEqual([
      'early',
      'late',
    ])
  })

  test('malformed JSON payloads are silently skipped, do not throw', () => {
    expect(() =>
      parseSessionTree({
        rootSessionId: 'root',
        promptText: null,
        startedAt: null,
        primaryAgentName: 'coder',
        events: [evt({ kind: 'text', payload: 'this is not JSON' })],
      }),
    ).not.toThrow()
  })

  test('events with null messageID still render as distinct blocks per event', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({ kind: 'text', payload: { type: 'text', part: { type: 'text', text: 'first' } } }),
        evt({ kind: 'text', payload: { type: 'text', part: { type: 'text', text: 'second' } } }),
      ],
    })
    const texts = tree.messages.filter((m) => m.kind === 'assistant-text')
    expect(texts).toHaveLength(2)
  })

  test('empty events with no promptText yields an empty messages array, captureComplete=false', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [],
    })
    expect(tree.messages).toEqual([])
    expect(tree.captureComplete).toBe(false)
  })
})

// RFC-027 §UX merge — RFC-026 inline clarify rerun shares a single
// opencode session across multiple node_runs. The Session view must
// stitch every round's user prompt + assistant text into one
// conversation flow, interleaved by ts.
describe('parseSessionTree — extraUserPrompts (inline-session merge)', () => {
  test('extra prompts get interleaved with assistant events by ts', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: 'initial ask',
      startedAt: 100,
      primaryAgentName: 'coder',
      extraUserPrompts: [
        { text: 'follow-up answer A', ts: 220 },
        { text: 'follow-up answer B', ts: 420 },
      ],
      events: [
        evt({
          ts: 150,
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'first reply' }, messageID: 'm1' },
        }),
        evt({
          ts: 300,
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'second reply' }, messageID: 'm2' },
        }),
        evt({
          ts: 500,
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'third reply' }, messageID: 'm3' },
        }),
      ],
    })
    const sequence = tree.messages.map((m) =>
      m.kind === 'user' ? `U:${m.text}` : m.kind === 'assistant-text' ? `A:${m.text}` : m.kind,
    )
    expect(sequence).toEqual([
      'U:initial ask',
      'A:first reply',
      'U:follow-up answer A',
      'A:second reply',
      'U:follow-up answer B',
      'A:third reply',
    ])
    expect(tree.captureComplete).toBe(true)
  })

  test('extras without an initial promptText still all render as user messages', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      extraUserPrompts: [
        { text: 'round 2 answer', ts: 200 },
        { text: 'round 3 answer', ts: 400 },
      ],
      events: [
        evt({
          ts: 300,
          kind: 'text',
          payload: { type: 'text', part: { type: 'text', text: 'between' }, messageID: 'm1' },
        }),
      ],
    })
    expect(tree.messages.map((m) => m.kind)).toEqual(['user', 'assistant-text', 'user'])
    expect(tree.captureComplete).toBe(true)
  })

  test('absent / empty extraUserPrompts preserves legacy unshift-to-index-0 behavior', () => {
    // The initial prompt with ts=200 would normally interleave AFTER
    // events with ts=100 / 150 if we were sorting. Legacy callers
    // (one-attempt SessionTab) need the prompt at index 0 unchanged.
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: 'legacy ask',
      startedAt: 200,
      primaryAgentName: 'coder',
      events: [
        evt({
          ts: 100,
          kind: 'text',
          payload: {
            type: 'text',
            part: { type: 'text', text: 'before prompt ts' },
            messageID: 'm1',
          },
        }),
      ],
    })
    expect(tree.messages[0]!.kind).toBe('user')
  })
})

// Locks in the parser branch that surfaces opencode `reasoning` parts
// (model thinking blocks) as their own SessionMessage kind. opencode
// emits these whenever the runner passes `--thinking` (see
// runner.ts buildCommand). Pre-fix the parser silently dropped them,
// so the Session tab only ever showed the final reply — see the
// "thinking 内容也打印出来" feature request.
describe('parseSessionTree — reasoning blocks', () => {
  test('single reasoning event surfaces as assistant-reasoning', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          kind: 'reasoning',
          payload: {
            type: 'reasoning',
            sessionID: 'root',
            messageID: 'm1',
            part: { type: 'reasoning', text: 'Let me think step by step…' },
          },
        }),
      ],
    })
    expect(tree.messages).toHaveLength(1)
    expect(tree.messages[0]).toMatchObject({
      kind: 'assistant-reasoning',
      text: 'Let me think step by step…',
      messageId: 'm1',
    })
  })

  test('repeated reasoning events with same messageID fold last-write-wins', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          kind: 'reasoning',
          payload: {
            type: 'reasoning',
            messageID: 'm1',
            part: { type: 'reasoning', text: 'partial' },
          },
        }),
        evt({
          kind: 'reasoning',
          payload: {
            type: 'reasoning',
            messageID: 'm1',
            part: { type: 'reasoning', text: 'partial then full final.' },
          },
        }),
      ],
    })
    const reasonings = tree.messages.filter((m) => m.kind === 'assistant-reasoning')
    expect(reasonings).toHaveLength(1)
    expect(reasonings[0]).toMatchObject({
      kind: 'assistant-reasoning',
      text: 'partial then full final.',
    })
  })

  test('reasoning interleaves with assistant-text and tool calls in event order', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          kind: 'reasoning',
          payload: {
            type: 'reasoning',
            messageID: 'm1',
            part: { type: 'reasoning', text: 'thinking...' },
          },
        }),
        evt({
          kind: 'text',
          payload: {
            type: 'text',
            messageID: 'm1',
            part: { type: 'text', text: 'Here is the answer.' },
          },
        }),
      ],
    })
    expect(tree.messages.map((m) => m.kind)).toEqual(['assistant-reasoning', 'assistant-text'])
  })

  test('empty reasoning text deltas are skipped (no hollow blocks)', () => {
    const tree = parseSessionTree({
      rootSessionId: 'root',
      promptText: null,
      startedAt: null,
      primaryAgentName: 'coder',
      events: [
        evt({
          kind: 'reasoning',
          payload: {
            type: 'reasoning',
            messageID: 'm1',
            part: { type: 'reasoning', text: '' },
          },
        }),
      ],
    })
    expect(tree.messages).toEqual([])
  })
})
