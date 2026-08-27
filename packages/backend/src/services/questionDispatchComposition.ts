// RFC-333 T9 — composition bridge for the collaboration-owned question
// dispatch command and task-execution's exact durable continuation wake.

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { QuestionDispatchCommandPort } from '@/modules/collaboration/application/ports/questionDispatchCommand'
import { createCollaborationCommandContext } from '@/modules/collaboration/composition'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import { dispatchTaskQuestionsWithDecision } from '@/services/taskQuestionDispatch'
import { waitAtHumanGateDecisionCommitBarrier } from '@/services/humanGateDecisionE2eBarrier'
import { createLogger } from '@/util/log'
import type { TaskActorRole } from '@agent-workflow/shared'

const log = createLogger('question-dispatch-composition')

export function createQuestionDispatchCommandContext(input: {
  readonly db: DbClient
  readonly actor: Actor
  readonly role: TaskActorRole
  readonly wake: (taskId: string, continuationRef: string) => Promise<void>
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
        try {
          await input.wake(dispatched.taskId, dispatched.continuationRef)
        } catch (error) {
          log.warn('question dispatch committed; durable continuation wake deferred', {
            taskId: dispatched.taskId,
            operationId: dispatched.receipt.operationId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
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
  return createCollaborationCommandContext({ db: input.db, questionDispatches })
}
