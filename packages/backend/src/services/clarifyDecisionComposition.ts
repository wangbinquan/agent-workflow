// RFC-333 T9 — collaboration command composition for quick clarify answers.

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ClarifyDecisionCommandPort } from '@/modules/collaboration/application/ports/clarifyDecisionCommand'
import { createCollaborationCommandContext } from '@/modules/collaboration/composition'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import { autoDispatchClarifyRoundWithDecision } from '@/services/clarify/autoDispatch'
import { waitAtHumanGateDecisionCommitBarrier } from '@/services/humanGateDecisionE2eBarrier'
import { createLogger } from '@/util/log'
import type { TaskActorRole } from '@agent-workflow/shared'

const log = createLogger('clarify-decision-composition')

export function createClarifyDecisionCommandContext(input: {
  readonly db: DbClient
  readonly actor: Actor
  readonly role: TaskActorRole
  readonly wake: (taskId: string, continuationRef: string) => Promise<void>
}): CollaborationCommandContext {
  const clarifyDecisions: ClarifyDecisionCommandPort = {
    async submit(command) {
      const decided = await autoDispatchClarifyRoundWithDecision({
        db: input.db,
        originNodeRunId: command.nodeRunId,
        answers: [...command.answers],
        directive: command.directive,
        actor: { userId: input.actor.user.id, role: input.role },
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
      await waitAtHumanGateDecisionCommitBarrier({
        kind: 'clarify',
        taskId: decided.taskId,
        operationId: decided.receipt.operationId,
      })
      try {
        await input.wake(decided.taskId, decided.continuationRef)
      } catch (error) {
        log.warn('clarify decision committed; durable continuation wake deferred', {
          taskId: decided.taskId,
          operationId: decided.receipt.operationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
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
  return createCollaborationCommandContext({ db: input.db, clarifyDecisions })
}
