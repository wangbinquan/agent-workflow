// RFC-371 AW-R06: original occurrence clocks never become receipt/summary clocks or current prices.
import { expect, test } from 'bun:test'
import { ObservationOverviewQuerySchema } from '@agent-workflow/shared'
import { completeObservationOccurrence } from '@/modules/run-observability/application/completeObservationOccurrence'
import type { PlatformObservation } from '@/modules/run-observability/domain/platformObservation'
import type {
  CompleteObservationContribution,
  CompleteObservationTaskInput,
} from '@/modules/run-observability/ports/completeObservationTask'

const usage = { input: '11', cacheRead: '13', cacheWrite: '17', output: '19' }
const original: CompleteObservationContribution = {
  sourceId: 'original-source',
  invocationId: 'original-invocation',
  observedAt: 999_999,
  localModel: { provider: 'original-provider', id: 'original-model' },
  contribution: { ...usage, input: '5' },
  complete: true,
  measurement: {
    invocationId: 'original-invocation',
    recordId: 'opencode:step:original-step',
    model: { provider: 'original-provider', id: 'original-model' },
    usage,
    reporting: 'delta',
    inclusion: 'self',
    basis: { kind: 'invocation' },
    occurredAt: null,
  },
}
type Version =
  NonNullable<CompleteObservationTaskInput['occurrenceVersions']> extends (
    ...args: never[]
  ) => AsyncIterable<infer V>
    ? V
    : never
const version = (occurredAt: number | null): Version => ({
  source: 'original-native',
  stepId: 'original-step',
  occurredAt,
  usage,
  model: original.localModel,
})
const evidence = (versions: Version[]) => ({
  occurrenceVersions: async function* () {
    yield* versions
  },
})

test('omitted cohort retains the original query echo and explicit usage remains distinct', () => {
  const query = { from: 100, to: 200, timezone: 'UTC' }
  expect(ObservationOverviewQuerySchema.parse(query)).toEqual(query)
  expect(ObservationOverviewQuerySchema.parse({ ...query, cohort: 'usage' })).toEqual({
    ...query,
    cohort: 'usage',
  })
  expect(ObservationOverviewQuerySchema.safeParse({ ...query, cohort: 'received' }).success).toBe(
    false,
  )
})
test('original measurement clock wins without reading a newer native version or the late receipt clock', async () => {
  const input = {
    occurrenceVersions: async function* () {
      throw new Error('must not reread original clock')
      yield version(999_999)
    },
  }
  expect(
    await completeObservationOccurrence(
      input,
      { ...original, measurement: { ...original.measurement, occurredAt: 150 } },
      'original-native',
    ),
  ).toEqual({ occurredAt: 150, basis: 'native-step' })
})
test('missing clock matches original measurement rather than child-subtracted contribution and all matching times agree', async () => {
  expect(
    await completeObservationOccurrence(
      evidence([version(150), version(150)]),
      original,
      'original-native',
    ),
  ).toEqual({ occurredAt: 150, basis: 'native-step' })
  expect(
    await completeObservationOccurrence(
      evidence([version(150), version(151)]),
      original,
      'original-native',
    ),
  ).toEqual({ occurredAt: null, basis: null, reason: 'time-conflicting' })
  expect(
    await completeObservationOccurrence(evidence([version(null)]), original, 'original-native'),
  ).toEqual({ occurredAt: null, basis: null, reason: 'time-unobserved' })
})
test('wrong native identity, original usage or known model never manufactures a time', async () => {
  for (const other of [
    { ...version(150), source: 'other-native' },
    { ...version(150), stepId: 'other-step' },
    { ...version(150), usage: original.contribution },
    { ...version(150), model: { provider: 'other-provider', id: 'original-model' } },
    { ...version(150), model: { provider: 'original-provider', id: 'other-model' } },
  ])
    expect(
      await completeObservationOccurrence(evidence([other]), original, 'original-native'),
    ).toMatchObject({ occurredAt: null, reason: 'time-evidence-missing' })
  expect(
    await completeObservationOccurrence(evidence([version(150)]), original, null),
  ).toMatchObject({ occurredAt: null, reason: 'time-evidence-missing' })
})
test('delta alone and cumulative/tree totals never use the final or receipt clock as consumption time', async () => {
  const scope = {
    root: 'root',
    session: 'root',
    parentSession: null,
    ancestors: [],
    turn: 'turn',
    turnIndex: 0,
    level: 'request' as const,
  }
  const flat = {
    ...original,
    measurement: { ...original.measurement, recordId: 'flat', occurredAt: 150 },
  }
  expect(await completeObservationOccurrence({}, flat, null)).toMatchObject({
    occurredAt: null,
    reason: 'time-nondiscrete',
  })
  expect(
    await completeObservationOccurrence(
      {},
      { ...flat, measurement: { ...flat.measurement, scope } },
      null,
    ),
  ).toEqual({ occurredAt: 150, basis: 'request' })
  for (const level of ['self-total', 'tree-total'] as const)
    expect(
      await completeObservationOccurrence(
        {},
        {
          ...original,
          measurement: { ...original.measurement, occurredAt: 150, scope: { ...scope, level } },
        },
        'original-native',
      ),
    ).toMatchObject({ occurredAt: null, reason: 'time-nondiscrete' })
  expect(
    await completeObservationOccurrence(
      {},
      {
        ...original,
        measurement: { ...original.measurement, occurredAt: 150, reporting: 'cumulative' },
      },
      'original-native',
    ),
  ).toMatchObject({ occurredAt: null, reason: 'time-nondiscrete' })
})

