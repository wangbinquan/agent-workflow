import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  CollaborationRouteOperations,
  CollaborationRoutePersistenceOperations,
} from '../application/ports/collaborationRouteOperations'
import { createCollaborationClarifyDraftEventPublisher } from '../infrastructure/collaborationClarifyDraftEventPublisher'
import { createPostgresqlCollaborationRouteOperations } from '../infrastructure/postgresqlCollaborationRouteOperations'
import type { PostgresqlCollaborationRouteNodeLifecycleParticipantFactory } from '../infrastructure/postgresqlCollaborationRouteOperations'
import { createSqliteCollaborationRouteOperations } from '../infrastructure/sqliteCollaborationRouteOperations'
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

export function composeSqliteCollaborationRouteOperations(input: {
  readonly db: DbClient
  readonly context: CollaborationCommandContext
}): CollaborationRouteOperations {
  return bindCollaborationRouteContext(
    input.context,
    createSqliteCollaborationRouteOperations(input.db),
  )
}

export function composePostgresqlCollaborationRouteOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly context: CollaborationCommandContext
  readonly taskNodeLifecycle: PostgresqlCollaborationRouteNodeLifecycleParticipantFactory
}): CollaborationRouteOperations {
  return bindCollaborationRouteContext(
    input.context,
    createPostgresqlCollaborationRouteOperations({
      db: input.db,
      taskAccess: {
        visibleTaskIds: async (actor, taskIds) =>
          await visibleCollaborationTaskIds(input.context, { actor, taskIds }),
      },
      taskNodeLifecycle: input.taskNodeLifecycle,
      clarifyDraftEvents: createCollaborationClarifyDraftEventPublisher(),
    }),
  )
}
