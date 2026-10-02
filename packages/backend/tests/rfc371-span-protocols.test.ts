import { expect, test } from 'bun:test'
import { parseObservationCapturedUsage } from '@agent-workflow/shared'
import { normalizeClaudeSpans } from '../src/services/runtime/claudeCode/spanFacts'
import { normalizeOpencodeSpans } from '../src/services/runtime/opencode/spanFacts'

test('Claude joins only actual tool identities and native ISO boundaries; result totals do not close tools', () => {
  const start = normalizeClaudeSpans(
    {
      type: 'assistant',
      session_id: 'root',
      parent_tool_use_id: null,
      timestamp: '2026-10-01T00:00:00.000Z',
      message: {
        id: 'message',
        model: 'actual',
        usage: { input_tokens: 2 },
        content: [{ type: 'tool_use', id: 'call', name: 'Read', input: { path: '/fixture' } }],
      },
    },
    'root',
  )
  expect(start.map((span) => span.kind)).toEqual(['tool', 'model'])
  expect(start[0]).toMatchObject({
    callId: 'call',
    label: 'Read',
    origin: 'creation',
    state: { startedAt: Date.parse('2026-10-01T00:00:00Z'), endedAt: null, status: 'open' },
  })
  expect(start[1]).toMatchObject({
    model: { id: 'actual', provider: null },
    state: { startedAt: null, endedAt: null, status: 'unknown' },
  })
  const end = normalizeClaudeSpans(
    {
      type: 'user',
      session_id: 'root',
      timestamp: '2026-10-01T00:00:02Z',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'call', is_error: true, content: 'fixture result' },
        ],
      },
    },
    'root',
  )
  expect(end).toMatchObject([
    {
      callId: 'call',
      origin: 'completion',
      state: { startedAt: null, endedAt: Date.parse('2026-10-01T00:00:02Z'), status: 'error' },
    },
  ])
  expect(
    normalizeClaudeSpans(
      { type: 'result', session_id: 'root', usage: { output_tokens: 4 } },
      'root',
    ),
  ).toEqual([])
  expect(
    normalizeClaudeSpans(
      {
        type: 'assistant',
        session_id: 'root',
        parent_tool_use_id: 'parent',
        message: { content: [{ type: 'tool_use', id: 'child', name: 'Read' }] },
      },
      'root',
    ),
  ).toEqual([])
})

test('missing Claude timestamps remain unknown while distinct native tool IDs remain distinct', () => {
  const facts = normalizeClaudeSpans(
    {
      type: 'assistant',
      session_id: 'root',
      message: {
        content: [
          { type: 'tool_use', id: 'first', name: 'Read' },
          { type: 'tool_use', id: 'second', name: 'Read' },
        ],
      },
    },
    'root',
  )
  expect(facts.map((span) => span.callId)).toEqual(['first', 'second'])
  expect(facts.every((span) => span.state.startedAt === null && span.state.endedAt === null)).toBe(
    true,
  )
})

test('OpenCode uses native callID/state.time and leaves unknown model starts for the independent native scan', () => {
  const facts = normalizeOpencodeSpans(
    {
      sessionID: 'root',
      timestamp: 999,
      part: {
        type: 'tool',
        sessionID: 'root',
        callID: 'call',
        tool: 'bash',
        state: { status: 'completed', time: { start: 100, end: 200 } },
      },
    },
    'root',
  )
  expect(facts[0]).toMatchObject({
    callId: 'call',
    state: { startedAt: 100, endedAt: 200, status: 'success' },
  })
  expect(
    normalizeOpencodeSpans(
      {
        sessionID: 'other',
        part: { type: 'tool', sessionID: 'other', callID: 'call', tool: 'bash' },
      },
      'root',
    ),
  ).toEqual([])
  expect(
    normalizeOpencodeSpans(
      { sessionID: 'root', part: { type: 'step-finish', sessionID: 'root', id: 'part' } },
      'root',
    )[0],
  ).toMatchObject({
    measurementRecordId: 'opencode:step:part',
    state: { startedAt: null, endedAt: null },
  })
})

test('legacy numeric JSON stays byte-identical; malformed span extensions do not discard numbers', () => {
  const legacy = { invocationId: 'old', measurements: [], diagnostics: [] }
  expect(JSON.stringify(parseObservationCapturedUsage(legacy))).toBe(JSON.stringify(legacy))
  expect(parseObservationCapturedUsage({ ...legacy, spanFacts: [{ invalid: true }] })).toEqual({
    ...legacy,
    diagnostics: ['span-metadata-invalid'],
  })
  expect(() =>
    parseObservationCapturedUsage({ ...legacy, measurements: [{ revision: 0 }], spanFacts: [] }),
  ).toThrow()
})
