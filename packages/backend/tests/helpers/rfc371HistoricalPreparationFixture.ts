import { randomUUID } from 'node:crypto'
import type { ObservationOverviewQuery } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { sha256Hex } from '@/util/hash'
import { originalReportSnapshotSession } from '@/platform/persistence/reportSnapshot'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { createHistoricalTaskObservationFacts } from '@/modules/task-execution/composition/historicalObservationFacts'
import { createCompleteObservationSources } from '@/modules/run-observability/infrastructure/completeObservationSources'
import { completeObservationValuation } from '@/modules/run-observability/infrastructure/completeObservationValuation'
import { completeUsageWorkspace } from '@/modules/run-observability/infrastructure/completeUsageWorkspace'
import { historicalObservationPreparationCollector } from '@/modules/run-observability/infrastructure/historicalObservationPreparationCollector'
import { completeCalculationSourceProof } from '@/modules/run-observability/infrastructure/completeCalculationSourceProof'
import { completeCalculationFactFileSpool } from '@/modules/run-observability/infrastructure/completeCalculationFactSpool'
import { stageHistoricalObservationSources } from '@/modules/run-observability/application/historicalObservationSource'
import { completeWorkingTraversal } from '@/modules/run-observability/application/completeWorkingTraversal'
import type { HistoricalWorkingExecution } from '@/modules/run-observability/ports/historicalObservationWorking'
import type { ProviderHarness } from './eachProvider'
import type { persistentNativeFixture } from './rfc371PersistentNativeFactFixture'

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

/** Real owner pages and native WAL are retained through the production preparation and spool. */
export async function collectHistoricalPreparation(
  harness: ProviderHarness,
  input: {
    readonly native: ReturnType<typeof persistentNativeFixture>
    readonly query: ObservationOverviewQuery
    readonly cache?: boolean
    readonly forbidOriginalRead?: boolean
    readonly allowNativeRetry?: true
    readonly actorScope?: string
  },
) {
  const binding = harness.applicationBinding
  return originalReportSnapshotSession(
    binding.provider === 'sqlite'
      ? { ...binding, generationId: 'historical-preparation-original-generation' }
      : { provider: 'postgresql', runtime: binding.runtime },
  ).run(async (snapshot) => {
    const namespace = 'historical-preparation/' + randomUUID()
    const tasks = createCompleteTaskObservationFacts(snapshot.executor)
    const owners = createHistoricalTaskObservationFacts(snapshot.executor)
    const sources = createCompleteObservationSources({
      db: snapshot.executor,
      tasks,
      snapshotId: snapshot.snapshotId,
      pageSize: 61,
    })
    let cursor: string | null = null
    const originalTasks = sources.tasks(actor, input.query)
    for (;;) {
      const page = await originalTasks.next(cursor)
      await snapshot.workspace.insert(
        namespace + '/original-tasks',
        page.items.map((document) => ({ key: document.id, document })),
      )
      if (page.nextCursor === null) break
      if (page.nextCursor === cursor) throw new Error('Original fixture Task EOF did not advance')
      cursor = page.nextCursor
    }
    const source = await completeCalculationSourceProof(snapshot.executor, snapshot.generationId)
    const proof = await input.native.observer.sample()
    if (!source || !proof) throw new Error('Actual complete source proof missing')
    const context = {
      source,
      native: proof,
      actorScope: input.actorScope ?? 'historical-preparation-reader',
    }
    const collector = historicalObservationPreparationCollector({
      db: snapshot.executor,
      rows: snapshot.workspace,
      namespace,
      snapshotId: snapshot.snapshotId,
      context,
    })
    const value = completeObservationValuation({
      db: snapshot.executor,
      rows: snapshot.workspace,
      namespace: namespace + '/value',
    })
    const reads = { owners: 0, events: 0, parents: 0, native: 0 }
    const nativeRoots: string[] = []
    const original = (kind: keyof typeof reads) => {
      reads[kind]++
      if (input.forbidOriginalRead && !(kind === 'native' && input.allowNativeRetry))
        throw new Error('Hot history must reuse sealed original preparation')
    }
    const stage = await stageHistoricalObservationSources({
      actor,
      query: input.query,
      asOf: snapshot.asOf,
      namespace,
      rows: snapshot.workspace,
      keyOf: sha256Hex,
      usageWorkspace: completeUsageWorkspace,
      value: value.value,
      sources: {
        ...sources,
        historical: {
          owners: [
            {
              kind: 'task',
              query: {
                ...owners,
                async owners(page) {
                  original('owners')
                  return owners.owners(page)
                },
                async events(id, page) {
                  original('events')
                  return owners.events(id, page)
                },
              },
            },
          ],
          async task(id) {
            original('parents')
            return tasks.get(actor, id)
          },
          native: {
            generation: input.native.query.generation,
            async open(selection) {
              original('native')
              nativeRoots.push(selection.rootSessionId)
              return input.native.query.open(selection)
            },
          },
        },
      },
      ...(input.cache ? { historicalPreparation: collector.cache } : {}),
    })
    if (!stage) throw new Error('Actual historical fixture stage missing')
    const executions = []
    for await (const row of completeWorkingTraversal<HistoricalWorkingExecution>(
      snapshot.workspace,
      stage.executionsNamespace,
    ))
      executions.push(row)
    const records = []
    const candidates = []
    for await (const row of completeWorkingTraversal(
      snapshot.workspace,
      stage.nativeRecordsNamespace,
    )) {
      records.push(row)
      const refs = []
      for await (const ref of completeWorkingTraversal(
        snapshot.workspace,
        stage.namespace + '/record-candidates/' + row.key,
      ))
        refs.push(ref)
      candidates.push({ key: row.key, refs })
    }
    const receipts = []
    for await (const row of completeWorkingTraversal(snapshot.workspace, stage.receiptsNamespace))
      receipts.push(row)
    const manifest = input.cache
      ? await completeCalculationFactFileSpool(input.native.home).seal({
          reportId: randomUUID(),
          owner: 'historical-preparation-fixture',
          context,
          items: collector.items(),
        })
      : undefined
    await value.flush()
    return {
      executions,
      records,
      candidates,
      receipts,
      manifest,
      reads,
      nativeRoots,
      usedCache: collector.usedCache,
      statistics: collector.statistics,
    }
  })
}
