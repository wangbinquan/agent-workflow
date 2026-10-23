// RFC-395 II-a A1: public projection inputs, independent of the future physical table split.

export interface TaskRepoFixtureSpec {
  taskId: string
  repoIndex: number
  repoPath: string
  repoUrl?: string | null
  cachedRepoId?: string | null
  baseBranch?: string
  branch: string
  workingBranch?: string | null
  baseCommit?: string | null
  worktreePath: string
  mountPath?: string
  subdir?: string
  readonly?: boolean
  readonlyDirtyCount?: number | null
  workspaceProfileVersion?: number | null
  workspaceProfileDigest?: string | null
  hasSubmodules?: boolean | null
  submoduleInitOk?: boolean | null
  submoduleInitError?: string | null
  schemaVersion?: number
  worktreeDirName?: never
}
