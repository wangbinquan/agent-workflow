// RFC-333 T9 — composition bridge for the collaboration-owned question
// dispatch command and task-execution's exact durable continuation wake.

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type {
  CollaborationCommandContext,
  QuestionDispatchCommandPort,
} from '@/modules/collaboration/public/types'
import { humanGateComposition } from '@/services/humanGateComposition'
import { dispatchTaskQuestionsWithDecision } from '@/services/taskQuestionDispatch'
import { waitAtHumanGateDecisionCommitBarrier } from '@/services/humanGateDecisionE2eBarrier'
import type { TaskActorRole } from '@agent-workflow/shared'

export function createQuestionDispatchCommandContext(input: {
  readonly db: DbClient
  readonly actor: Actor
  readonly role: TaskActorRole
}): CollaborationCommandContext {
  const questionDispatches: QuestionDispatchCommandPort = {
    async dispatch(command) {
      const dispatched = await dispatchTaskQuestionsWithDecision(
        input.db,
        command.taskId,
        [...command.entryIds],
        { userId: input.actor.user.id, role: input.role },
        {
          ...(command.expectedTaskRevision === undefined
            ? {}
            : { expectedTaskRevision: command.expectedTaskRevision }),
          ...(command.expectedGateRevision === undefined
            ? {}
            : { expectedGateRevision: command.expectedGateRevision }),
          ...(command.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: command.idempotencyKey }),
        },
      )
      if (dispatched.continuationRef !== null) {
        await waitAtHumanGateDecisionCommitBarrier({
          kind: 'questions',
          taskId: dispatched.taskId,
          operationId: dispatched.receipt.operationId,
        })
      }
      return {
        taskId: dispatched.taskId,
        receipt: dispatched.receipt,
        reruns: dispatched.reruns,
        dispatchedEntryIds: dispatched.dispatchedEntryIds,
        deferred: dispatched.deferred,
      }
    },
  }
  return humanGateComposition.createCollaborationCommandContext({
    db: input.db,
    questionDispatches,
  })
}
