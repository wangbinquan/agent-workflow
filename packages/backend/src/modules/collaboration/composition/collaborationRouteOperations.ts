import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  CollaborationRouteOperations,
  CollaborationRoutePersistenceOperations,
} from '../application/ports/collaborationRouteOperations'
import { createCollaborationClarifyDraftEventPublisher } from '../infrastructure/collaborationClarifyDraftEventPublisher'
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
import type { CollaborationCommandContext } from '../public/types'

function bindCollaborationRouteContext(
  context: CollaborationCommandContext,
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
function composeCollaborationRouteOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly context: CollaborationCommandContext
}): CollaborationRouteOperations {
  return bindCollaborationRouteContext(
    input.context,
    createCollaborationRouteOperations({
      db: input.db,
      clarifyDraftEvents: createCollaborationClarifyDraftEventPublisher(),
    }),
  )
}

export function composeSqliteCollaborationRouteOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly context: CollaborationCommandContext
}): CollaborationRouteOperations {
  return composeCollaborationRouteOperations(input)
}

export function composePostgresqlCollaborationRouteOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly context: CollaborationCommandContext
}): CollaborationRouteOperations {
  return composeCollaborationRouteOperations(input)
}
