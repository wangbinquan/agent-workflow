// RFC-349 — SQLite implementation of the collaboration question-dispatch
// command. Actor identity travels in the closed request, not a per-request DB
// composition closure.

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type {
  CollaborationCommandContext,
  QuestionDispatchCommandPort,
} from '@/modules/collaboration/public/types'
import { humanGateComposition } from '@/services/humanGateComposition'
import { dispatchTaskQuestionsWithDecision } from '@/services/taskQuestionDispatch'
import type { TaskActorRole } from '@agent-workflow/shared'

export function createSqliteQuestionDispatchCommand(db: DbClient): QuestionDispatchCommandPort {
  return {
    async dispatch(command) {
      const dispatched = await dispatchTaskQuestionsWithDecision(
        db,
        command.taskId,
        [...command.entryIds],
        { userId: command.actor.user.id, role: command.actorRole },
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
      return {
        taskId: dispatched.taskId,
        receipt: dispatched.receipt,
        reruns: dispatched.reruns,
        dispatchedEntryIds: dispatched.dispatchedEntryIds,
        deferred: dispatched.deferred,
      }
    },
  }
}

/** Legacy test bridge; production routes use the bootstrap-owned context. */
export function createQuestionDispatchCommandContext(input: {
  readonly db: DbClient
  readonly actor: Actor
  readonly role: TaskActorRole
}): CollaborationCommandContext {
  return humanGateComposition.createCollaborationCommandContext({
    db: input.db,
    questionDispatches: createSqliteQuestionDispatchCommand(input.db),
  })
}
