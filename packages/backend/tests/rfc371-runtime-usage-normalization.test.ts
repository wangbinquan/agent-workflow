// RFC-371: native step IDs and explicit overlap scopes prevent double charging.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ObservationMeasurement } from '@agent-workflow/shared'
import { normalizeRuntimeUsage, type RuntimeUsageContext } from '../src/services/runtime'
import {
  reconcileUsage,
  type UsageLedgerRecord,
} from '../src/modules/run-observability/domain/usageLedger'
import { selectUsageContributions } from '../src/modules/run-observability/domain/usageSelection'

const context: RuntimeUsageContext = {
  invocationId: 'call-1',
  taskId: 'task-1',
  nodeRunId: 'node-1',
  agentId: 'agent-1',
  revision: 1,
  observedAt: 100,
  rootSessionId: 'root',
  sessionId: 'root',
  parentSessionId: null,
  ancestors: [],
  turnId: 'turn-1',
  turnIndex: 0,
  sessionStartTurn: 0,
  provider: 'gateway-1',
  actualModel: null,
  cumulative: { kind: 'invocation', lineageKey: 'lineage-1', modelBaselines: null },
}
const usage = (input: number, output = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})
const modelUsage = (input: number, output = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: 123,
})
const assistant = (id: string, input: number) => ({
  type: 'assistant',
  message: { id, model: 'model-a', usage: usage(input, 999) },
})
const result = (input: number, output = 0) => ({
  type: 'result',
  uuid: 'result-1',
  subtype: 'success',
  usage: usage(input, output),
})
function parse(raw: unknown, patch: Partial<RuntimeUsageContext> = {}) {
  return normalizeRuntimeUsage('claude-code', raw, { ...context, ...patch })
}
function ledger(measurements: readonly ObservationMeasurement[]) {
  const records = new Map<string, UsageLedgerRecord>()
  for (const measurement of measurements) {
    const key = measurement.invocationId + '/' + measurement.recordId
    records.set(key, reconcileUsage('native-source', measurement, records.get(key)).record)
  }
  return [...records.values()]
}
test('recorded OpenCode 1.15.5 retains all four buckets and exact native identity', () => {
  const lines = readFileSync(
    new URL('./fixtures/opencode-recordings/1.15.5-text-only.ndjson', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n')
  const frames = lines.map((line) => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return { measurements: [] }
    }
    return normalizeRuntimeUsage('opencode', raw, context)
  })
  const measurements = frames.flatMap((frame) => frame.measurements)
  expect(measurements).toHaveLength(1)
  expect(measurements[0]).toMatchObject({
    recordId: 'opencode:step:prt_e49bef91b001rFpycEA303wUuT',
    model: null,
    usage: { input: '444', output: '3', cacheRead: '7040', cacheWrite: '0' },
    coverage: 'complete',
  })
  const rows = ledger([...measurements, { ...measurements[0]!, revision: 2 }])
  expect(selectUsageContributions(rows).summary.totalKnown).toBe('7487')
})
test('unknown, invalid and unsafe numeric fields stay unknown; missing step IDs never synthesize delta identity', () => {
  const event = {
    type: 'step_finish',
    part: {
      id: 'step',
      tokens: {
        input: -1,
        output: Number.MAX_SAFE_INTEGER + 1,
        cache: { read: '0', write: null },
        reasoning: 42,
      },
    },
  }
  const frame = normalizeRuntimeUsage('opencode', event, context)
  expect(frame.measurements[0]?.usage).toEqual({
    input: null,
    output: null,
    cacheRead: '0',
    cacheWrite: null,
  })
  expect(frame.diagnostics).toEqual(['invalid-token-count:input', 'invalid-token-count:output'])
  expect(frame.measurements[0]?.coverage).toBe('partial')
  expect(
    normalizeRuntimeUsage(
      'opencode',
      { type: 'step_finish', part: { tokens: { input: 5 } } },
      context,
    ),
  ).toEqual({ measurements: [], diagnostics: ['missing-step-identity'] })
})
test('repeated Claude assistant blocks count input once; placeholder output is never billed', () => {
  const first = parse(assistant('message-1', 100)).measurements
  const again = parse(assistant('message-1', 100), { revision: 2 }).measurements
  const totals = selectUsageContributions(ledger([...first, ...again]))
  expect(totals.summary.totalKnown).toBe('100')
  expect(totals.summary.unknownBuckets.output).toBe(1)
  expect(totals.allSelectedComplete).toBe(false)
})
test('main totals supersede only their own turn while child details remain separately attributable', () => {
  const parent = parse(assistant('message-1', 100)).measurements
  const child = parse(assistant('message-child', 60), {
    sessionId: 'child',
    parentSessionId: 'root',
    ancestors: ['root'],
  }).measurements
  const final = parse(result(90, 10), { revision: 3 }).measurements
  const laterTurn = parse(assistant('later', 7), {
    turnId: 'turn-2',
    turnIndex: 1,
    revision: 4,
  }).measurements
  const totals = selectUsageContributions(ledger([...parent, ...child, ...final, ...laterTurn]))
  expect(totals.summary.totalKnown).toBe('167')
  expect(totals.excluded).toBe(1)
  expect(
    totals.records.find((r) => r.measurement.recordId.startsWith('claude:main:'))?.measurement
      .model,
  ).toBeNull()
})
test('whole-tree model totals replace main and child evidence, including nested child totals', () => {
  const raw = [
    ...parse(assistant('parent', 100)).measurements,
    ...parse(assistant('child', 50), {
      sessionId: 'child',
      parentSessionId: 'root',
      ancestors: ['root'],
    }).measurements,
    ...parse(assistant('grandchild', 20), {
      sessionId: 'grandchild',
      parentSessionId: 'child',
      ancestors: ['root', 'child'],
    }).measurements,
    ...parse(
      { ...result(50), modelUsage: { 'model-a': modelUsage(70) } },
      { sessionId: 'child', parentSessionId: 'root', ancestors: ['root'], revision: 2 },
    ).measurements,
  ]
  expect(selectUsageContributions(ledger(raw)).summary.totalKnown).toBe('170')
  raw.push(
    ...parse(
      {
        ...result(100),
        modelUsage: { 'model-a': modelUsage(170, 5), 'model-b': modelUsage(20, 2) },
      },
      { revision: 3 },
    ).measurements,
  )
  const total = selectUsageContributions(ledger(raw))
  expect(total.summary.totalKnown).toBe('197')
  expect(total.records).toHaveLength(2)
  expect(total.allSelectedComplete).toBe(true)
})
test('restored session 100 → 130 adds only 30; unknown baselines retain available request evidence', () => {
  const baseline = { input: '100', output: '0', cacheRead: '0', cacheWrite: '0' }
  const cumulative = {
    kind: 'native-session' as const,
    lineageKey: 'native-epoch-1',
    modelBaselines: { 'model-a': baseline },
  }
  const raw = { ...result(30), modelUsage: { 'model-a': modelUsage(130) } }
  const known = parse(raw, { cumulative }).measurements
  expect(selectUsageContributions(ledger(known)).summary.totalKnown).toBe('30')
  const missing = parse(raw, { cumulative: { ...cumulative, modelBaselines: null } }).measurements
  const details = parse(assistant('resumed-message', 25)).measurements
  const partial = selectUsageContributions(ledger([...missing, ...details]))
  expect(partial.summary.totalKnown).toBe('25')
  expect(partial.unavailableSummaries).toBe(1)
  expect(partial.allSelectedComplete).toBe(false)
})
test('a zeroed crash final preserves earlier known use and marks coverage partial', () => {
  const detail = parse(assistant('message-1', 120)).measurements
  const crash = parse(
    { ...result(0), subtype: 'error_during_execution', is_error: true },
    { revision: 2 },
  ).measurements
  const total = selectUsageContributions(ledger([...detail, ...crash]))
  expect(total.summary.totalKnown).toBe('120')
  expect(total.allSelectedComplete).toBe(false)
  const before = parse({ ...result(120), modelUsage: { 'model-a': modelUsage(120) } }).measurements
  const later = parse(
    { ...result(0), subtype: 'error_during_execution', modelUsage: { 'model-a': modelUsage(0) } },
    { revision: 2, turnId: 'later-turn', turnIndex: 1 },
  ).measurements
  expect(selectUsageContributions(ledger([...before, ...later])).summary.totalKnown).toBe('120')
})
test('unmapped child frames are diagnosed; explicit ancestry cycles are rejected', () => {
  expect(parse({ ...assistant('child', 50), parent_tool_use_id: 'tool-1' }).diagnostics).toEqual([
    'unmapped-child-session',
  ])
  const cycle = ledger([
    ...parse(assistant('a', 1), {
      sessionId: 'a',
      parentSessionId: 'b',
      ancestors: ['root', 'a', 'b'],
    }).measurements,
    ...parse(assistant('b', 2), { sessionId: 'b', parentSessionId: 'a', ancestors: ['root', 'a'] })
      .measurements,
  ])
  expect(() => selectUsageContributions(cycle)).toThrow('Cyclic observation session ancestry')
})

