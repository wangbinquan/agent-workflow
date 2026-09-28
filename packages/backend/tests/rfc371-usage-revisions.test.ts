// RFC-371: a resume contributes its new usage; invalid finals never erase known tokens.
import { expect, test } from 'bun:test'
import { ObservationMeasurementSchema, type ObservationMeasurement } from '@agent-workflow/shared'
import { reconcileUsage } from '../src/modules/run-observability/domain/usageLedger'
import { summarizeTokenUsage } from '../src/modules/run-observability/domain/tokenUsage'

const counts = (input: string | null) => ({ input, output: '0', cacheRead: '0', cacheWrite: '0' })
function measurement(patch: Partial<ObservationMeasurement> = {}): ObservationMeasurement {
  return {
    schemaVersion: 1,
    invocationId: 'attempt-1',
    recordId: 'main-loop',
    revision: 1,
    taskId: 'task-1',
    nodeRunId: 'node-1',
    agentId: 'agent-1',
    occurredAt: null,
    observedAt: 100,
    model: { provider: 'provider', id: 'model' },
    adapterVersion: 'fixture-v1',
    reporting: 'cumulative',
    inclusion: 'self',
    coverage: 'complete',
    validity: 'valid',
    basis: { kind: 'invocation' },
    usage: counts('100'),
    ...patch,
  }
}

test('native session 100 then resumed 130 produces 100 + 30, never 230', () => {
  const first = reconcileUsage('source', measurement()).record
  const resumed = reconcileUsage(
    'source',
    measurement({
      invocationId: 'attempt-2',
      usage: counts('130'),
      basis: {
        kind: 'native-session',
        lineageKey: 'session-1:generation-1',
        baseline: counts('100'),
      },
    }),
  ).record
  expect(resumed.contribution.input).toBe('30')
  expect(summarizeTokenUsage([first.contribution, resumed.contribution]).totalKnown).toBe('130')
  const unproven = reconcileUsage(
    'source',
    measurement({ basis: { kind: 'native-session', lineageKey: 'unproven', baseline: null } }),
  ).record
  expect(unproven.contribution.input).toBeNull()
  expect(unproven.measurement.usage.input).toBe('100')
  expect(unproven).toMatchObject({ complete: false, issues: ['baseline-unknown'] })
})

test('invalid final, unexplained decrease and stale delivery preserve the known contribution', () => {
  const first = reconcileUsage('source', measurement({ usage: counts('120') })).record
  const invalid = reconcileUsage(
    'source',
    measurement({ revision: 2, validity: 'invalid-final', usage: counts('0') }),
    first,
  ).record
  expect(invalid).toMatchObject({ observedRevision: 2, complete: false, issues: ['invalid-final'] })
  expect(invalid.contribution.input).toBe('120')
  const stale = reconcileUsage('source', measurement({ usage: counts('500') }), invalid)
  expect(stale).toEqual({ outcome: 'stale', record: invalid })
  const decrease = reconcileUsage(
    'source',
    measurement({ revision: 3, usage: counts('90') }),
    invalid,
  )
  expect(decrease.record.contribution.input).toBe('120')
  expect(decrease.record.issues).toContain('unexplained-decrease')
  const correction = reconcileUsage(
    'source',
    measurement({ revision: 4, validity: 'correction', usage: counts('90') }),
    decrease.record,
  )
  expect(correction.record).toMatchObject({
    contribution: counts('90'),
    complete: true,
    issues: [],
  })
})

for (const rejected of [
  measurement({ validity: 'invalid-final', usage: counts('0') }),
  measurement({ validity: 'invalid-final', usage: counts('120') }),
  measurement({
    usage: counts('90'),
    basis: { kind: 'native-session', lineageKey: 'session', baseline: counts('100') },
  }),
]) {
  test(
    'rejected first evidence cannot supply reusable counters: ' +
      rejected.validity +
      '/' +
      rejected.usage.input,
    () => {
      const first = reconcileUsage('source', rejected).record
      const partial = reconcileUsage(
        'source',
        measurement({
          revision: 2,
          basis: rejected.basis,
          coverage: 'partial',
          usage: { input: null, output: '8', cacheRead: '0', cacheWrite: '0' },
        }),
        first,
      ).record
      expect(partial).toMatchObject({
        contribution: { input: null, output: '8' },
        measurement: { usage: { input: null, output: '8' } },
        complete: false,
        issues: [],
      })
    },
  )
}

test('missing counters do not erase known usage or become an assertion of completeness', () => {
  const prior = reconcileUsage('source', measurement()).record
  const next = reconcileUsage('source', measurement({ revision: 2, usage: counts(null) }), prior)
  expect(next.record).toMatchObject({ contribution: counts('100'), complete: false })
  for (const patch of [
    { taskId: 'other' },
    { model: { provider: 'other', id: 'model' } },
    { inclusion: 'unknown' as const },
  ]) {
    const changed = reconcileUsage('source', measurement({ ...patch, revision: 3 }), next.record)
    expect(changed.record).toMatchObject({ contribution: counts('100'), complete: false })
    expect(changed.record.issues).toContain('identity-conflict')
  }
})

test('unknown inclusion and a baseline above current usage remain diagnostics', () => {
  expect(reconcileUsage('source', measurement({ inclusion: 'unknown' })).record).toMatchObject({
    complete: false,
    issues: ['unknown-inclusion'],
  })
  const result = reconcileUsage(
    'source',
    measurement({
      basis: { kind: 'native-session', lineageKey: 'session', baseline: counts('101') },
    }),
  )
  expect(result.record.contribution.input).toBeNull()
  expect(result.record.issues).toContain('baseline-exceeds-observation')
  expect(ObservationMeasurementSchema.safeParse(measurement({ usage: counts('-1') })).success).toBe(
    false,
  )
  expect(
    ObservationMeasurementSchema.safeParse(measurement({ usage: counts('9007199254740993000') }))
      .success,
  ).toBe(true)
})
