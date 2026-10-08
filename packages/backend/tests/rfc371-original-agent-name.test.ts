import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { agents } from '@/db/schema'
import { systemAgentObservationOwners } from '@/db/observationSystem'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { composeSystemAgentObservations } from '@/modules/task-execution/composition/systemAgentObservations'
import { composeObservationUsageSource } from '@/modules/task-execution/composition/observationUsageSource'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { composeLocalInvocationObservations } from '@/modules/run-observability/composition/localInvocations'
import { completeObservationAgentNames } from '@/modules/run-observability/infrastructure/completeObservationAgentNames'
import { buildOrchestratorAgent } from '@/services/orchestratorAgent'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { COMPLETE_NOW, seedCompleteTask } from './helpers/rfc371CompleteTaskFixture'

function originalNames(harness: ProviderHarness) {
  const binding = harness.applicationBinding
  const source =
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'original-agent-name-reader' }
      : { provider: 'postgresql' as const, runtime: binding.runtime }
  return originalReportSnapshotSession(source)
}

function originalSystem(harness: ProviderHarness) {
  return composeSystemAgentObservations({
    db: harness.db,
    observations: composeLocalInvocationObservations(
      harness.db,
      composeObservationUsageSource(harness.db),
    ),
  })
}

const request = (attempt: string) => ({
  feature: 'memory-distiller' as const,
  agentName: 'aw-memory-distiller',
  protocol: 'opencode' as const,
  startedAt: COMPLETE_NOW,
  demand: {
    kind: 'memory-distill',
    originalId: 'original-name-job',
    originalAttempt: attempt,
    name: 'Original memory extraction',
    parentTaskId: 'complete-original-task',
    purpose: 'memory' as const,
  },
})

describeEachProvider('RFC-371 names from the original Agent owner', (harness) => {
  test('the same report snapshot names ordinary, System and framework Agents without guessing unknown identities', async () => {
    await seedCompleteTask(harness, 1, 1)
    await harness.db.insert(agents).values({ id: 'original-agent', name: 'Original catalog Agent' })
    const run = await originalSystem(harness).open(request('1:0'))
    const framework = buildOrchestratorAgent()
    await originalNames(harness).run(async (snapshot) => {
      const tasks = createCompleteTaskObservationFacts(snapshot.executor)
      const names = completeObservationAgentNames({
        db: snapshot.executor,
        rows: snapshot.workspace,
        namespace: 'original-agent-names',
        originalAgentName: tasks.originalAgentName,
      })
      expect(run.agentId).toBe('system-agent:aw-memory-distiller')
      expect(await names.name(run.agentId)).toBe('aw-memory-distiller')
      expect(await names.name(framework.id)).toBe(framework.name)
      expect(await names.name('original-agent')).toBe('Original catalog Agent')
      expect(await names.name('system-agent:no-original-owner')).toBeNull()
      expect(await names.name('aw-memory-distiller')).toBeNull()
      expect(await names.name(null)).toBeNull()
      await names.flush()
    })
  })

  test('conflicting or blank original names remain unknown and never become a guessed label', async () => {
    await seedCompleteTask(harness, 1, 1)
    const factory = originalSystem(harness)
    const first = await factory.open(request('1:0'))
    const second = await factory.open(request('2:1'))
    await harness.db
      .update(systemAgentObservationOwners)
      .set({ agentName: 'Conflicting original name' })
      .where(eq(systemAgentObservationOwners.id, second.invocationId))
    await originalNames(harness).run(async (snapshot) => {
      expect(
        await createCompleteTaskObservationFacts(snapshot.executor).originalAgentName(
          first.agentId!,
        ),
      ).toBeNull()
    })
    for (const id of [first.invocationId, second.invocationId])
      await harness.db
        .update(systemAgentObservationOwners)
        .set({ agentName: '   ' })
        .where(eq(systemAgentObservationOwners.id, id))
    await originalNames(harness).run(async (snapshot) => {
      expect(
        await createCompleteTaskObservationFacts(snapshot.executor).originalAgentName(
          first.agentId!,
        ),
      ).toBeNull()
    })
  })
})
