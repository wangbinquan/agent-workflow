import type { ReviewNodeReviewerDependencies } from '../application/reviewNodeReviewers'
import type { ReviewTaskAccessPort } from '../application/ports/reviewTaskAccess'
import {
  requireCollaborationTaskExecutionReadModels,
  resolveCollaborationCommandContext,
} from './commandContext'
import type { CollaborationCommandContext } from '../public/types'

function createReviewTaskAccessPort(context: CollaborationCommandContext): ReviewTaskAccessPort {
  const composed = resolveCollaborationCommandContext(context).reviewTaskAccess
  if (composed !== undefined) return composed
  throw new Error('collaboration review task access is not composed')
}

export function reviewNodeReviewerDependencies(
  context: CollaborationCommandContext,
): ReviewNodeReviewerDependencies {
  const dependencies = resolveCollaborationCommandContext(context)
  return {
    reviewerStore: dependencies.persistence.reviewers,
    taskAccess: createReviewTaskAccessPort(context),
    taskExecutionReadModels: requireCollaborationTaskExecutionReadModels(context),
  }
}
