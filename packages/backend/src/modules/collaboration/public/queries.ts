// RFC-326/RFC-333 — collaboration's public queries.
// RFC-587: the task feedback reads moved to application/taskFeedbackOperations.ts with their only caller (the feedback binding).

import {
  requireCommittedReviewArtifactReader,
  requireCollaborationTaskAccess,
} from '../application/commandContext'
import type { CollaborationCommandContext, ReviewActor } from './types'

import type { CollaborationTaskAccessDecision } from '../application/ports/collaborationTaskAccess'

export function readCommittedReviewArtifactBody(
  context: CollaborationCommandContext,
  finalPath: string,
): Promise<string> {
  return requireCommittedReviewArtifactReader(context).read(finalPath)
}

export function resolveCollaborationTaskAccess(
  context: CollaborationCommandContext,
  input: { readonly actor: ReviewActor; readonly taskId: string },
): Promise<CollaborationTaskAccessDecision> {
  return requireCollaborationTaskAccess(context).resolveTask(input.actor, input.taskId)
}

export type { ClarifyAnswerQueries } from '../application/ports/clarifyAnswerQueries'
export { clarifyAnswerContentForPrompt } from '../domain/clarifyAnswerContent'
