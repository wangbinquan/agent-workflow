import type { DigitalEmployeeExecutionParticipant } from '@/modules/task-execution/public/participants'
import type { ReactionExecutionPort } from '../../composition/required-ports'

export function createReactionExecutionAdapter(
  participant: DigitalEmployeeExecutionParticipant,
): ReactionExecutionPort {
  return {
    launch: (plan, attempt) => participant.launch(JSON.stringify(plan), JSON.stringify(attempt)),
    inspect: (executionRef) => participant.inspect(executionRef),
    ...(participant.inspectHumanReview === undefined
      ? {}
      : {
          inspectHumanReview: (executionRef: string) =>
            participant.inspectHumanReview!(executionRef),
        }),
    cancel: (executionRef) => participant.cancel(executionRef),
  }
}
