// RFC-387: room admission is durable; an immediate drive is only a best-effort wake.
import type { TaskExecutionTopologyLogger } from '../ports/taskExecutionTopology'

export function createRoomContinuation(input: {
  readonly assertResumable: (taskId: string, verb: string) => Promise<void>
  readonly gateContinuation: (
    continuation: Readonly<{ taskId: string; continuationRef: string }>,
  ) => Promise<void>
  readonly log: TaskExecutionTopologyLogger
}) {
  return Object.freeze({
    assertResumable: input.assertResumable,
    async driveAfterCommit(
      continuation: Readonly<{ taskId: string; intentId: string }>,
    ): Promise<void> {
      try {
        await input.gateContinuation({
          taskId: continuation.taskId,
          continuationRef: continuation.intentId,
        })
      } catch (error) {
        input.log.warn('room continuation wake failed; worker will retry', {
          taskId: continuation.taskId,
          intentId: continuation.intentId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })
}
