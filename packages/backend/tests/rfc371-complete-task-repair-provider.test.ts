// RFC-371: resolved immutable history and canonical coverage retain the original owner semantics.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { nodeRuns, observationUsageCaptures, tasks } from '@/db/schema'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { composeObservationUsageSource } from '@/modules/task-execution/composition/observationUsageSource'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createUsageSourceProjection } from '@/modules/run-observability/application/usageSourceProjection'
import type { ObservationCapturedUsage, ObservationNativeCapture } from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'
import {
  buildOriginalCompleteTask,
  COMPLETE_NOW,
  completeFixtureId,
  completeTaskRecord,
  seedCompleteTask,
} from './helpers/rfc371CompleteTaskFixture'
import { seedCompleteCoveredUsage } from './helpers/rfc371CompleteCoverageFixture'

describeEachProvider('RFC-371 complete statistics original repair and coverage', (harness) => {
  test('an actual original source repair charges only A, proves resumed B is zero and leaves immutable partial proof intact', async () => {
    await seedCompleteTask(harness, 2, 0)
    await harness.db.delete(observationUsageCaptures).run()
    await harness.db
      .update(tasks)
      .set({ status: 'running', finishedAt: null, runningSince: COMPLETE_NOW, runningMs: 0 })
      .where(eq(tasks.id, 'complete-original-task'))
      .run()
    await harness.db.update(nodeRuns).set({ status: 'running', finishedAt: null }).run()
    const writer = new DrizzleNodeExecutionPersistence(harness.db),
      store = createUsageLedgerStore(harness.db)
    const project = createUsageSourceProjection({
      source: composeObservationUsageSource(harness.db),
      store,
      invocations: createObservationInvocationStore(harness.db),
    })
    const initial = completeTaskRecord(0, 2).measurement
    const measurement = {
      ...initial,
      recordId: 'opencode:step:old',
      model: { provider: 'native', id: 'actual' },
      usage: { ...initial.usage, input: '100' },
      scope: {
        root: 'repair-root',
        session: 'repair-child',
        parentSession: 'repair-root',
        ancestors: ['repair-root'],
        turn: 'first-turn',
        turnIndex: 0,
        level: 'request' as const,
      },
    }
    const proof: ObservationNativeCapture = {
      contract: 'opencode-child-steps-v1',
      nativeSource: 'complete-native',
      rootSessionId: 'repair-root',
      state: 'complete',
      baseline: { kind: 'fresh', fingerprint: null },
      snapshotFingerprint: 'original-fresh-final',
      observedAt: COMPLETE_NOW + 2,
      scannedSessions: 2,
      scannedSteps: 1,
      issues: [],
      priorRevisions: [],
      baselineSteps: [],
    }
    await writer.appendEvents({
      nodeRunId: completeFixtureId('run', 0),
      events: [],
      observations: [
        { invocationId: measurement.invocationId, measurements: [measurement], diagnostics: [] },
        {
          invocationId: measurement.invocationId,
          measurements: [],
          diagnostics: [],
          capture: proof,
        },
      ],
    })
    await project(completeFixtureId('run', 0))
    const before = { usage: measurement.usage, model: measurement.model },
      after = { ...before, usage: { ...before.usage, input: '200' } }
    const resumed: ObservationCapturedUsage = {
      invocationId: completeFixtureId('invocation', 1),
      measurements: [],
      diagnostics: [],
      capture: {
        ...proof,
        state: 'partial',
        baseline: { kind: 'resume', fingerprint: 'original-before' },
        snapshotFingerprint: 'original-resumed-final',
        observedAt: COMPLETE_NOW + 4,
        issues: ['native-prior-revision-gap'],
        priorRevisions: [{ sessionId: 'repair-child', stepId: 'old', before, after }],
        baselineSteps: [
          {
            stepId: 'old',
            sessionId: 'repair-child',
            parentSessionId: 'repair-root',
            ancestors: ['repair-root'],
            before,
            after,
            afterObserved: true,
            scopeChanged: false,
          },
        ],
      },
    }
    await writer.appendEvents({
      nodeRunId: completeFixtureId('run', 1),
      events: [],
      observations: [resumed],
    })
    expect((await buildOriginalCompleteTask(harness, 20)).summary.metrics.state).toBe('not-ready')
    await project(completeFixtureId('run', 1))
    const capture = (await store.captures([resumed.invocationId]))[0]!
    expect(capture.priorRevisionGap).toBe(false)
    expect(capture.capture.state).toBe('partial')
    if (capture.capture.contract !== 'opencode-child-steps-v1')
      throw new Error('Original legacy repair changed contract')
    expect(capture.capture.priorRevisions).toEqual(resumed.capture!.priorRevisions)
    expect(capture.resolutions).toMatchObject([
      {
        stepId: 'old',
        status: 'resolved',
        invocationId: measurement.invocationId,
        reason: 'revised',
      },
    ])
    const original = await store.records('complete-original-task', { limit: 10 })
    expect(original.items).toHaveLength(1)
    expect(original.items[0]).toMatchObject({
      measurement: { invocationId: measurement.invocationId, revision: 2 },
      contribution: after.usage,
      complete: true,
    })
    const result = await buildOriginalCompleteTask(harness, 20)
    expect(result.summary.metrics).toEqual({
      state: 'ready',
      invocations: '2',
      observedInvocations: '2',
      records: '1',
      tokens: { input: '200', cacheRead: '3', cacheWrite: '5', output: '7', total: '215' },
      cost: { currency: 'CNY', state: 'complete', amount: '0.000249' },
    })
    expect(result.attempts[1]?.metrics).toEqual({
      state: 'ready',
      invocations: '1',
      observedInvocations: '1',
      records: '0',
      tokens: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0', total: '0' },
      cost: { currency: 'CNY', state: 'complete', amount: '0' },
    })
  })
  for (const authority of ['local', 'platform'] as const) {
    test(
      authority + ' complete parent excludes an incomplete covered child without a false gap',
      async () => {
        await seedCompleteCoveredUsage(harness, authority, false)
        const result = await buildOriginalCompleteTask(harness, 20)
        expect(result.summary.metrics).toEqual({
          state: 'ready',
          invocations: '1',
          observedInvocations: '1',
          records: '1',
          tokens: {
            input: '100',
            cacheRead: '300',
            cacheWrite: '500',
            output: '700',
            total: '1600',
          },
          cost: { currency: 'CNY', state: 'complete', amount: '0.005' },
        })
        expect(result.allocations).toHaveLength(1)
        expect(result.allocations[0]?.recordId).toBe(completeFixtureId('meter', 0))
      },
    )
    test(authority + ' partial parent coverage preserves a real non-ready state', async () => {
      await seedCompleteCoveredUsage(harness, authority, true)
      const result = await buildOriginalCompleteTask(harness, 20)
      expect(result.summary.metrics.state).toBe('not-ready')
      if (result.summary.metrics.state === 'not-ready')
        expect(result.summary.metrics.gaps).toContain('coverage-incomplete')
      expect(result.summary.metrics).not.toHaveProperty('tokens')
      expect(result.summary.metrics).not.toHaveProperty('cost')
    })
  }
})
