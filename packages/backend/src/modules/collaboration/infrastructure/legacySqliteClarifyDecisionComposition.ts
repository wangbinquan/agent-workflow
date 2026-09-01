// RFC-349 — SQLite implementation of collaboration's quick-clarify command.
// The request carries its actor snapshot; bootstrap owns the provider-bound
// command once instead of rebuilding a DB-shaped context per request.

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type {
  ClarifyDecisionCommandPort,
  CollaborationCommandContext,
} from '@/modules/collaboration/public/types'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import { humanGateComposition } from '@/services/humanGateComposition'
import { autoDispatchClarifyRoundWithDecision } from '@/services/clarify/autoDispatch'
import type { TaskActorRole } from '@agent-workflow/shared'

export function createSqliteClarifyDecisionCommand(
  db: DbClient,
  memoryDistillEnqueuer: MemoryDistillEnqueuer,
): ClarifyDecisionCommandPort {
  return {
    async submit(command) {
      const decided = await autoDispatchClarifyRoundWithDecision({
        db,
        originNodeRunId: command.nodeRunId,
        answers: [...command.answers],
        directive: command.directive,
        actor: { userId: command.actor.user.id, role: command.actorRole },
        memoryDistillEnqueuer,
        ...(command.ifMatchIteration === undefined
          ? {}
          : { ifMatchIteration: command.ifMatchIteration }),
        decision: {
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
      })
      return {
        taskId: decided.taskId,
        roundKind: decided.kind,
        sealedQuestionIds: decided.sealedQuestionIds,
        roundFullySealed: decided.roundFullySealed,
        receipt: decided.receipt,
        reruns: decided.dispatch.reruns,
        dispatchedEntryIds: decided.dispatch.dispatchedEntryIds,
        deferred: decided.dispatch.deferred,
        ...(decided.dispatchDeferredReason === undefined
          ? {}
          : { dispatchDeferredReason: decided.dispatchDeferredReason }),
      }
    },
  }
}

/** Legacy test bridge; production routes use the bootstrap-owned context. */
export function createClarifyDecisionCommandContext(input: {
  readonly db: DbClient
  readonly actor: Actor
  readonly role: TaskActorRole
  readonly memoryDistillEnqueuer: MemoryDistillEnqueuer
}): CollaborationCommandContext {
  return humanGateComposition.createCollaborationCommandContext({
    db: input.db,
    clarifyDecisions: createSqliteClarifyDecisionCommand(input.db, input.memoryDistillEnqueuer),
  })
}
