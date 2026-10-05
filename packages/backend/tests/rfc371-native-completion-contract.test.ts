import { expect, test } from 'bun:test'
import { ObservationNativeCaptureSchema } from '@agent-workflow/shared'
import type {
  ObservationNativeCompletion,
  ObservationNativeMeasurement,
  ObservationNativeScopeReference,
} from '@agent-workflow/shared'
import {
  ObservationNativeBeforeSpawnAckSchema,
  ObservationNativeCompletionSchema,
  ObservationNativeMeasurementSchema,
  ObservationNativePassCompletionSchema,
  ObservationNativeScopeReferenceSchema,
  ObservationNativeSourceAckSchema,
  ObservationCapturedUsageSchema,
  ObservationMeasurementSchema,
  ObservationUsageCaptureCommitSchema,
  parseObservationCapturedUsage,
} from '@agent-workflow/shared'

const digest = 'a'.repeat(64)
const identity = {
  passId: 'original-final-pass',
  invocationId: 'original-invocation',
  nativeSource: 'original-native-store',
  sourceGeneration: 'original-store-generation',
  rootSessionId: 'original-root',
  lineage: 'original-task-lineage',
  epoch: '2',
  phase: 'final' as const,
}
const counts = { sessions: '2', parts: '3', steps: '1' }
const ack = {
  contract: 'native-usage-page-ack-v2' as const,
  identity,
  ownerReceiptId: 'original-owner-receipt',
  ordinal: '1',
  payloadDigest: digest,
  cumulativeDigest: digest,
  scanPositionAfter: '5',
  counts,
  nextCursor: null,
  sourceWatermark: '41',
  eof: { fingerprint: digest, counts },
}
const fresh = (): ObservationNativeCompletion => ({
  contract: 'opencode-child-pages-v2',
  nativeSource: identity.nativeSource,
  rootSessionId: identity.rootSessionId,
  state: 'complete',
  baseline: {
    kind: 'fresh',
    beforeSpawnReceiptId: 'original-before-spawn-receipt',
    preparedAt: 5,
    rootCreatedAt: 11,
  },
  final: { ack, pageCount: '2' },
  observedAt: 30,
  process: { spawnedAt: 10, reapedAt: 29, drainedAt: 28 },
  emissions: { records: '1', frames: '1', digest, sourceWatermark: '41' },
  reconciliation: { examined: '0', resolved: '0', unresolved: '0', digest },
  issues: [],
})
const scope: ObservationNativeScopeReference = {
  root: identity.rootSessionId,
  session: 'original-child',
  parentSession: identity.rootSessionId,
  ancestry: {
    kind: 'native-pass-v2',
    identity,
    ownerReceiptId: ack.ownerReceiptId,
    pageOrdinal: ack.ordinal,
    cumulativeDigest: ack.cumulativeDigest,
  },
  turn: identity.invocationId,
  turnIndex: 0,
  level: 'request',
}
const measurement: ObservationNativeMeasurement = {
  schemaVersion: 1,
  invocationId: identity.invocationId,
  recordId: 'opencode:step:original-part',
  revision: 1,
  taskId: 'original-task',
  nodeRunId: 'original-node-run',
  agentId: null,
  occurredAt: 12,
  observedAt: 30,
  model: { provider: 'actual-provider', id: 'actual-model' },
  adapterVersion: 'opencode-native-child-pages/v2',
  reporting: 'delta',
  inclusion: 'self',
  coverage: 'complete',
  validity: 'valid',
  scope,
  basis: { kind: 'invocation' },
  usage: { input: '11', cacheRead: '13', cacheWrite: '17', output: '19' },
}

test('the durable parser retains original page references and isolates optional trace damage', () => {
  const value = {
    invocationId: identity.invocationId,
    measurements: [measurement],
    diagnostics: [],
    nativeCompletion: fresh(),
  }
  const parsed = parseObservationCapturedUsage(value)
  expect(parsed.measurements).toEqual([measurement])
  expect(parsed.nativeCompletion).toEqual(fresh())
  expect(ObservationMeasurementSchema.shape.scope).toBeDefined()
  const damaged = parseObservationCapturedUsage({ ...value, spanFacts: [{ incomplete: true }] })
  expect(damaged.measurements).toEqual(parsed.measurements)
  expect(damaged.nativeCompletion).toEqual(parsed.nativeCompletion)
  expect(damaged.diagnostics).toEqual(['span-metadata-invalid'])
  expect(damaged.spanFacts).toBeUndefined()
})

