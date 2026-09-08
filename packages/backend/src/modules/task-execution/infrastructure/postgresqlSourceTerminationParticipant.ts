// RFC-359 W12: PostgreSQL host for the shared source-termination atom.
// Publication, requestStop and awaitStopped stay outside the review lock;
// workspace finalization remains with the durable lifecycle consumer.
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { ConflictError } from '@/util/errors'
import type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationParticipant,
} from '../application/applySourceTerminationEffect'
import { sourceTerminationCapabilityMatches } from '../application/sourceTerminationCapability'
import { executeSourceTermination } from '../application/sourceTerminationExecution'
import { taskExecutionModule } from '../composition'
import type { InMemoryTaskRuntimeRegistry } from './inMemoryTaskRuntimeRegistry'
import { applySourceTerminationTarget } from './sourceTerminationTarget'
import { listSourceTerminationTargets } from './sourceTerminationTargets'

export function createPostgresqlTaskSourceTerminationParticipant(
  db: PostgresqlDatabaseClient,
  runtimeRegistry: InMemoryTaskRuntimeRegistry = taskExecutionModule.runtimeRegistry,
): TaskSourceTerminationParticipant {
  return {
    async apply(
      capability: SourceTerminationEffectCapability,
      input: TaskSourceTerminationEffectInput,
    ) {
      if (!sourceTerminationCapabilityMatches(capability, input)) {
        throw new ConflictError(
          'source-termination-capability-invalid',
          'source termination capability does not match the claimed durable effect',
        )
      }
      return await executeSourceTermination(
        input,
        () => listSourceTerminationTargets(db, input),
        (taskId) =>
          withTaskReviewMutationLock(taskId, () =>
            applySourceTerminationTarget(db, runtimeRegistry, taskId, input),
          ),
        async (applied) => {
          await publishCommittedEventsAfterCommit(applied.eventRefs)
          return applied.stopToken !== null && applied.stopCause !== null
            ? await runtimeRegistry.awaitStopped(
                runtimeRegistry.requestStop(applied.stopToken, applied.stopCause),
              )
            : null
        },
      )
    },
  }
}
