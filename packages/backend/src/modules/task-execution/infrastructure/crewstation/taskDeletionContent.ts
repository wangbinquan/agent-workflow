import {
  LEGACY_TASK_RETENTION_PREFIX as PREFIX,
  legacyTaskRetentionReference,
  parseLegacyTaskRetention,
} from '@/platform/content/legacyTaskRetention'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { TaskDeletionContentEffects } from '../../application/ports/taskDeletionContentEffects'

/** The deletion journal captures physical ownership before its task rows are
 * removed. Replaying a child cleanup can never close its parent's volume. */
export function createHostedTaskDeletionContent(input: {
  readonly helper: WorkspaceHelper
  readonly locate: (reference: string) => { readonly taskId: string; readonly path: string }
  readonly workspaces: {
    find(taskId: string): Promise<{ readonly businessTaskId: string } | null>
    close(taskId: string): Promise<boolean>
  }
}): TaskDeletionContentEffects {
  const available = async (owner: string) => {
    if (await input.workspaces.find(owner)) return true
    if (!(await input.workspaces.close(owner))) throw new Error('hosted-workspace-release-pending')
    return false
  }
  return {
    directories(taskId, workspaceReference) {
      const owner = workspaceReference ? input.locate(workspaceReference).taskId : taskId
      const ref = (kind: string) => legacyTaskRetentionReference(owner, taskId, kind)
      return [ref('runs'), ref('logs'), ref('scratch')]
    },
    async removeIfPresent(reference) {
      if (!reference.startsWith(PREFIX)) {
        const location = input.locate(reference)
        if (!(await available(location.taskId))) return
        await input.helper.call(location.taskId, 'delete-task-content', { path: location.path })
        return
      }
      const { owner, taskId, kind } = parseLegacyTaskRetention(reference)
      if (kind === 'scratch' && taskId === owner) {
        // Close acknowledgement alone is insufficient: leave the original
        // deletion claim pending until the platform reports physical release.
        if (!(await input.workspaces.close(owner)))
          throw new Error('hosted-workspace-release-pending')
        return
      }
      if (!(await available(owner))) return
      await input.helper.call(owner, 'delete-task-content', { path: `/work/${kind}/${taskId}` })
    },
  }
}
