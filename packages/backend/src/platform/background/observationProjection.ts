import type { ProviderNeutralDatabase } from '@/db/query'
import type { OriginalReportDatabaseBinding } from '../persistence/reportSnapshot'
import { originalReportSnapshotSession } from '../persistence/reportSnapshot'
import { originalObservationProjectionRouter } from '../persistence/observationProjectionRouting'
import {
  composeIncrementalObservationProjection,
  composeOriginalProjectionBootstrap,
  incrementalObservationQualification,
  type ProjectionOriginalScope,
} from '@/modules/run-observability/composition/incrementalObservationProjection'
import {
  createCompleteTaskObservationFacts,
  createProjectionTaskObservationFacts,
} from '@/modules/task-execution/composition/taskObservationFacts'
import { createHistoricalTaskObservationFacts } from '@/modules/task-execution/composition/historicalObservationFacts'
import { createHistoricalMemoryObservationFacts } from '@/modules/memory/composition/historicalObservationFacts'
import { createHistoricalIntentObservationFacts } from '@/modules/intent/composition/historicalObservationFacts'
import { createHistoricalMcpObservationFacts } from '@/modules/resource-catalog/composition/historicalObservationFacts'
import { createReportHistoricalNativeUsageQuery } from '@/modules/runtime-management/composition/historicalNativeUsage'
import { createLogger } from '@/util/log'
import { observabilityBroadcaster, OBSERVABILITY_CHANNEL } from '@/ws/broadcaster'

const log = createLogger('observation-projection')
/** Both serving providers compose the same daemon-owned projection and the
 * original owner contracts. Standalone and CrewStation-bound invocations are
 * qualified by the existing original allocation/authority implementation. */
export function composeOriginalObservationProjection(input: {
  readonly db: ProviderNeutralDatabase
  readonly binding: OriginalReportDatabaseBinding
  readonly generation: string
}) {
  const owners = (db: ProviderNeutralDatabase, scope?: ProjectionOriginalScope) => [
    {
      kind: 'task' as const,
      query: createHistoricalTaskObservationFacts(
        db,
        scope
          ? { ownerIds: scope.ownerIds.task, taskIds: scope.taskIds, roots: scope.roots }
          : undefined,
      ),
    },
    {
      kind: 'memory-distill' as const,
      query: createHistoricalMemoryObservationFacts(
        db,
        scope
          ? {
              ownerIds: scope.ownerIds['memory-distill'],
              taskIds: scope.taskIds,
              roots: scope.roots,
            }
          : undefined,
      ),
    },
    {
      kind: 'intent-turn' as const,
      query: createHistoricalIntentObservationFacts(
        db,
        scope ? { ownerIds: scope.ownerIds['intent-turn'], roots: scope.roots } : undefined,
      ),
    },
    {
      kind: 'mcp-runtime-test' as const,
      query: createHistoricalMcpObservationFacts(
        db,
        scope ? { ownerIds: scope.ownerIds['mcp-runtime-test'], roots: scope.roots } : undefined,
      ),
    },
  ]
  return composeIncrementalObservationProjection({
    db: input.db,
    generation: input.generation,
    tasks: createCompleteTaskObservationFacts,
    router: originalObservationProjectionRouter(),
    bootstrap: composeOriginalProjectionBootstrap({
      db: input.db,
      generation: input.generation,
      tasks: createProjectionTaskObservationFacts(input.db),
      owners: owners(input.db),
    }),
    prepare: incrementalObservationQualification({
      db: input.db,
      snapshot: originalReportSnapshotSession(input.binding),
      tasks: createProjectionTaskObservationFacts,
      owners,
      native: () => createReportHistoricalNativeUsageQuery(process.env),
    }),
    failed(error) {
      log.error('incremental observation work remains pending', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
    committed(version) {
      observabilityBroadcaster.broadcast(OBSERVABILITY_CHANNEL, {
        type: 'observability.projection.changed',
        ...version,
      })
    },
  })
}