test('an older cumulative total cannot hide usage from a later native turn or a crash', () => {
  const before = parse({ ...result(100), modelUsage: { 'model-a': modelUsage(100) } }).measurements
  const later = parse(assistant('next-turn-message', 20), {
    revision: 2,
    turnId: 'turn-2',
    turnIndex: 1,
  }).measurements
  const first = selectUsageContributions(ledger([...before, ...later]))
  expect(first.summary.totalKnown).toBe('120')
  expect(first.allSelectedComplete).toBe(false)
  const crash = parse(
    { ...result(0), subtype: 'error_during_execution', modelUsage: { 'model-a': modelUsage(0) } },
    { revision: 3, turnId: 'turn-2', turnIndex: 1 },
  ).measurements
  expect(selectUsageContributions(ledger([...before, ...later, ...crash])).summary.totalKnown).toBe(
    '120',
  )
})

test('partial model baselines and partial bucket coverage preserve uncovered detail', () => {
  const cumulative = {
    kind: 'native-session' as const,
    lineageKey: 'restored',
    modelBaselines: { 'model-b': { input: '100', output: '0', cacheRead: '0', cacheWrite: '0' } },
  }
  const totals = parse(
    {
      ...result(0),
      modelUsage: {
        'model-a': modelUsage(900),
        'model-b': modelUsage(120),
      },
    },
    { cumulative },
  ).measurements
  const detail = parse(assistant('model-a-new', 25)).measurements
  const selected = selectUsageContributions(ledger([...totals, ...detail]))
  expect(selected.summary.totalKnown).toBe('45')
  expect(selected.unavailableSummaries).toBe(1)
  expect(selected.allSelectedComplete).toBe(false)

  const previous = parse({ ...result(0), modelUsage: { 'model-a': modelUsage(100) } }).measurements
  const partial = parse(
    { ...result(0), modelUsage: { 'model-a': { ...modelUsage(120, 5), inputTokens: null } } },
    { revision: 3, turnId: 'turn-2', turnIndex: 1 },
  ).measurements
  const nextDetail = parse(assistant('later-detail', 20), {
    revision: 2,
    turnId: 'turn-2',
    turnIndex: 1,
  }).measurements
  const rows = ledger([...previous, ...nextDetail, ...partial])
  expect(rows.find((r) => r.measurement.scope?.level === 'tree-total')?.coveredThrough).toEqual({
    input: 0,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
  })
  expect(selectUsageContributions(rows).summary.totalKnown).toBe('125')
})

