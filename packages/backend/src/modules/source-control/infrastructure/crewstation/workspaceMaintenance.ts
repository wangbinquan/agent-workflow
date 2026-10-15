import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { WorkspaceMaintenanceFilesystem } from '../../application/ports/workspaceMaintenance'
import type { HostedTaskWorkspaces } from './taskWorkspace'
import { hostedWorkspaceReference, parseHostedWorkspaceReference } from './workspaceReference'

export function createHostedWorkspaceMaintenance(input: {
  readonly helper: WorkspaceHelper
  readonly workspaces: HostedTaskWorkspaces
  readonly isMaterializingTask: (taskId: string) => boolean
}): WorkspaceMaintenanceFilesystem {
  const call = <T>(taskId: string, method: string, args: readonly unknown[]) =>
    input.helper.call<T>(taskId, 'workspace-maintenance', { method, args })
  const native = <T extends { readonly worktreePath: string; readonly repoPath: string }>(
    row: T,
  ): T => ({
    ...row,
    worktreePath:
      row.worktreePath === '' ? '' : parseHostedWorkspaceReference(row.worktreePath).path,
    repoPath: row.repoPath === '' ? '' : parseHostedWorkspaceReference(row.repoPath).path,
  })
  const directories = async (method: string) => {
    const result: Array<{ taskId: string; path: string }> = []
    for (const workspace of await input.workspaces.list()) {
      const rows = await call<readonly { taskId: string; path: string }[]>(
        workspace.taskId,
        method,
        [],
      )
      result.push(
        ...rows.map((row) => ({
          ...row,
          path: hostedWorkspaceReference(workspace.taskId, row.path),
        })),
      )
    }
    return result
  }
  return {
    async exists(reference) {
      if (reference === '') return false
      const location = parseHostedWorkspaceReference(reference)
      if ((await input.workspaces.find(location.taskId)) === null) return false
      return input.helper.call(location.taskId, 'exists', { path: location.path })
    },
    isMaterializingTask: input.isMaterializingTask,
    async removeWorkspace(task, repositories) {
      if ((await input.workspaces.find(task.id)) === null) {
        if (!(await input.workspaces.close(task.id)))
          throw new Error('hosted-workspace-release-pending')
        return false
      }
      const removed = await call<boolean>(task.id, 'removeWorkspace', [
        native(task),
        repositories.map(native),
      ])
      if (!(await input.workspaces.close(task.id)))
        throw new Error('hosted-workspace-release-pending')
      return removed
    },
    removeIsoContainer: (task, taskId) =>
      call(taskId, 'removeIsoContainer', [task === null ? null : native(task), taskId]),
    isMerged(reference, base, branch) {
      const location = parseHostedWorkspaceReference(reference)
      return call(location.taskId, 'isMerged', [location.path, base, branch])
    },
    listScratchDirectories: () => directories('listScratchDirectories'),
    listWorktreeLeaves: () => directories('listWorktreeLeaves'),
    async listIsoTaskIds() {
      const ids = new Set<string>()
      for (const workspace of await input.workspaces.list()) {
        for (const id of await call<readonly string[]>(workspace.taskId, 'listIsoTaskIds', []))
          ids.add(id)
      }
      return [...ids]
    },
    removeAgedPath(reference, now, minAgeMs) {
      const location = parseHostedWorkspaceReference(reference)
      return call(location.taskId, 'removeAgedPath', [location.path, now, minAgeMs])
    },
    async runPartialCloneGc(now, cloneTimeoutMs) {
      const total = { scanned: 0, removed: 0 }
      for (const workspace of await input.workspaces.list()) {
        const count = await call<{ scanned: number; removed: number }>(
          workspace.taskId,
          'runPartialCloneGc',
          [now, cloneTimeoutMs],
        )
        total.scanned += count.scanned
        total.removed += count.removed
      }
      return total
    },
  }
}
