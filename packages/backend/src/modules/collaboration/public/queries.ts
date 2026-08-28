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

import { readCommittedReviewArtifactBody as readCommittedReviewArtifactBodyInternal } from '../infrastructure/fsHumanGateArtifactStore'
import {
  requireCollaborationAppHome,
  resolveCollaborationCommandContext,
} from '../composition/commandContext'
import type { CollaborationCommandContext, ReviewActor } from './types'
import type { ReviewNodeReviewerConfig, ReviewSummary } from '@agent-workflow/shared'
import {
  filterReviewSummariesForActor as filterReviewSummariesForActorInternal,
  getReviewNodeReviewerConfig as getReviewNodeReviewerConfigInternal,
  resolveReviewAccess as resolveReviewAccessInternal,
} from '../application/reviewNodeReviewers'
import type { ReviewAccessDecision } from '../domain/reviewAccess'
import { reviewNodeReviewerDependencies } from '../composition/reviewNodeReviewerDependencies'

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
): string {
  return readCommittedReviewArtifactBodyInternal(
    resolveCollaborationCommandContext(context).db,
    requireCollaborationAppHome(context),
    finalPath,
  )
}