test('invalid outer invocation or dual native contracts never bypass numeric parser rollback', () => {
  const value = {
    invocationId: identity.invocationId,
    measurements: [measurement],
    diagnostics: [],
    nativeCompletion: fresh(),
  }
  const wrong = { ...value, invocationId: 'another-original-invocation', spanFacts: [{}] }
  expect(ObservationCapturedUsageSchema.safeParse(wrong).success).toBe(false)
  expect(() => parseObservationCapturedUsage(wrong)).toThrow('original invocation')
  expect(
    ObservationUsageCaptureCommitSchema.safeParse({
      invocationId: wrong.invocationId,
      taskId: measurement.taskId,
      capture: fresh(),
    }).success,
  ).toBe(false)
  const legacy = {
    contract: 'opencode-child-steps-v1',
    nativeSource: identity.nativeSource,
    rootSessionId: identity.rootSessionId,
    state: 'complete',
    baseline: { kind: 'fresh', fingerprint: null },
    snapshotFingerprint: 'original-legacy',
    observedAt: 30,
    scannedSessions: 2,
    scannedSteps: 1,
    issues: [],
    priorRevisions: [],
  }
  expect(() =>
    parseObservationCapturedUsage({ ...value, capture: legacy, spanFacts: [{}] }),
  ).toThrow('two native capture contracts')
})

test('a valid source ACK parses; scope retains its own strict binding checks', () => {
  const value = {
    contract: 'native-usage-source-ack-v2',
    invocationId: identity.invocationId,
    eventId: 'original-frozen-event',
    fingerprint: digest,
    sourceWatermark: '41',
    measurements: [measurement],
  }
  expect(ObservationNativeSourceAckSchema.parse(value).measurements).toHaveLength(1)
  expect(ObservationNativeScopeReferenceSchema.safeParse(scope).success).toBe(true)
  expect(
    ObservationNativeScopeReferenceSchema.safeParse({ ...scope, root: 'other-root' }).success,
  ).toBe(false)
  expect(ObservationNativeScopeReferenceSchema.safeParse({ ...scope, ancestors: [] }).success).toBe(
    false,
  )
  expect(
    ObservationNativeMeasurementSchema.safeParse({ ...measurement, invocationId: 'other' }).success,
  ).toBe(false)
  expect(
    ObservationNativeSourceAckSchema.safeParse({ ...value, sourceWatermark: '0' }).success,
  ).toBe(false)
})

test('each absent fresh before/birth fact stays explicit partial and cannot qualify as complete', () => {
  expect(ObservationNativeCompletionSchema.safeParse(fresh()).success).toBe(true)
  for (const field of ['beforeSpawnReceiptId', 'preparedAt', 'rootCreatedAt'] as const) {
    const value = fresh()
    const baseline = { ...value.baseline, [field]: null }
    expect(
      ObservationNativeCompletionSchema.safeParse({ ...value, state: 'partial', baseline }).success,
    ).toBe(true)
    expect(ObservationNativeCompletionSchema.safeParse({ ...value, baseline }).success).toBe(false)
  }
  const value = fresh()
  expect(
    ObservationNativeCompletionSchema.safeParse({
      ...value,
      state: 'partial',
      baseline: { ...value.baseline, preparedAt: 11 },
    }).success,
  ).toBe(false)
})

test('resume without the actual before EOF remains partial; a known mismatched baseline is rejected', () => {
  const value = fresh()
  const missing = { ...value, baseline: { kind: 'resume', pass: null } }
  expect(
    ObservationNativeCompletionSchema.safeParse({ ...missing, state: 'partial' }).success,
  ).toBe(true)
  expect(ObservationNativeCompletionSchema.safeParse(missing).success).toBe(false)
  const baseline = {
    kind: 'resume',
    pass: {
      ack: { ...ack, identity: { ...identity, passId: 'before', phase: 'baseline' } },
      pageCount: '2',
    },
  }
  const reconciliation = { ...value.reconciliation, examined: '1', resolved: '1' }
  expect(
    ObservationNativeCompletionSchema.safeParse({ ...value, baseline, reconciliation }).success,
  ).toBe(true)
  const wrong = {
    ...baseline,
    pass: {
      ...baseline.pass,
      ack: {
        ...baseline.pass.ack,
        identity: { ...baseline.pass.ack.identity, sourceGeneration: 'another-generation' },
      },
    },
  }
  expect(
    ObservationNativeCompletionSchema.safeParse({
      ...value,
      state: 'partial',
      baseline: wrong,
      reconciliation,
    }).success,
  ).toBe(false)
  const interrupted = {
    ...value,
    state: 'partial',
    baseline,
    reconciliation,
    final: null,
    finalProgress: { ...ack, nextCursor: 'actual-interrupted-cursor', eof: null },
    issues: ['native-pass-interrupted'],
  }
  expect(ObservationNativeCompletionSchema.safeParse(interrupted).success).toBe(true)
  for (const field of ['invocationId', 'sourceGeneration', 'lineage', 'epoch'] as const)
    expect(
      ObservationNativeCompletionSchema.safeParse({
        ...interrupted,
        finalProgress: {
          ...interrupted.finalProgress,
          identity: { ...identity, [field]: 'other-original-binding' },
        },
      }).success,
    ).toBe(false)
})