test('a platform request uses its own occurrence contract and never borrows the local wrapper clock or scope', async () => {
  const platform: Extract<PlatformObservation, { kind: 'usage' }> = {
    kind: 'usage',
    identity: {
      projectId: 'project',
      taskId: 'task',
      subtaskId: 'subtask',
      executionId: 'execution',
      executionGeneration: 1,
    },
    sourceId: 'platform-source',
    recordId: 'platform-record',
    revision: 1,
    occurredAt: new Date(150).toISOString(),
    observedAt: new Date(999_999).toISOString(),
    adapterVersion: 'platform-original',
    modelRef: null,
    reporting: 'delta',
    inclusion: 'self',
    coverage: 'complete',
    validity: 'valid',
    scope: {
      root: 'root',
      session: 'root',
      parentSession: null,
      ancestors: [],
      turn: 'turn',
      turnIndex: 0,
      level: 'request',
    },
    coveredThroughTurn: null,
    usage,
    basis: { kind: 'invocation' },
    projection: {
      projectionRevision: 1,
      observedRevision: 1,
      contribution: usage,
      coveredThrough: null,
      complete: true,
      issues: [],
    },
  }
  const record = {
    ...original,
    platformUsage: platform,
    measurement: { ...original.measurement, occurredAt: 175, scope: platform.scope! },
  }
  expect(await completeObservationOccurrence({}, record, 'local-native')).toEqual({
    occurredAt: 150,
    basis: 'request',
  })
  expect(
    await completeObservationOccurrence(
      {},
      { ...record, platformUsage: { ...platform, occurredAt: null } },
      'local-native',
    ),
  ).toMatchObject({ occurredAt: null, reason: 'time-unobserved' })
  expect(
    await completeObservationOccurrence(
      {},
      { ...record, platformUsage: { ...platform, scope: null } },
      'local-native',
    ),
  ).toMatchObject({ occurredAt: null, reason: 'time-nondiscrete' })
  expect(
    await completeObservationOccurrence(
      {},
      { ...record, platformUsage: { ...platform, reporting: 'cumulative' } },
      'local-native',
    ),
  ).toMatchObject({ occurredAt: null, reason: 'time-nondiscrete' })
})