test('a root summary covers grandchildren whose intermediate parent emitted no usage', () => {
  const total = parse({ ...result(100), modelUsage: { 'model-a': modelUsage(100) } }).measurements
  const grandchild = parse(assistant('grandchild-only', 20), {
    sessionId: 'grandchild',
    parentSessionId: 'child',
    ancestors: ['root', 'child'],
    revision: 2,
  }).measurements
  const selected = selectUsageContributions(ledger([...total, ...grandchild]))
  expect(selected.summary.totalKnown).toBe('100')
  expect(selected.records).toHaveLength(1)
  expect(selected.allSelectedComplete).toBe(true)
})

test('overlapping child cumulative tails are not added wholesale to an older parent total', () => {
  const root = parse({ ...result(100), modelUsage: { 'model-a': modelUsage(100) } }).measurements
  const childContext = {
    sessionId: 'child',
    parentSessionId: 'root',
    ancestors: ['root'],
    revision: 2,
    turnId: 'turn-2',
    turnIndex: 1,
  }
  const child = parse(
    { ...result(80), modelUsage: { 'model-a': modelUsage(80) } },
    childContext,
  ).measurements
  const tail = parse(assistant('child-tail', 20), { ...childContext, revision: 3 }).measurements
  const selected = selectUsageContributions(ledger([...root, ...child, ...tail]))
  expect(selected.summary.totalKnown).toBe('120')
  expect(selected.ambiguousOverlaps).toBe(1)
  expect(selected.allSelectedComplete).toBe(false)
})

test('actual model identity survives an unknown provider route', () => {
  expect(parse(assistant('message-1', 1), { provider: null }).measurements[0]?.model).toEqual({
    provider: null,
    id: 'model-a',
  })
})

test('an unavailable summary bucket stays unknown instead of becoming an allocation zero', () => {
  const rows = parse({
    ...result(0),
    modelUsage: {
      'model-a': { ...modelUsage(10), outputTokens: null },
    },
  }).measurements
  const selected = selectUsageContributions(ledger(rows))
  expect(selected.records[0]?.contribution.output).toBeNull()
  expect(selected.summary.known.input).toBe('10')
  expect(selected.summary.unknownBuckets.output).toBe(1)
  expect(selected.summary.complete).toBe(0)
  expect(selected.allSelectedComplete).toBe(false)
})

test('unregistered runtime reports unavailable usage without invoking another protocol parser', () => {
  expect(normalizeRuntimeUsage('future-runtime', result(100), context)).toEqual({
    measurements: [],
    diagnostics: ['runtime-usage-unsupported'],
  })
})
