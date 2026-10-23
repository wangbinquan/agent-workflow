import { inArray } from 'drizzle-orm'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { TaskDeletionCollaborationParticipant } from '../application/ports/taskDeletionParticipant'

export function createTaskDeletionCollaborationParticipantInTx(
  tx: PersistenceTx,
): TaskDeletionCollaborationParticipant {
  const { taskCollaborators, taskFeedback } = tablesOf(tx)
  return {
    async members(taskIds) {
      if (taskIds.length === 0) return []
      return tx
        .select({ taskId: taskCollaborators.taskId, userId: taskCollaborators.userId })
        .from(taskCollaborators)
        .where(inArray(taskCollaborators.taskId, [...taskIds]))
    },
    async deleteFeedback(taskIds) {
      await tx.delete(taskFeedback).where(inArray(taskFeedback.taskId, [...taskIds]))
    },
  }
}
