import { mountDepth, type TaskRepo } from '@agent-workflow/shared'
export { isTaskWorkspaceUnbound } from '@agent-workflow/shared'

export interface TaskRepositoryMount extends Omit<TaskRepo, 'repoIndex' | 'worktreeDirName'> {
  readonly ordinal: number
  readonly workspaceProfileVersion?: number | null
  readonly workspaceProfileDigest?: string | null
}

export interface RequestedSource {
  readonly codec: 'requestedSource@v1'
  readonly kind: 'url' | 'cached-repo' | 'repo-group' | 'scratch' | 'internal' | 'inherited'
  readonly cachedRepoId: string | null
  readonly repoUrl: string | null
  readonly requestedRef: string
  readonly repoGroupId: string | null
  readonly repoGroupName: string | null
}

export interface TaskRepositoryWorkspace {
  readonly requestedSource: RequestedSource
  readonly taskBranch: string
  readonly workingBranch: string | null
  readonly nodePaths: readonly string[]
}

export function taskRepositoryCount(mounts: readonly unknown[]): number {
  return Math.max(1, mounts.length)
}

export function taskBranch(taskId: string, workingBranch: string | null | undefined): string {
  return workingBranch ?? `agent-workflow/${taskId}`
}

/** Preserve explicit empty directories and materialize all mount ancestors once. */
export function taskRepositoryNodePaths(
  mountPaths: readonly string[],
  explicit: readonly string[] = [],
): string[] {
  const paths = new Map<string, string>([['', '']])
  for (const path of [...explicit, ...mountPaths]) {
    let current = ''
    for (const segment of path.split('/').filter(Boolean)) {
      current = current === '' ? segment : `${current}/${segment}`
      paths.set(current.toLowerCase(), current)
    }
  }
  return [...paths.values()].sort(
    (left, right) => mountDepth(left) - mountDepth(right) || left.localeCompare(right),
  )
}

export interface TaskRepositoryPrimarySurface {
  readonly repoPath: string
  readonly repoUrl: string | null
  readonly cachedRepoId: string | null
  readonly baseBranch: string
  readonly branch: string
  readonly baseCommit: string | null
}

/** II-a preserves the existing primary projection while mounts retain their own facts. */
export interface TaskRepositorySurfaceCompatibility {
  readonly worktreeDirNames?: ReadonlyMap<number, string>
  readonly primary: TaskRepositoryPrimarySurface
  readonly repoCount: number
}

export function projectTaskRepositorySurface(
  workspace: TaskRepositoryWorkspace,
  rootRef: string | null,
  mounts: readonly TaskRepositoryMount[],
  compatibility?: TaskRepositorySurfaceCompatibility,
) {
  const repos: TaskRepo[] = [...mounts]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((repo) => ({
      repoIndex: repo.ordinal,
      repoPath: repo.repoPath,
      repoUrl: repo.repoUrl,
      cachedRepoId: repo.cachedRepoId,
      baseBranch: repo.baseBranch,
      branch: repo.branch,
      workingBranch: repo.workingBranch,
      baseCommit: repo.baseCommit,
      worktreePath: repo.worktreePath,
      worktreeDirName: compatibility?.worktreeDirNames?.get(repo.ordinal) ?? repo.mountPath,
      mountPath: repo.mountPath,
      subdir: repo.subdir,
      readonly: repo.readonly,
      readonlyDirtyCount: repo.readonlyDirtyCount,
      hasSubmodules: repo.hasSubmodules,
      submoduleInitOk: repo.submoduleInitOk,
      submoduleInitError: repo.submoduleInitError,
    }))
  const source = workspace.requestedSource
  if (repos.length === 0)
    repos.push({
      repoIndex: 0,
      repoPath: '',
      repoUrl: source.repoUrl,
      cachedRepoId: source.cachedRepoId,
      baseBranch: source.requestedRef,
      branch: workspace.taskBranch,
      workingBranch: workspace.workingBranch,
      baseCommit: null,
      worktreePath: rootRef ?? '',
      worktreeDirName: '',
      mountPath: '',
      subdir: '',
      readonly: false,
      readonlyDirtyCount: null,
      hasSubmodules: null,
      submoduleInitOk: null,
      submoduleInitError: null,
      ...compatibility?.primary,
    })
  const primary = repos[0]!
  return {
    repoPath: primary.repoPath,
    repoUrl: primary.repoUrl,
    cachedRepoId: primary.cachedRepoId,
    baseBranch: primary.baseBranch,
    branch: primary.branch || workspace.taskBranch,
    workingBranch: workspace.workingBranch,
    baseCommit: primary.baseCommit,
    worktreePath: rootRef ?? '',
    repoCount: compatibility?.repoCount ?? taskRepositoryCount(mounts),
    ...compatibility?.primary,
    repoGroupId: source.repoGroupId,
    repoGroupName: source.repoGroupName,
    repos,
    spaceNodes: workspace.nodePaths.map((path) => ({ path, origins: [] })),
  }
}
