export type { HumanGateArtifactRecovery } from '../application/recoverHumanGateOperations'
// RFC-333 public collaboration commands. Command context is opaque; public
// inputs contain business data only and results are narrow receipts.

import { requireReviewTaskAccess, requireTaskFeedbackStore } from '../application/commandContext'
import type { CollaborationCommandContext, ReviewActor } from './types'
import { TaskFeedbackService } from '../application/taskFeedback'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'

export function createTaskFeedback(
  context: CollaborationCommandContext,
  input: {
    readonly actor: ReviewActor
    readonly taskId: string
    readonly bodyMd: string
  },
  memoryDistillEnqueuer: MemoryDistillEnqueuer,
) {
  return new TaskFeedbackService(
    requireTaskFeedbackStore(context),
    requireReviewTaskAccess(context),
  ).create(input, memoryDistillEnqueuer)
}
