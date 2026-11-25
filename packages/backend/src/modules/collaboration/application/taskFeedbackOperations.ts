// RFC-587 — the task feedback entry points the feedback HTTP binding calls, moved verbatim from collaboration's public commands and
// queries: nothing outside this module calls them any more.
import type { TaskFeedback } from '@agent-workflow/shared'
import { requireReviewTaskAccess, requireTaskFeedbackStore } from './commandContext'
import type { CollaborationCommandContext, ReviewActor } from '../public/types'
import { TaskFeedbackService } from './taskFeedback'
import type { CollaborationMemoryDistillPort } from './ports/taskFeedbackMemoryDistill'

export function createTaskFeedback(
  context: CollaborationCommandContext,
  input: {
    readonly actor: ReviewActor
    readonly taskId: string
    readonly bodyMd: string
  },
  memoryDistillEnqueuer: CollaborationMemoryDistillPort,
) {
  return new TaskFeedbackService(
    requireTaskFeedbackStore(context),
    requireReviewTaskAccess(context),
  ).create(input, memoryDistillEnqueuer)
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
