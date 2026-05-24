// RFC-061 PR-B T9-extra — runner-v2 stdout aggregator tests (pure).
//
// Verifies the contract that downstream subprocess loop relies on:
// given a stream of opencode JSON events, produce the right
// AggregatedStdout for the post-exit branching logic.

import { describe, expect, test } from 'bun:test'

import { aggregateStdout } from '../src/scheduler-v2/runnerV2StdoutAggregator'

describe('aggregateStdout — empty / minimal', () => {
  test('empty events array → empty assistantText, envelopeKind=none', () => {
    const r = aggregateStdout({ events: [], declaredOutputs: [] })
    expect(r.assistantText).toBe('')
    expect(r.envelopeKind).toBe('none')
    expect(r.parsedOutputs).toEqual({})
    expect(r.sessionId).toBeUndefined()
  })

  test('skips null / non-object events without throwing', () => {
    const r = aggregateStdout({
      events: [null as unknown as Record<string, unknown>, {}],
      declaredOutputs: [],
    })
    expect(r.assistantText).toBe('')
  })
})

describe('aggregateStdout — sessionId tracking', () => {
  test('captures first sessionID seen', () => {
    const r = aggregateStdout({
      events: [{ sessionID: 'sess_abc' }, { sessionID: 'sess_should_not_override' }],
      declaredOutputs: [],
    })
    expect(r.sessionId).toBe('sess_abc')
  })
})

describe('aggregateStdout — assistantText accumulation', () => {
  test('text events concatenate in order', () => {
    const r = aggregateStdout({
      events: [
        { type: 'text', part: { type: 'text', text: 'Hello ' } },
        { type: 'text', part: { type: 'text', text: 'world' } },
      ],
      declaredOutputs: [],
    })
    expect(r.assistantText).toBe('Hello world')
  })

  test('subagent text (subSessionID present) does NOT count toward main assistantText', () => {
    const r = aggregateStdout({
      events: [
        { type: 'text', part: { type: 'text', text: 'main ' } },
        {
          type: 'text',
          subSessionID: 'sub_x',
          part: { type: 'text', text: 'sub text' },
        },
        { type: 'text', part: { type: 'text', text: 'continued' } },
      ],
      declaredOutputs: [],
    })
    expect(r.assistantText).toBe('main continued')
    expect(r.subagentOutputs).toHaveLength(1)
    expect(r.subagentOutputs[0]!.sessionId).toBe('sub_x')
    expect(r.subagentOutputs[0]!.content).toBe('sub text')
  })
})

describe('aggregateStdout — envelope parsing', () => {
  test('clean <workflow-output> envelope → parsedOutputs populated', () => {
    const text = `Some preamble.
<workflow-output>
  <port name="result">hello</port>
  <port name="summary">all good</port>
</workflow-output>`
    const r = aggregateStdout({
      events: [{ type: 'text', part: { type: 'text', text } }],
      declaredOutputs: ['result', 'summary'],
    })
    expect(r.envelopeKind).toBe('output')
    expect(r.parsedOutputs).toEqual({ result: 'hello', summary: 'all good' })
    expect(r.outputParseError).toBeNull()
  })

  test('missing declared port → outputParseError surfaces the missing name', () => {
    const text = `<workflow-output>
  <port name="result">x</port>
</workflow-output>`
    const r = aggregateStdout({
      events: [{ type: 'text', part: { type: 'text', text } }],
      declaredOutputs: ['result', 'missing_one'],
    })
    expect(r.envelopeKind).toBe('output')
    expect(r.outputParseError).toContain('missing_one')
  })

  test('<workflow-clarify> envelope → envelopeKind=clarify, clarifyBody set', () => {
    const text = `<workflow-clarify>which file should I edit?</workflow-clarify>`
    const r = aggregateStdout({
      events: [{ type: 'text', part: { type: 'text', text } }],
      declaredOutputs: ['result'],
    })
    expect(r.envelopeKind).toBe('clarify')
    expect(r.clarifyBody).toContain('which file')
  })

  test('both envelopes present → envelopeKind=both', () => {
    const text = `<workflow-clarify>q1</workflow-clarify><workflow-output></workflow-output>`
    const r = aggregateStdout({
      events: [{ type: 'text', part: { type: 'text', text } }],
      declaredOutputs: [],
    })
    expect(r.envelopeKind).toBe('both')
  })

  test('no envelope at all → envelopeKind=none', () => {
    const r = aggregateStdout({
      events: [{ type: 'text', part: { type: 'text', text: 'just chitchat' } }],
      declaredOutputs: ['result'],
    })
    expect(r.envelopeKind).toBe('none')
  })
})

describe('aggregateStdout — subagent tool-use telemetry', () => {
  test('tool_use events bucket to subagentToolUses', () => {
    const r = aggregateStdout({
      events: [
        {
          type: 'tool_use',
          sessionID: 'sess_main',
          subSessionID: 'sess_sub',
          part: { name: 'bash' },
        },
      ],
      declaredOutputs: [],
    })
    expect(r.subagentToolUses).toHaveLength(1)
    expect(r.subagentToolUses[0]!.toolName).toBe('bash')
    expect(r.subagentToolUses[0]!.sessionId).toBe('sess_sub')
  })

  test('tool_use without subSessionID falls back to main session id', () => {
    const r = aggregateStdout({
      events: [
        { sessionID: 'sess_main' },
        { type: 'tool_use', sessionID: 'sess_main', part: { name: 'read' } },
      ],
      declaredOutputs: [],
    })
    expect(r.subagentToolUses[0]!.sessionId).toBe('sess_main')
  })
})

describe('aggregateStdout — token usage', () => {
  test('opencode usage event accumulates tokens', () => {
    const r = aggregateStdout({
      events: [
        {
          type: 'step_finish',
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 20,
          },
        },
      ],
      declaredOutputs: [],
    })
    // accumulateTokens helper from services/runner is the source of truth;
    // we just verify the call path works end-to-end.
    expect(r.tokenUsage.input).toBeGreaterThan(0)
  })
})
