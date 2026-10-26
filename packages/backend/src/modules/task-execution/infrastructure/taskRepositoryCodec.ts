import { redactGitUrl } from '@agent-workflow/shared'
import type { TaskRepositoryMount } from '../domain/taskRepository'

/** New epoch-1 writes encode directory names from mounts; historical reads may differ. */
export function taskRepositoryMountIdentity(mountPath: string) {
  return { mountPath, worktreeDirName: mountPath }
}

export type StoredTaskRepositoryMount = TaskRepositoryMount & { readonly worktreeDirName?: string }

export function decodeTaskRepositoryMount(
  row: Omit<TaskRepositoryMount, 'ordinal'> & { repoIndex: number; worktreeDirName: string },
): StoredTaskRepositoryMount {
  return {
    ordinal: row.repoIndex,
    // Carry only the exceptional stored alias through the compatibility projection.
    ...(row.worktreeDirName === row.mountPath ? {} : { worktreeDirName: row.worktreeDirName }),
    repoPath: row.repoPath,
    repoUrl: row.repoUrl === null ? null : redactGitUrl(row.repoUrl),
    cachedRepoId: row.cachedRepoId,
    baseBranch: row.baseBranch,
    branch: row.branch,
    workingBranch: row.workingBranch,
    baseCommit: row.baseCommit,
    worktreePath: row.worktreePath,
    mountPath: row.mountPath,
    subdir: row.subdir,
    readonly: row.readonly,
    readonlyDirtyCount: row.readonlyDirtyCount,
    workspaceProfileVersion: row.workspaceProfileVersion ?? null,
    workspaceProfileDigest: row.workspaceProfileDigest ?? null,
    hasSubmodules: row.hasSubmodules,
    submoduleInitOk: row.submoduleInitOk,
    submoduleInitError: row.submoduleInitError,
  }
}
