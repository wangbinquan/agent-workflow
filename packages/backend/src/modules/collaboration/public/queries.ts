// RFC-326 — the `collaboration` context's public QUERIES (RFC-294 exact entrypoint).
//
// `resolveReviewAnchor` is a pure query: given a document and a simplified locator
// it answers "which composite anchor does this denote", or exactly why it cannot
// (candidates with global occurrence numbers, near misses, …). It never writes.
//
// `buildReviewAnchorDocument` prepares the one-scan document model a batch of
// resolutions shares; `createReviewAnchorBudget` bounds the total scanning a single
// request may do.

export {
  REVIEW_ANCHOR_CANDIDATE_LIMIT,
  REVIEW_ANCHOR_CONTEXT_CHARS,
  REVIEW_ANCHOR_DEFAULT_BUDGET_CHARS,
  REVIEW_ANCHOR_MESSAGE_CANDIDATE_LIMIT,
  REVIEW_ANCHOR_SUGGESTION_LIMIT,
  buildReviewAnchorDocument,
  createReviewAnchorBudget,
  paragraphIdxAt,
  resolveReviewAnchor,
  sectionPathAt,
} from '../domain/reviewAnchor'

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

function reviewerDependencies(context: CollaborationCommandContext) {
  return reviewNodeReviewerDependencies(context)
}

export function getReviewNodeReviewerConfig(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly taskId: string },
): Promise<ReviewNodeReviewerConfig> {
  return getReviewNodeReviewerConfigInternal(
    reviewerDependencies(context),
    input.actor,
    input.taskId,
  )
}

export function resolveReviewAccess(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly nodeRunId: string },
): Promise<ReviewAccessDecision | null> {
  return resolveReviewAccessInternal(reviewerDependencies(context), input.actor, input.nodeRunId)
}

export function filterReviewSummariesForActor<T extends ReviewSummary>(
  context: CollaborationCommandContext,
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

export function listRecentTaskFeedback(
  context: CollaborationCommandContext,
  limit = 20,
): Promise<readonly TaskFeedback[]> {
  return taskFeedbackService(context).listRecent(limit)
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

export function getCollaborationClarifyDirective(
  context: CollaborationCommandContext,
  input: {
    readonly taskId: string
    readonly nodeId: string
    readonly shardKey?: string | null
  },
): Promise<Readonly<{ directive: ClarifyDirective; updatedAt: number }> | null> {
  return requireClarifyDirectiveStore(context).get(input)
}

export function listCollaborationClarifyDirectives(
  context: CollaborationCommandContext,
  taskId: string,
): Promise<readonly Readonly<{ nodeId: string; directive: ClarifyDirective }>[]> {
  return requireClarifyDirectiveStore(context).listNodeDirectives(taskId)
}
