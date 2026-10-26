import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { HumanGateTaskLockPort } from './required-ports'
import { requireCommittedReviewArtifactReader } from './commandContext'
import { createClarifyFollowupOperations } from '../application/clarifyFollowup'
import { clarifyFollowupActivity } from '../infrastructure/clarifyFollowupActivity'
import { createClarifyFollowupStore } from '../infrastructure/clarifyFollowupStore'
import type { ClarifyFollowupGenerator } from '../application/ports/clarifyFollowup'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  CollaborationRouteOperations,
  CollaborationRoutePersistenceOperations,
} from '../application/ports/collaborationRouteOperations'
import {
  clarifyFollowupEvents,
  createCollaborationClarifyDraftEventPublisher,
} from '../infrastructure/collaborationClarifyDraftEventPublisher'
import { createCollaborationRouteOperations } from '../infrastructure/collaborationRouteOperations'
import {
  dispatchTaskQuestions,
  submitClarifyDecision,
  submitReviewDecision,
} from '../public/commands'
import {
  collaborationQuestionTaskId,
  filterReviewSummariesForActor,
  resolveCollaborationClarifyTaskAccess,
  resolveCollaborationNodeRunTaskAccess,
  resolveCollaborationTaskAccess,
  resolveReviewAccess,
  visibleCollaborationTaskIds,
} from '../public/queries'
import type { CollaborationRouteContext } from '../public/types'

function bindCollaborationRouteContext(
  context: CollaborationRouteContext,
  persistence: CollaborationRoutePersistenceOperations,
): CollaborationRouteOperations {
  const access: CollaborationRouteOperations['access'] = Object.freeze({
    resolveTask: async (input) => await resolveCollaborationTaskAccess(context, input),
    resolveNodeRunTask: async (input) =>
      await resolveCollaborationNodeRunTaskAccess(context, input),
    resolveClarifyTask: async (input) =>
      await resolveCollaborationClarifyTaskAccess(context, input),
    visibleTaskIds: async (input) => await visibleCollaborationTaskIds(context, input),
    questionTaskId: async (entryId) => await collaborationQuestionTaskId(context, entryId),
    resolveReview: async (input) => await resolveReviewAccess(context, input),
    filterReviewSummaries: async (input) => await filterReviewSummariesForActor(context, input),
  })
  const reviews: CollaborationRouteOperations['reviews'] = Object.freeze({
    ...persistence.reviews,
    submitDecision: async (input) => await submitReviewDecision(context, input),
  })
  const questions: CollaborationRouteOperations['questions'] = Object.freeze({
    ...persistence.questions,
    dispatch: async (input) => await dispatchTaskQuestions(context, input),
  })
  const clarify: CollaborationRouteOperations['clarify'] = Object.freeze({
    ...persistence.clarify,
    submitDecision: async (input) => await submitClarifyDecision(context, input),
  })
  return Object.freeze({ access, reviews, questions, clarify })
}

// RFC-359 W7：路由持久化面已合一（`infrastructure/collaborationRouteOperations.ts`），两个
// 装配入口只是名字不同的同一条线；名字暂留，等 bootstrap 侧的 provider 命名一并收敛。
export function composeCollaborationRouteOperations(input: {
  readonly historyRestrictions: HistoryRestrictionPort
  readonly taskLock: HumanGateTaskLockPort
  readonly db: PersistenceDb
  readonly context: CollaborationRouteContext
  readonly followupGenerator?: ClarifyFollowupGenerator
}): CollaborationRouteOperations {
  const events = createCollaborationClarifyDraftEventPublisher()
  const persistence = createCollaborationRouteOperations({
    historyRestrictions: input.historyRestrictions,
    db: input.db,
    taskLock: input.taskLock,
    clarifyDraftEvents: events,
    // Resolved at read time: the committed review content belongs to the
    // composed command context, which a route surface may be built before.
    reviewReader: {
      read: (finalPath) => requireCommittedReviewArtifactReader(input.context).read(finalPath),
    },
  })
  const followup =
    input.followupGenerator &&
    createClarifyFollowupOperations(
      createClarifyFollowupStore(input.db, events),
      input.followupGenerator,
      clarifyFollowupActivity,
      { events: clarifyFollowupEvents },
    )
  return bindCollaborationRouteContext(input.context, {
    ...persistence,
    clarify: {
      ...persistence.clarify,
      ...(followup
        ? {
            followup,
            // RFC-372 O8: the round detail is where viewers read the generation state.
            detail: async (intermediaryNodeRunId: string) => {
              const round = await persistence.clarify.detail(intermediaryNodeRunId)
              const status = followup.status(intermediaryNodeRunId)
              return status ? { ...round, followup: status } : round
            },
          }
        : {}),
    },
  })
}
