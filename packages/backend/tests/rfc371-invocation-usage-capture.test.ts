// RFC-371: source attribution must survive replay without inventing native model/provider evidence.
import { expect, test } from 'bun:test'
import { createInvocationUsageCapture } from '../src/services/runtime/usage'
import { normalizeUsage as opencode } from '../src/services/runtime/opencode/usage'
import { normalizeUsage as claude } from '../src/services/runtime/claudeCode/usage'

const identity = {
  invocationId: 'call',
  taskId: 'task',
  nodeRunId: 'run',
  agentId: 'agent',
  resumeSessionId: undefined,
}
test('numeric evidence freezes revision, clock and identity while keeping the actual model unknown', () => {
  const capture = createInvocationUsageCapture({ ...identity, normalize: opencode })
  const line = JSON.stringify({
    type: 'step_finish',
    part: {
      id: 'step',
      tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  })
  const first = capture(line, 'native', 100)!,
    second = capture(line, 'native', 101)!
  expect(first.measurements[0]).toMatchObject({
    invocationId: 'call',
    revision: 1,
    observedAt: 100,
    model: null,
    usage: { input: '20', output: '5', cacheRead: '0', cacheWrite: '0' },
  })
  expect(second.measurements[0]).toMatchObject({
    recordId: first.measurements[0]!.recordId,
    revision: 2,
  })
})
test('resumed cumulative model totals retain an unknown baseline and the reported actual model', () => {
  const capture = createInvocationUsageCapture({
    ...identity,
    resumeSessionId: 'native',
    normalize: claude,
  })
  const row = capture(
    JSON.stringify({
      type: 'result',
      modelUsage: {
        actual: {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
        },
      },
    }),
    'native',
    100,
  )!.measurements[0]!
  expect(row.model).toEqual({ provider: null, id: 'actual' })
  expect(row.basis).toEqual({ kind: 'native-session', lineageKey: 'native', baseline: null })
})
test('missing identity and parser failures produce diagnostic evidence rather than measured zero', () => {
  const capture = createInvocationUsageCapture({ ...identity, normalize: opencode })
  expect(capture('{"type":"step_finish"}', null, 100)).toEqual({
    invocationId: 'call',
    measurements: [],
    diagnostics: ['native-session-unavailable'],
  })
  expect(capture('not json', 'native', 100)).toBeUndefined()
  expect(createInvocationUsageCapture(identity)('{}', 'native', 100)).toBeUndefined()
  const broken = createInvocationUsageCapture({
    ...identity,
    normalize: () => {
      throw new Error('failed')
    },
  })
  expect(broken('{}', 'native', 100)).toEqual({
    invocationId: 'call',
    measurements: [],
    diagnostics: ['usage-normalization-failed'],
  })
})
test('unmapped inline child usage is not attributed to its parent', () => {
  const capture = createInvocationUsageCapture({ ...identity, normalize: claude })
  const result = capture(
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'child-tool',
      message: { id: 'child', model: 'model', usage: { input_tokens: 200 } },
    }),
    'root',
    100,
  )!
  expect(result.measurements).toEqual([])
  expect(result.diagnostics).toContain('unmapped-child-session')
})

test('an empty resume ID preserves a fresh call cumulative baseline', () => {
  const capture = createInvocationUsageCapture({
    ...identity,
    resumeSessionId: '',
    normalize: claude,
  })
  const evidence = capture(
    JSON.stringify({
      type: 'result',
      modelUsage: {
        actual: {
          inputTokens: 100,
          outputTokens: 40,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
        },
      },
    }),
    'native',
    100,
  )!
  expect(evidence.measurements[0]!.basis).toEqual({ kind: 'invocation' })
})
