import { deleteSnapshotRefs, removeWorktree } from '@/util/git'
import type { TaskDeletionRepositoryParticipant } from '../../public/participants'

export function createGitTaskDeletionRepositoryEffects(): TaskDeletionRepositoryParticipant {
  return Object.freeze({
    removeWorktree(input: {
      readonly repoPath: string
      readonly worktreePath: string
      readonly force: true
    }): Promise<void> {
      return removeWorktree(input)
    },
    async deleteSnapshotRefs(repoPath: string, taskId: string): Promise<void> {
      await deleteSnapshotRefs(repoPath, taskId)
    },
  })
}
