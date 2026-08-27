// RFC-333 T8 — temporary bootstrap bridge from collaboration's public command
// to the legacy review domain writer and task-execution wake port.

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { TaskActorRole } from '@agent-workflow/shared'
import { createCollaborationCommandContext } from '@/modules/collaboration/composition'
import type { CollaborationCommandContext } from '@/modules/collaboration/public/types'
import type { ReviewDecisionCommandPort } from '@/modules/collaboration/application/ports/reviewDecisionCommand'
import { submitReviewDecision as submitLegacyReviewDecision } from '@/services/review'
import { waitAtHumanGateDecisionCommitBarrier } from '@/services/humanGateDecisionE2eBarrier'
import { createLogger } from '@/util/log'

const log = createLogger('review-decision-composition')

export function createReviewDecisionCommandContext(input: {
  readonly db: DbClient
  readonly appHome: string
  readonly actor: Actor
  readonly authorRole: TaskActorRole
  readonly wake: (taskId: string, continuationRef: string) => Promise<void>
}): CollaborationCommandContext {
  const reviewDecisions: ReviewDecisionCommandPort = {
    async submit(command) {
      const decided = await submitLegacyReviewDecision({
        db: input.db,
        appHome: input.appHome,
        nodeRunId: command.nodeRunId,
        decision: command.decision,
        expectedReviewIteration: command.expectedReviewIteration,
        author: input.actor.user.id,
        authorRole: input.authorRole,
        actor: input.actor,
        ...(command.rejectReason === undefined ? {} : { rejectReason: command.rejectReason }),
        ...(command.expectedTaskRevision === undefined
          ? {}
          : { expectedTaskRevision: command.expectedTaskRevision }),
        ...(command.expectedGateRevision === undefined
          ? {}
          : { expectedGateRevision: command.expectedGateRevision }),
        ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
        ...(command.comments === undefined ? {} : { comments: command.comments }),
        ...(command.selections === undefined ? {} : { selections: command.selections }),
      })
      // The decision and exact continuation ref are already durable. A wake
      // failure is logged and recovered from the same pending intent; it never
      // downgrades a successfully committed business response.
      await waitAtHumanGateDecisionCommitBarrier({
        kind: 'review',
        taskId: decided.taskId,
        operationId: decided.receipt.operationId,
      })
      try {
        await input.wake(decided.taskId, decided.continuationRef)
      } catch (error) {
        log.warn('review decision committed; durable continuation wake deferred', {
          taskId: decided.taskId,
          operationId: decided.receipt.operationId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return {
        taskId: decided.taskId,
        reviewIteration: decided.reviewIteration,
        receipt: decided.receipt,
        commentsAdded: decided.batch?.commentsAdded ?? 0,
        commentsSkippedAsDuplicate: decided.batch?.commentsSkippedAsDuplicate ?? 0,
        selectionsApplied: decided.batch?.selectionsApplied ?? 0,
      }
    },
  }
  return createCollaborationCommandContext({
    db: input.db,
    appHome: input.appHome,
    reviewDecisions,
  })
}