test('a failed final pass retains only its actual committed prefix; missing root/spawn stays unknown', () => {
  const value = fresh()
  const interrupted = {
    ...value,
    state: 'partial',
    final: null,
    finalProgress: { ...ack, nextCursor: 'original-next-cursor', eof: null },
    issues: ['native-pass-interrupted'],
  }
  expect(ObservationNativeCompletionSchema.safeParse(interrupted).success).toBe(true)
  expect(
    ObservationNativeCompletionSchema.safeParse({ ...interrupted, state: 'complete' }).success,
  ).toBe(false)
  expect(
    ObservationNativeCompletionSchema.safeParse({
      ...interrupted,
      finalProgress: {
        ...interrupted.finalProgress,
        identity: { ...identity, nativeSource: 'other' },
      },
    }).success,
  ).toBe(false)
  const absent = {
    ...interrupted,
    rootSessionId: null,
    baseline: { kind: 'fresh', beforeSpawnReceiptId: null, preparedAt: null, rootCreatedAt: null },
    process: { spawnedAt: null, reapedAt: null, drainedAt: null },
  }
  const { finalProgress: _progress, ...unknown } = absent
  expect(ObservationNativeCompletionSchema.safeParse(unknown).success).toBe(true)
  expect(
    ObservationNativeCompletionSchema.safeParse({ ...unknown, state: 'complete' }).success,
  ).toBe(false)
})

test('complete EOF counts and page ordinals retain arbitrary precision with no population cap', () => {
  const pageCount = '1000000000000000000000000000001'
  const population = { sessions: '100000', parts: '10000000', steps: '10000000' }
  const reference = {
    ack: {
      ...ack,
      ordinal: (BigInt(pageCount) - 1n).toString(),
      counts: population,
      eof: { fingerprint: digest, counts: population },
    },
    pageCount,
  }
  expect(ObservationNativePassCompletionSchema.parse(reference).ack.counts).toEqual(population)
  expect(
    ObservationNativePassCompletionSchema.safeParse({ ...reference, pageCount: '2' }).success,
  ).toBe(false)
  expect(ObservationNativeCaptureSchema.safeParse(fresh()).success).toBe(false)
  expect(
    ObservationNativeCaptureSchema.safeParse({
      contract: 'opencode-child-steps-v1',
      nativeSource: identity.nativeSource,
      rootSessionId: identity.rootSessionId,
      state: 'complete',
      baseline: { kind: 'fresh', fingerprint: null },
      snapshotFingerprint: digest,
      observedAt: 30,
      scannedSessions: 2,
      scannedSteps: 1,
      issues: [],
      priorRevisions: [],
    }).success,
  ).toBe(true)
})

test('the before-spawn receipt explicitly separates an unborn fresh root from the actual resume root', () => {
  const value = {
    contract: 'native-usage-before-spawn-v2',
    invocationId: identity.invocationId,
    nativeSource: identity.nativeSource,
    sourceGeneration: identity.sourceGeneration,
    lineage: identity.lineage,
    epoch: identity.epoch,
    ownerReceiptId: 'before-receipt',
    preparedAt: 5,
    mode: 'fresh',
    rootSessionId: null,
  }
  expect(ObservationNativeBeforeSpawnAckSchema.safeParse(value).success).toBe(true)
  expect(
    ObservationNativeBeforeSpawnAckSchema.safeParse({ ...value, mode: 'resume' }).success,
  ).toBe(false)
  expect(
    ObservationNativeBeforeSpawnAckSchema.safeParse({
      ...value,
      mode: 'resume',
      rootSessionId: identity.rootSessionId,
    }).success,
  ).toBe(true)
})
