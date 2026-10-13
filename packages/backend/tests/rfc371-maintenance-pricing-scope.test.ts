// RFC-371: explicit corrective catalogues never rewrite acceptance or price a new tail/hosted invocation locally.
import { expect, test } from 'bun:test'
import {
  AcceptedObservationInvocationSchema,
  type ObservationPriceVersion,
} from '@agent-workflow/shared'
import { createInvocationValuation } from '@/modules/run-observability/application/invocationValuation'
const accepted = AcceptedObservationInvocationSchema.parse({
  invocationId: 'original',
  taskId: 'task',
  nodeRunId: 'run',
  agentId: null,
  agentRevision: null,
  purpose: 'task',
  authority: {
    kind: 'local',
    runtime: { registrationId: 'runtime', configurationRevision: 1, protocol: 'opencode' },
  },
  acceptedAt: 1,
  priceBookRevision: 1,
})
test('the original record selects a corrective catalogue but a later record keeps the frozen original catalogue', async () => {
  const reads: number[] = [],
    value = createInvocationValuation(
      { get: async () => accepted },
      {
        priceAt: async (_runtime, _model, _at, revision) => {
          reads.push(revision!)
          return {
            id: 'price-' + revision,
            rates: { input: String(revision), cacheRead: '1', cacheWrite: '1', output: '1' },
          } as ObservationPriceVersion
        },
      },
      {
        get: async (id, record) =>
          record?.recordId === 'old'
            ? {
                invocationId: id,
                operationId: 'confirmed',
                confirmedAt: 3,
                confirmationOrder: '1',
                repriceAt: 2,
                originalAccepted: accepted,
                targetPriceBookRevision: 2,
              }
            : undefined,
      },
    ),
    base = {
      invocationId: accepted.invocationId,
      sourceId: 'source',
      condition: null,
      model: { provider: 'actual', id: 'actual' },
      usage: { input: '1', cacheRead: '3', cacheWrite: '5', output: '7' },
    }
  expect(await value({ ...base, recordId: 'old' })).toMatchObject({
    currency: 'CNY',
    availability: 'priced',
    amountDecimal: '0.000017',
  })
  expect(await value({ ...base, recordId: 'new' })).toMatchObject({ amountDecimal: '0.000016' })
  expect(reads).toEqual([2, 1])
  expect(accepted.priceBookRevision).toBe(1)
})
test('hosted authority cannot consume a local corrective policy or tariff', async () => {
  const platform = AcceptedObservationInvocationSchema.parse({
      ...accepted,
      authority: {
        kind: 'crewstation',
        sourceId: 'original-installation',
        projectId: 'project',
        taskId: 'task',
        subtaskId: 'subtask',
        executionResourceId: 'execution',
        executionGeneration: 1,
      },
      priceBookRevision: null,
    }),
    value = createInvocationValuation(
      { get: async () => platform },
      {
        priceAt: async () => {
          throw new Error('Local pricing must not run')
        },
      },
      {
        get: async () => {
          throw new Error('Local correction must not run')
        },
      },
    )
  expect(
    await value({
      invocationId: 'original',
      sourceId: 'source',
      recordId: 'old',
      condition: null,
      model: { provider: 'actual', id: 'actual' },
      usage: { input: '1', cacheRead: '0', cacheWrite: '0', output: '1' },
    }),
  ).toMatchObject({ availability: 'platform-managed', amountDecimal: null })
})
