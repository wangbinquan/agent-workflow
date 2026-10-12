import { randomUUID } from 'node:crypto'
import { sha256Hex } from '@/util/hash'
import { buildActor } from '@/auth/actor'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { buildCompleteObservationTask } from '@/modules/run-observability/application/completeObservationTask'
import { createCompleteObservationSources } from '@/modules/run-observability/infrastructure/completeObservationSources'
import { completeObservationValuation } from '@/modules/run-observability/infrastructure/completeObservationValuation'
import { completeUsageWorkspace } from '@/modules/run-observability/infrastructure/completeUsageWorkspace'
import { completeWorkingTraversal } from '@/modules/run-observability/application/completeWorkingTraversal'
import { calculationNamespaceFields } from '@/modules/run-observability/domain/completeCalculationFacts'
import {
  completeCalculationSourceProof,
  completeTaskCalculationCollector,
  completeCalculationFactFileSpool,
  importCompleteTaskCalculations,
} from '@/modules/run-observability/composition/completeCalculations'
import type { HistoricalNativeSourceProof } from '@/modules/runtime-management/public/participants'
import type { CompleteCalculationFactManifest } from '@/modules/run-observability/ports/completeCalculationFacts'
import type { ProviderHarness } from './eachProvider'
import { COMPLETE_NOW } from './rfc371CompleteTaskFixture'

const actor = buildActor({
  source: 'session',
  user: {
    id: 'complete-task-reader',
    username: 'complete-task-reader',
    displayName: 'Complete reader',
    role: 'admin',
    status: 'active',
  },
})

export async function collectTaskCalculation(
  harness: ProviderHarness,
  input: {
    readonly home: string
    readonly proof: HistoricalNativeSourceProof
    readonly cache: boolean
    readonly forbidNumericRead?: boolean
    readonly asOf?: number
    readonly actorScope?: string
    readonly trace?: boolean
  },
) {
  const binding = harness.applicationBinding
  const session = originalReportSnapshotSession(
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'task-calculation-original-generation' }
      : { provider: 'postgresql', runtime: binding.runtime },
  )
  return session.run(async (snapshot) => {
    const owner = createTaskObservationFacts(snapshot.executor)
    const task = await owner.get(actor, 'complete-original-task')
    if (!task) throw new Error('Original Task missing')
    const namespace = 'task-calculation/' + randomUUID()
    const originalSources = createCompleteObservationSources({
      db: snapshot.executor,
      tasks: owner,
      snapshotId: snapshot.snapshotId,
      pageSize: 61,
    })
    const fail = () => {
      throw new Error('Hot numerical preparation must use the actual sealed cache')
    }
    const source = await completeCalculationSourceProof(snapshot.executor, snapshot.generationId)
    const context = source
      ? { source, native: input.proof, actorScope: input.actorScope ?? 'original-task-reader' }
      : null
    const collector =
      input.cache && context
        ? completeTaskCalculationCollector({
            db: snapshot.executor,
            rows: snapshot.workspace,
            namespace,
            snapshotId: snapshot.snapshotId,
            context,
          })
        : undefined
    const value = completeObservationValuation({
      db: snapshot.executor,
      rows: snapshot.workspace,
      namespace: namespace + '/value',
    })
    const result = await buildCompleteObservationTask({
      task,
      sources: input.forbidNumericRead
        ? {
            ...originalSources,
            attempts: fail,
            invocations: fail,
            captures: fail,
            usage: fail,
            backlog: fail,
          }
        : originalSources,
      asOf: input.asOf ?? COMPLETE_NOW + 60_000,
      rows: snapshot.workspace,
      namespace: namespace + '/task',
      keyOf: sha256Hex,
      usageWorkspace: completeUsageWorkspace,
      value: input.forbidNumericRead ? fail : value.value,
      ...(input.trace ? { trace: true } : {}),
      ...(collector ? { numericCache: collector.cache } : {}),
    })
    await value.flush()
    const groups: Record<string, unknown[]> = {}
    for (const field of calculationNamespaceFields) {
      const name = result[field]
      if (name === undefined) continue
      const rows: unknown[] = []
      for await (const row of completeWorkingTraversal(snapshot.workspace, name)) rows.push(row)
      groups[field] = rows
    }
    const manifest = collector
      ? await completeCalculationFactFileSpool(input.home).seal({
          reportId: randomUUID(),
          owner: 'original-task-calculation-owner',
          context: context!,
          items: collector.items(),
        })
      : undefined
    return {
      result,
      groups,
      manifest,
      statistics: collector?.statistics,
      snapshotId: snapshot.snapshotId,
    }
  })
}

export async function publishTaskCalculation(
  harness: ProviderHarness,
  home: string,
  manifest: CompleteCalculationFactManifest | undefined,
) {
  if (!manifest) throw new Error('Actual Task calculation manifest missing')
  await importCompleteTaskCalculations({
    db: harness.db,
    spool: completeCalculationFactFileSpool(home),
    manifest,
  })
}
