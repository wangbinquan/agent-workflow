import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import type { CollaborationClarifyDraftEventPublisher } from '../application/ports/collaborationRouteOperations'

/** Immediate task-channel projection for committed collaborative draft edits. */
export function createCollaborationClarifyDraftEventPublisher(): CollaborationClarifyDraftEventPublisher {
  const publisher: CollaborationClarifyDraftEventPublisher = {
    async publish(input): Promise<void> {
      taskBroadcaster.broadcast(TASK_CHANNEL(input.taskId), {
        id: -1,
        type: 'clarify.draft.updated',
        nodeRunId: input.nodeRunId,
        roundId: input.roundId,
        questionId: input.questionId,
        editor: input.editor,
        ts: input.occurredAt,
      })
    },
  }
  return Object.freeze(publisher)
}
