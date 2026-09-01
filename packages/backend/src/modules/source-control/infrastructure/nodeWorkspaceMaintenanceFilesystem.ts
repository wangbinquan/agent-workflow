import { existsSync, readdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { deleteSnapshotRefs, removeWorktree, runGit } from '@/util/git'
import { createLogger } from '@/util/log'
import type {
  WorkspaceMaintenanceFilesystem,
  WorkspaceTaskRecord,
  WorkspaceTaskRepositoryRecord,
} from '../application/ports/workspaceMaintenance'
import { WORKSPACE_ORPHAN_MIN_AGE_MS } from '../application/workspaceMaintenance'

const PARTIAL_CLONE_DIRECTORY = /~partial~[0-9A-HJKMNP-TV-Z]{26}$/
const log = createLogger('workspace-maintenance-filesystem')

export function createNodeWorkspaceMaintenanceFilesystem(input: {
  readonly appHome: string
  readonly isMaterializingTask: (taskId: string) => boolean
  readonly invalidateWorkspacePath: (path: string) => void
}): WorkspaceMaintenanceFilesystem {
  return Object.freeze({
    exists: existsSync,
    isMaterializingTask: input.isMaterializingTask,

    async removeWorkspace(
      task: WorkspaceTaskRecord,
      repositories: readonly WorkspaceTaskRepositoryRecord[],
    ): Promise<boolean> {
      const workspaceExisted = task.worktreePath !== '' && existsSync(task.worktreePath)
      if (task.spaceKind === 'scratch') {
        if (workspaceExisted) {
          await rm(task.worktreePath, { recursive: true, force: true })
          input.invalidateWorkspacePath(task.worktreePath)
        }
      } else if (task.repoCount > 1) {
        for (const repository of repositories) {
          if (repository.worktreePath !== '' && existsSync(repository.worktreePath)) {
            await removeWorktree({
              repoPath: repository.repoPath,
              worktreePath: repository.worktreePath,
              force: true,
            })
            input.invalidateWorkspacePath(repository.worktreePath)
          }
          await deleteSnapshotRefs(repository.repoPath, task.id)
        }
        if (workspaceExisted) await rm(task.worktreePath, { recursive: true, force: true })
      } else {
        if (workspaceExisted) {
          await removeWorktree({
            repoPath: task.repoPath,
            worktreePath: task.worktreePath,
            force: true,
          })
          input.invalidateWorkspacePath(task.worktreePath)
        }
        // Replay even if the worktree path disappeared between I/O and the
        // durable finalize: snapshot refs are an independently durable tail.
        await deleteSnapshotRefs(task.repoPath, task.id)
      }
      return workspaceExisted
    },

    async removeIsoContainer(task: WorkspaceTaskRecord | null, taskId: string): Promise<boolean> {
      const containerRoot = join(input.appHome, 'iso', taskId)
      const existed = existsSync(containerRoot)
      await rm(containerRoot, { recursive: true, force: true })
      if (task !== null) {
        for (const worktreePath of [task.worktreePath, task.repoPath]) {
          if (worktreePath !== '' && existsSync(worktreePath)) {
            await runGit(worktreePath, ['worktree', 'prune']).catch(() => {})
          }
        }
      }
      return existed
    },

    async isMerged(worktreePath: string, baseBranch: string, branch: string): Promise<boolean> {
      try {
        const result = await runGit(worktreePath, [
          'merge-base',
          '--is-ancestor',
          branch,
          baseBranch,
        ])
        return result.exitCode === 0
      } catch {
        return false
      }
    },

    listScratchDirectories() {
      const root = join(input.appHome, 'scratch')
      if (!existsSync(root)) return []
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ taskId: entry.name, path: join(root, entry.name) }))
    },

    listWorktreeLeaves() {
      const root = join(input.appHome, 'worktrees')
      if (!existsSync(root)) return []
      const leaves: Array<{ readonly taskId: string; readonly path: string }> = []
      for (const repository of readdirSync(root, { withFileTypes: true })) {
        if (!repository.isDirectory()) continue
        const repositoryRoot = join(root, repository.name)
        for (const task of readdirSync(repositoryRoot, { withFileTypes: true })) {
          if (task.isDirectory()) {
            leaves.push({ taskId: task.name, path: join(repositoryRoot, task.name) })
          }
        }
      }
      return leaves
    },

    listIsoTaskIds() {
      const root = join(input.appHome, 'iso')
      if (!existsSync(root)) return []
      return readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    },

    async removeAgedPath(path: string, now: number, minAgeMs: number): Promise<boolean> {
      if (now - statSync(path).mtimeMs < minAgeMs) return false
      await rm(path, { recursive: true, force: true })
      return true
    },

    async runPartialCloneGc(now: number, cloneTimeoutMs: number) {
      const root = join(input.appHome, 'repos')
      if (!existsSync(root)) return { scanned: 0, removed: 0 }
      const minAgeMs = Math.max(WORKSPACE_ORPHAN_MIN_AGE_MS, 2 * cloneTimeoutMs)
      let scanned = 0
      let removed = 0
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !PARTIAL_CLONE_DIRECTORY.test(entry.name)) continue
        scanned += 1
        const path = join(root, entry.name)
        try {
          if (now - statSync(path).mtimeMs < minAgeMs) continue
          await rm(path, { recursive: true, force: true })
          removed += 1
        } catch (error) {
          log.warn('failed to remove an orphaned partial clone directory', {
            path,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return { scanned, removed }
    },
  })
}
