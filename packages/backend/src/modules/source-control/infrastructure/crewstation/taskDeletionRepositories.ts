import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { TaskDeletionRepositoryParticipant } from '../../public/participants'
import type { HostedTaskWorkspaces } from './taskWorkspace'
import { parseHostedWorkspaceReference } from './workspaceReference'

/** RFC-370 §9.2 V3 — repository cleanup inside the owner's volume. The volume
 * itself is closed by the deletion's content step for the owner; this
 * participant never closes a parent. A volume without a registered parent
 * holds nothing left to clean. */
export function createHostedTaskDeletionRepositories(input: {
  readonly helper: WorkspaceHelper
  readonly workspaces: Pick<HostedTaskWorkspaces, 'find'>
}): TaskDeletionRepositoryParticipant {
  const available = async (taskId: string) => (await input.workspaces.find(taskId)) !== null
  return {
    async removeWorktree(request) {
      const repository = parseHostedWorkspaceReference(request.repoPath)
      const workspace = parseHostedWorkspaceReference(request.worktreePath)
      if (repository.taskId !== workspace.taskId)
        throw new Error('hosted-delete-workspace-owner-mismatch')
      if (!(await available(workspace.taskId))) return
      await input.helper.call(workspace.taskId, 'delete-task-repository', {
        method: 'removeWorktree',
        repoPath: repository.path,
        worktreePath: workspace.path,
      })
    },
    async deleteSnapshotRefs(reference, taskId) {
      const repository = parseHostedWorkspaceReference(reference)
      if (!(await available(repository.taskId))) return
      await input.helper.call(repository.taskId, 'delete-task-repository', {
        method: 'deleteSnapshotRefs',
        repoPath: repository.path,
        taskId,
      })
    },
  }
}
