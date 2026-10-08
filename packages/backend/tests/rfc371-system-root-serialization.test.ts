// RFC-371: root/reset callbacks already share the original System invocation
// aggregate lock. Parallel parser delivery must retain one accepted transition
// and reject the stale outgoing-root transition on both original providers.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { systemAgentNativeUsage } from '@/db/observationSystem'
import { composeSystemAgentObservations } from '@/modules/task-execution/composition/systemAgentObservations'
import { createNativeUsageInvocationPersistence } from '@/modules/task-execution/composition/nativeUsageInvocation'
import { composeObservationUsageSource } from '@/modules/task-execution/composition/observationUsageSource'
import { composeLocalInvocationObservations } from '@/modules/run-observability/composition/localInvocations'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-371 original System root transition serialization', (harness) => {
  test('two resets with the same outgoing root cannot lose or duplicate an accepted transition', async () => {
    const db = harness.db
    const observations = composeLocalInvocationObservations(db, composeObservationUsageSource(db))
    const factory = composeSystemAgentObservations({
      db,
      observations,
      nativeUsage: createNativeUsageInvocationPersistence(db, { rootSets: true }),
    })
    const run = await factory.open({
      feature: 'memory-distiller',
      agentName: 'aw-memory-distiller',
      protocol: 'opencode',
      startedAt: Date.now(),
      demand: {
        kind: 'memory-distill',
        originalId: 'original-serialized-job',
        originalAttempt: '1:0',
        name: 'Original memory root',
        purpose: 'memory',
      },
    })
    await run.accept({
      nativeCaptureContract: 'opencode-child-root-pages-v3',
      nativeCaptureSource: 'original-system-reset-stream',
    })
    await run.root('original-root')
    const resets = await Promise.allSettled([
      run.root('original-reset-a', 'original-root'),
      run.root('original-reset-b', 'original-root'),
    ])
    expect(resets.filter((row) => row.status === 'fulfilled')).toHaveLength(1)
    const rejected = resets.filter((row): row is PromiseRejectedResult => row.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]!.reason)).toContain('actual outgoing root')
    const head = await db
      .select()
      .from(systemAgentNativeUsage.nativeUsageRootHeads)
      .where(eq(systemAgentNativeUsage.nativeUsageRootHeads.invocationId, run.invocationId))
      .get()
    expect(head?.nextOrdinal).toBe('2')
    expect<Array<string | undefined>>(['original-reset-a', 'original-reset-b']).toContain(
      head?.lastRootSessionId,
    )
    const transitions = await db
      .select()
      .from(systemAgentNativeUsage.nativeUsageRootTransitions)
      .where(eq(systemAgentNativeUsage.nativeUsageRootTransitions.invocationId, run.invocationId))
      .orderBy(systemAgentNativeUsage.nativeUsageRootTransitions.ordinalKey)
    expect(transitions.map((row) => JSON.parse(row.document).ordinal)).toEqual(['0', '1'])
    expect(transitions[0]!.rootSessionId).toBe('original-root')
    expect(transitions[1]!.rootSessionId).toBe(head!.lastRootSessionId)
  }, 30000)
})
