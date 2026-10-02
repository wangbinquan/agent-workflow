import { expect, test } from 'bun:test'
import {
  AcceptedObservationInvocationSchema,
  type ObservationSpanFact,
  type ObservationSpanSourceRecord,
} from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createTaskSpanQuery } from '../src/modules/run-observability/application/taskSpans'
import type {
  ObservationSnapshot,
  ObservationSnapshotSources,
} from '../src/modules/run-observability/ports/taskObservations'

const actor = buildActor({
  user: {
    id: 'reader',
    username: 'reader',
    displayName: 'Reader',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})
const accepted = AcceptedObservationInvocationSchema.parse({
  invocationId: 'call',
  taskId: 'task',
  nodeRunId: 'run',
  agentId: 'agent',
  agentRevision: 1,
  purpose: 'task',
  authority: { kind: 'local', runtime: null },
  acceptedAt: 1,
  priceBookRevision: null,
  spanCaptureContract: 'runtime-span-facts-v1',
  spanCaptureSource: 'source',
})
const fact: ObservationSpanFact = {
  schemaVersion: 1,
  invocationId: 'call',
  spanKey: 'model-call',
  scope: {
    sourceNamespace: 'source',
    rootSessionId: 'root',
    nativeSessionId: 'root',
    parentNativeSessionId: null,
    ancestors: [],
    callId: 'model',
    kind: 'model',
  },
  label: 'actual-model',
  parentCallId: null,
  model: { provider: 'actual-provider', id: 'actual-model' },
  measurementRecordId: 'model-record',
  state: { startedAt: 10, endedAt: 30, nativeObservedAt: 30, status: 'success' },
  capturedAt: 31,
}
function fixture(visible = true) {
  const calls: string[] = [],
    records: ObservationSpanSourceRecord[] = [
      { type: 'fact', sourceRowId: 1, nodeRunId: 'run', itemIndex: 0, fact },
    ]
  const unexpected = () => {
    throw new Error('Unexpected source read')
  }
  const sources: ObservationSnapshotSources = {
    tasks: {
      get: async () => {
        calls.push('actor')
        return visible
          ? {
              id: 'task',
              name: 'Task',
              status: 'running',
              parentTaskId: null,
              startedAt: 1,
              finishedAt: null,
              runningMs: 0,
              runningSince: 1,
            }
          : null
      },
      list: unexpected,
      sourceBacklog: unexpected,
      attempts: async () => {
        calls.push('attempt')
        return {
          items: [
            {
              id: 'run',
              nodeId: 'node',
              status: 'running',
              startedAt: 1,
              finishedAt: null,
              retryIndex: 0,
              iteration: 0,
              wgRound: null,
              reviewIteration: 0,
            },
          ],
          truncated: false,
        }
      },
      spanSources: async () => {
        calls.push('source')
        return {
          records,
          scannedSources: 1,
          watermark: 1,
          nextCursor: null,
          truncated: false,
          issues: [],
        }
      },
    },
    invocations: async () => {
      calls.push('accepted')
      return { items: [accepted], truncated: false }
    },
    local: { records: unexpected, captures: unexpected },
    platform: { records: unexpected },
    value: unexpected,
  }
  const snapshot: ObservationSnapshot = { read: (work) => work(sources) }
  const query = createTaskSpanQuery(snapshot, async () => {
    calls.push('contribution')
    return {
      truncated: false,
      records: [
        {
          invocationId: 'call',
          recordId: 'model-record',
          usage: { input: '10', cacheRead: '20', cacheWrite: '0', output: '3' },
          amountDecimal: '0.000123',
          costComplete: true,
        },
      ],
    }
  })
  return { query, calls, records }
}
test('the original actor visibility check precedes all accepted/source/value reads and preserves 404 for a missing attempt', async () => {
  const hidden = fixture(false)
  expect(await hidden.query(actor, 'task', { nodeRunId: 'run' })).toBeNull()
  expect(hidden.calls).toEqual(['actor'])
  const missing = fixture()
  expect(await missing.query(actor, 'task', { nodeRunId: 'missing' })).toBeNull()
  expect(missing.calls).toEqual(['actor', 'attempt'])
})
test('spans link the already-selected four buckets and exact CNY without inventing zero for an excluded measurement', async () => {
  const f = fixture(),
    result = await f.query(actor, 'task', { nodeRunId: 'run' })
  expect(result!.spans[0]).toMatchObject({
    durationMs: 20,
    usage: { input: '10', cacheRead: '20', cacheWrite: '0', output: '3' },
    cost: { currency: 'CNY', amountDecimal: '0.000123' },
  })
  f.records.push({
    type: 'fact',
    sourceRowId: 1,
    nodeRunId: 'run',
    itemIndex: 1,
    fact: {
      ...fact,
      spanKey: 'excluded',
      measurementRecordId: 'tree-covered-record',
      scope: { ...fact.scope, callId: 'other' },
    },
  })
  const next = await f.query(actor, 'task', { nodeRunId: 'run' })
  expect(next!.spans[1]).toMatchObject({ usage: null, cost: null })
})
