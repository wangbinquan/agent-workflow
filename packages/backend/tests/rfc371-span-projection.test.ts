import { expect, test } from 'bun:test'
import {
  AcceptedObservationInvocationSchema,
  type ObservationSpanFact,
  type ObservationSpanSourceRecord,
} from '@agent-workflow/shared'
import { projectObservationSpans } from '../src/modules/run-observability/domain/spanProjection'

const acceptance = (id: string) =>
  AcceptedObservationInvocationSchema.parse({
    invocationId: id,
    taskId: 'task',
    nodeRunId: 'run-' + id,
    agentId: 'agent',
    agentRevision: 1,
    purpose: 'task',
    authority: { kind: 'local', runtime: null },
    acceptedAt: 1,
    priceBookRevision: null,
    spanCaptureContract: 'runtime-span-facts-v1',
    spanCaptureSource: 'source',
  })
const a = acceptance('A'),
  b = acceptance('B')
const fact = (patch: Partial<ObservationSpanFact> = {}): ObservationSpanFact => ({
  schemaVersion: 1,
  invocationId: 'A',
  spanKey: 'span',
  scope: {
    sourceNamespace: 'source',
    rootSessionId: 'root',
    nativeSessionId: 'root',
    parentNativeSessionId: null,
    ancestors: [],
    callId: 'tool',
    kind: 'tool',
  },
  label: 'Read',
  parentCallId: null,
  model: null,
  measurementRecordId: null,
  state: { startedAt: 100, endedAt: null, nativeObservedAt: 100, status: 'open' },
  capturedAt: 110,
  ...patch,
})
const original = fact()
const creation: ObservationSpanSourceRecord = {
  type: 'fact',
  sourceRowId: 1,
  nodeRunId: 'run-A',
  itemIndex: 0,
  fact: original,
}
const revision: ObservationSpanSourceRecord = {
  type: 'revision',
  sourceRowId: 2,
  nodeRunId: 'run-B',
  itemIndex: 0,
  revision: {
    carrierInvocationId: 'B',
    targetOwnerInvocationId: 'A',
    targetSpanKey: 'span',
    originalOwnerProof: {
      sourceRowId: 1,
      sourceNodeRunId: 'run-A',
      itemIndex: 0,
      accepted: a,
      spanKey: 'span',
      scope: original.scope,
      creation: original,
    },
    before: original.state,
    after: { startedAt: 100, endedAt: 200, nativeObservedAt: 200, status: 'success' },
    capturedAt: 210,
  },
}
const project = (records: ObservationSpanSourceRecord[]) =>
  projectObservationSpans({ taskId: 'task', accepted: [a, b], records })

test('B completion repairs the one original A span without creating a B call; order and duplicate delivery are immaterial', () => {
  for (const records of [
    [creation, revision],
    [revision, creation, revision],
  ]) {
    const result = project(records)
    expect(result.spans).toHaveLength(1)
    expect(result.spans[0]!.fact).toMatchObject({
      invocationId: 'A',
      state: { startedAt: 100, endedAt: 200, status: 'success' },
    })
    expect(result.repairs.get('B')?.size).toBe(1)
    expect(result.issues).toEqual([])
  }
})
test('a late open update cannot undo a terminal result; conflicting native ends become unknown', () => {
  const end: ObservationSpanSourceRecord = {
    ...creation,
    sourceRowId: 3,
    fact: fact({
      state: { startedAt: 100, endedAt: 200, nativeObservedAt: 200, status: 'success' },
    }),
  }
  expect(
    project([end, creation, { ...creation, sourceRowId: 4 }]).spans[0]!.fact.state.endedAt,
  ).toBe(200)
  const conflict: ObservationSpanSourceRecord = {
    ...end,
    sourceRowId: 5,
    fact: fact({
      state: { startedAt: 100, endedAt: 201, nativeObservedAt: 201, status: 'success' },
    }),
  }
  const result = project([creation, end, conflict])
  expect(result.spans[0]!.fact.state).toMatchObject({
    startedAt: null,
    endedAt: null,
    status: 'unknown',
  })
  expect(result.spans[0]!.issues.has('span-boundary-conflict')).toBe(true)
})
test('the original retained row, item, creation bytes, accepted owner and node must all match a prior proof', () => {
  if (revision.type !== 'revision') throw new Error('fixture')
  for (const originalOwnerProof of [
    { ...revision.revision.originalOwnerProof, sourceRowId: 99 },
    { ...revision.revision.originalOwnerProof, sourceNodeRunId: 'other' },
    { ...revision.revision.originalOwnerProof, creation: fact({ label: 'changed' }) },
    { ...revision.revision.originalOwnerProof, accepted: { ...a, agentRevision: 99 } },
  ]) {
    const result = project([
      creation,
      { ...revision, revision: { ...revision.revision, originalOwnerProof } },
    ])
    expect(result.issues).toContain('span-prior-proof-invalid')
    expect(result.spans[0]!.fact.state.endedAt).toBeNull()
  }
})
test('legacy acceptance is not upgraded by new metadata and equal names never merge different native identities', () => {
  const { spanCaptureContract: _contract, spanCaptureSource: _source, ...legacy } = a
  expect(
    projectObservationSpans({
      taskId: 'task',
      accepted: [legacy, b],
      records: [creation, revision],
    }).spans,
  ).toEqual([])
  const second = fact({ spanKey: 'another', scope: { ...original.scope, callId: 'second' } })
  expect(project([creation, { ...creation, itemIndex: 1, fact: second }]).spans).toHaveLength(2)
})
