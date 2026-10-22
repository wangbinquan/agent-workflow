// RFC-326/RFC-333 — collaboration's public queries.

import {
  requireCommittedReviewArtifactReader,
  requireClarifyDirectiveStore,
  requireCollaborationTaskAccess,
  requireReviewTaskAccess,
  requireTaskFeedbackStore,
} from '../composition/commandContext'
import type { CollaborationCommandContext, ReviewActor } from './types'
import type { ReviewNodeReviewerConfig, ReviewSummary, TaskFeedback } from '@agent-workflow/shared'
import type { ClarifyDirective } from '@agent-workflow/shared'
import type { CollaborationHumanInputQueries } from './types'

export function readCollaborationHumanInputs(
  queries: CollaborationHumanInputQueries,
  taskId: string,
) {
  return queries.clarificationRounds(taskId)
}
export function readCollaborationReviewDecision(
  queries: CollaborationHumanInputQueries,
  taskId: string,
  nodeRunId: string,
) {
  return queries.reviewDecision(taskId, nodeRunId)
}
import {
  filterReviewSummariesForActor as filterReviewSummariesForActorInternal,
  getReviewNodeReviewerConfig as getReviewNodeReviewerConfigInternal,
  resolveReviewAccess as resolveReviewAccessInternal,
} from '../application/reviewNodeReviewers'
import type { ReviewAccessDecision } from '../domain/reviewAccess'
import type {
  CollaborationClarifyTaskAccessDecision,
  CollaborationNodeRunTaskAccessDecision,
  CollaborationTaskAccessDecision,
} from '../application/ports/collaborationTaskAccess'
import { reviewNodeReviewerDependencies } from '../composition/reviewNodeReviewerDependencies'
import { TaskFeedbackService } from '../application/taskFeedback'

function reviewerDependencies(context: CollaborationCommandContext<'taskExecutionReadModels'>) {
  return reviewNodeReviewerDependencies(context)
}

export function getReviewNodeReviewerConfig(
  context: CollaborationCommandContext<'taskExecutionReadModels'>,
  input: { readonly actor: ReviewActor; readonly taskId: string },
): Promise<ReviewNodeReviewerConfig> {
  return getReviewNodeReviewerConfigInternal(
    reviewerDependencies(context),
    input.actor,
    input.taskId,
  )
}

export function resolveReviewAccess(
  context: CollaborationCommandContext<'taskExecutionReadModels'>,
  input: { readonly actor: ReviewActor; readonly nodeRunId: string },
): Promise<ReviewAccessDecision | null> {
  return resolveReviewAccessInternal(reviewerDependencies(context), input.actor, input.nodeRunId)
}

export function filterReviewSummariesForActor<T extends ReviewSummary>(
  context: CollaborationCommandContext<'taskExecutionReadModels'>,
  input: { readonly actor: ReviewActor; readonly rows: readonly T[] },
): Promise<Array<T & { accessScope: 'task' | 'review-node' }>> {
  return filterReviewSummariesForActorInternal(
    reviewerDependencies(context),
    input.actor,
    input.rows,
  )
}

export function readCommittedReviewArtifactBody(
  context: CollaborationCommandContext,
  finalPath: string,
): Promise<string> {
  return requireCommittedReviewArtifactReader(context).read(finalPath)
}

function taskFeedbackService(context: CollaborationCommandContext): TaskFeedbackService {
  return new TaskFeedbackService(
    requireTaskFeedbackStore(context),
    requireReviewTaskAccess(context),
  )
}

export function canViewTaskFeedback(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly taskId: string },
): Promise<boolean> {
  return taskFeedbackService(context).canView(input.actor, input.taskId)
}

export function listTaskFeedback(
  context: CollaborationCommandContext,
  taskId: string,
): Promise<readonly TaskFeedback[]> {
  return taskFeedbackService(context).list(taskId)
}

export function resolveCollaborationTaskAccess(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly taskId: string },
): Promise<CollaborationTaskAccessDecision> {
  return requireCollaborationTaskAccess(context).resolveTask(input.actor, input.taskId)
}

export function resolveCollaborationNodeRunTaskAccess(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly nodeRunId: string },
): Promise<CollaborationNodeRunTaskAccessDecision> {
  return requireCollaborationTaskAccess(context).resolveNodeRunTask(input.actor, input.nodeRunId)
}

export function resolveCollaborationClarifyTaskAccess(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly intermediaryNodeRunId: string },
): Promise<CollaborationClarifyTaskAccessDecision> {
  return requireCollaborationTaskAccess(context).resolveClarifyRoundTask(
    input.actor,
    input.intermediaryNodeRunId,
  )
}

export function visibleCollaborationTaskIds(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly taskIds: readonly string[] },
): Promise<ReadonlySet<string>> {
  return requireCollaborationTaskAccess(context).visibleTaskIds(input.actor, input.taskIds)
}

export function collaborationQuestionTaskId(
  context: CollaborationCommandContext,
  entryId: string,
): Promise<string | null> {
  return requireCollaborationTaskAccess(context).questionTaskId(entryId)
}

export function listCollaborationClarifyDirectives(
  context: CollaborationCommandContext,
  taskId: string,
): Promise<readonly Readonly<{ nodeId: string; directive: ClarifyDirective }>[]> {
  return requireClarifyDirectiveStore(context).listNodeDirectives(taskId)
}
