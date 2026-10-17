import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { TaskDeletionContentEffects } from '../../application/ports/taskDeletionContentEffects'

const PREFIX = 'aw-hosted-task-retention:'

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
      const ref = (kind: string) =>
        `${PREFIX}${encodeURIComponent(owner)}/${encodeURIComponent(taskId)}/${kind}`
      return [ref('runs'), ref('logs'), ref('scratch')]
    },
    async removeIfPresent(reference) {
      if (!reference.startsWith(PREFIX)) {
        const location = input.locate(reference)
        if (!(await available(location.taskId))) return
        await input.helper.call(location.taskId, 'delete-task-content', { path: location.path })
        return
      }
      const parts = reference.slice(PREFIX.length).split('/')
      if (parts.length !== 3 || !['runs', 'logs', 'scratch'].includes(parts[2]!))
        throw new Error('hosted-task-retention-reference-invalid')
      const owner = decodeURIComponent(parts[0]!)
      const taskId = decodeURIComponent(parts[1]!)
      if (
        !owner ||
        !taskId ||
        taskId.includes('/') ||
        taskId.includes('\\') ||
        taskId.includes('\0') ||
        taskId === '.' ||
        taskId === '..'
      )
        throw new Error('hosted-task-retention-reference-invalid')
      if (parts[2] === 'scratch' && taskId === owner) {
        // Close acknowledgement alone is insufficient: leave the original
        // deletion claim pending until the platform reports physical release.
        if (!(await input.workspaces.close(owner)))
          throw new Error('hosted-workspace-release-pending')
        return
      }
      if (!(await available(owner))) return
      await input.helper.call(owner, 'delete-task-content', { path: `/work/${parts[2]}/${taskId}` })
    },
  }
}
