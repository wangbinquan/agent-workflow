// RFC-359 W12: SQLite host for the shared source-termination atom. Publish
// and requestStop retain their review-lock timing; no-driver finalization
// remains the existing inline fast path after commit and runtime settlement.
import type { DbClient } from '@/db/client'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import { finalizeCanceledTaskWithoutDriver } from '@/services/task'
import { ConflictError } from '@/util/errors'
import type {
  SourceTerminationEffectCapability,
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationParticipant,
} from '../application/applySourceTerminationEffect'
import { sourceTerminationCapabilityMatches } from '../application/sourceTerminationCapability'
import { executeSourceTermination } from '../application/sourceTerminationExecution'
import { taskExecutionModule } from '../composition'
import { applySourceTerminationTarget } from './sourceTerminationTarget'
import { listSourceTerminationTargets } from './sourceTerminationTargets'

export function createTaskSourceTerminationParticipant(
  db: DbClient,
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
          withTaskReviewMutationLock(taskId, async () => {
            const applied = await applySourceTerminationTarget(
              db,
              taskExecutionModule.runtimeRegistry,
              taskId,
              input,
            )
            if (applied === null) return null
            await publishCommittedEventsAfterCommit(applied.eventRefs)
            return {
              ...applied,
              stopTicket:
                applied.stopToken !== null && applied.stopCause !== null
                  ? taskExecutionModule.runtimeRegistry.requestStop(
                      applied.stopToken,
                      applied.stopCause,
                    )
                  : null,
            }
          }),
        async (applied) =>
          applied.stopTicket === null
            ? null
            : await taskExecutionModule.runtimeRegistry.awaitStopped(applied.stopTicket),
        (taskId) => finalizeCanceledTaskWithoutDriver(db, taskId),
      )
    },
  }
}
