// RFC-370 §9.2 V3 — hosted workspace maintenance (GC) on task volumes.
//
// GC removes directories *inside* a volume (a task's worktree, isolation
// containers, aged orphans); the volume itself (`/work/runs`, `/work/logs`, …)
// is closed only when its owner is deleted. Sweeps never wake a paused parent:
// they only visit parents the platform currently runs, and existence checks
// answer from the parent's platform state while it is dormant.
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type { WorkspaceMaintenanceFilesystem } from '../../application/ports/workspaceMaintenance'
import type { HostedTaskWorkspaces } from './taskWorkspace'
import { hostedWorkspaceReference, parseHostedWorkspaceReference } from './workspaceReference'

export function createHostedWorkspaceMaintenance(input: {
  readonly helper: WorkspaceHelper
  readonly workspaces: Pick<HostedTaskWorkspaces, 'find' | 'probe' | 'listRunning'>
  readonly isMaterializingTask: (taskId: string) => boolean
}): WorkspaceMaintenanceFilesystem {
  const observedIsoOwners = new Map<string, Set<string>>()
  const call = <T>(taskId: string, method: string, args: readonly unknown[]) =>
    input.helper.call<T>(taskId, 'workspace-maintenance', { method, args })
  const native = <T extends { readonly worktreePath: string; readonly repoPath: string }>(
    row: T,
    owner: string,
  ): T => {
    const path = (reference: string) => {
      if (reference === '') return ''
      const location = parseHostedWorkspaceReference(reference)
      if (location.taskId !== owner) throw new Error('hosted-workspace-owner-mismatch')
      return location.path
    }
    return { ...row, worktreePath: path(row.worktreePath), repoPath: path(row.repoPath) }
  }
  const directories = async (method: string) => {
    const result: Array<{ taskId: string; path: string }> = []
    for (const workspace of await input.workspaces.listRunning()) {
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
      const state = await input.workspaces.probe(location.taskId)
      if (state === 'absent' || state === 'gone') return false
      // A paused (or failed, rebuildable) volume keeps every path: only GC
      // removes paths, and GC runs against a running parent.
      if (state === 'dormant') return true
      return input.helper.call(location.taskId, 'exists', { path: location.path })
    },
    isMaterializingTask: input.isMaterializingTask,
    async removeWorkspace(task, repositories) {
      const owner =
        task.worktreePath === '' ? task.id : parseHostedWorkspaceReference(task.worktreePath).taskId
      // Borrowed call/fusion workspaces are the parent's canonical scene. A
      // child GC receipt cannot remove that scene.
      if (owner !== task.id) return false
      // No registered parent: there is no volume holding the worktree. The
      // parent is closed by the owner's deletion, never by GC.
      if ((await input.workspaces.find(owner)) === null) return false
      return call<boolean>(owner, 'removeWorkspace', [
        native(task, owner),
        repositories.map((row) => native(row, owner)),
      ])
    },
    async removeIsoContainer(task, taskId) {
      const owners = task?.worktreePath
        ? [parseHostedWorkspaceReference(task.worktreePath).taskId]
        : [...(observedIsoOwners.get(taskId) ?? [])]
      if (owners.length === 0) throw new Error('hosted-isolation-owner-unobserved')
      let removed = false
      for (const owner of owners) {
        if ((await input.workspaces.find(owner)) === null) continue
        removed =
          (await call<boolean>(owner, 'removeIsoContainer', [
            task === null ? null : native(task, owner),
            taskId,
          ])) || removed
      }
      return removed
    },
    isMerged(reference, base, branch) {
      const location = parseHostedWorkspaceReference(reference)
      return call(location.taskId, 'isMerged', [location.path, base, branch])
    },
    listScratchDirectories: () => directories('listScratchDirectories'),
    listWorktreeLeaves: () => directories('listWorktreeLeaves'),
    async listIsoTaskIds() {
      observedIsoOwners.clear()
      const ids = new Set<string>()
      for (const workspace of await input.workspaces.listRunning()) {
        for (const id of await call<readonly string[]>(workspace.taskId, 'listIsoTaskIds', [])) {
          ids.add(id)
          const owners = observedIsoOwners.get(id) ?? new Set<string>()
          owners.add(workspace.taskId)
          observedIsoOwners.set(id, owners)
        }
      }
      return [...ids]
    },
    removeAgedPath(reference, now, minAgeMs) {
      const location = parseHostedWorkspaceReference(reference)
      return call(location.taskId, 'removeAgedPath', [location.path, now, minAgeMs])
    },
    async runPartialCloneGc(now, cloneTimeoutMs) {
      const total = { scanned: 0, removed: 0 }
      for (const workspace of await input.workspaces.listRunning()) {
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
