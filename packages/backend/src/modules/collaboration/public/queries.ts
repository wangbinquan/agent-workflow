// RFC-326/RFC-333 — collaboration's public queries.

import {
  requireCommittedReviewArtifactReader,
  requireCollaborationTaskAccess,
  requireReviewTaskAccess,
  requireTaskFeedbackStore,
} from '../application/commandContext'
import type { CollaborationCommandContext, ReviewActor } from './types'
import type { TaskFeedback } from '@agent-workflow/shared'

import type { CollaborationTaskAccessDecision } from '../application/ports/collaborationTaskAccess'
import { TaskFeedbackService } from '../application/taskFeedback'

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

export type { ClarifyAnswerQueries } from '../application/ports/clarifyAnswerQueries'
export { clarifyAnswerContentForPrompt } from '../domain/clarifyAnswerContent'
export { isAskingNodeInSnapshot } from '../domain/clarifyAskingNode'
