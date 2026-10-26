import { canonicalJson, mountDepth, redactGitUrl, type TaskRepo } from '@agent-workflow/shared'
import { z } from 'zod'
export { isTaskWorkspaceUnbound } from '@agent-workflow/shared'

export interface TaskRepositoryMount extends Omit<TaskRepo, 'repoIndex' | 'worktreeDirName'> {
  readonly repoKey?: string
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

export const REQUESTED_SOURCE_CODEC = 'requestedSource@v2' as const

const RequestedSourceSchema = z.strictObject({
  codec: z.literal(REQUESTED_SOURCE_CODEC),
  kind: z.enum(['local', 'url', 'cached-repo', 'repo-group', 'scratch', 'internal', 'inherited']),
  kindProvenance: z.enum(['epoch1-stored-fields', 'task-creation']),
  spaceKind: z.enum(['local', 'remote', 'scratch', 'internal', 'inherited']),
  repoPath: z.string(),
  repoUrl: z.string().nullable(),
  cachedRepoId: z.string().nullable(),
  repoGroupId: z.string().nullable(),
  repoGroupName: z.string().nullable(),
  requestedRef: z.strictObject({
    value: z.string(),
    provenance: z.literal('resolved-base-branch'),
  }),
  // Retained for the zero-mount historical DTO; this is not an original request ref.
  legacyBaseCommit: z.string().nullable(),
})

export type PersistedRequestedSource = z.infer<typeof RequestedSourceSchema>

export function encodeRequestedSource(source: PersistedRequestedSource): string {
  return canonicalJson(RequestedSourceSchema.parse(source))
}

export function decodeRequestedSourceJson(json: string): PersistedRequestedSource {
  return RequestedSourceSchema.parse(JSON.parse(json) as unknown)
}

/** The II-a view is deliberately lossy; the persisted document remains intact. */
export function requestedSourceView(source: PersistedRequestedSource): RequestedSource {
  return {
    codec: 'requestedSource@v1',
    kind: source.kind === 'local' ? 'internal' : source.kind,
    cachedRepoId: source.cachedRepoId,
    repoUrl: source.repoUrl === null ? null : redactGitUrl(source.repoUrl),
    requestedRef: source.requestedRef.value,
    repoGroupId: source.repoGroupId,
    repoGroupName: source.repoGroupName,
  }
}

/** Supply the existing projection's primary input for an unmaterialized request. */
export function requestedSourcePrimary(
  source: PersistedRequestedSource,
  taskBranch: string,
): TaskRepositoryPrimarySurface {
  const view = requestedSourceView(source)
  return {
    repoPath: source.repoPath,
    repoUrl: view.repoUrl,
    cachedRepoId: source.cachedRepoId,
    baseBranch: source.requestedRef.value,
    branch: taskBranch,
    baseCommit: source.legacyBaseCommit,
  }
}

export interface TaskRequestedSourceInput {
  readonly spaceKind: PersistedRequestedSource['spaceKind']
  readonly repoPath: string
  readonly repoUrl?: string | null
  readonly cachedRepoId?: string | null
  readonly repoGroupId?: string | null
  readonly repoGroupName?: string | null
  readonly baseBranch: string
  readonly baseCommit: string | null
}

export function requestedSourceAtCreation(
  input: TaskRequestedSourceInput,
): PersistedRequestedSource {
  const kind =
    input.spaceKind !== 'remote'
      ? input.spaceKind
      : input.repoGroupId
        ? 'repo-group'
        : input.cachedRepoId
          ? 'cached-repo'
          : input.repoUrl
            ? 'url'
            : 'scratch'
  return {
    codec: REQUESTED_SOURCE_CODEC,
    kind,
    kindProvenance: 'task-creation',
    spaceKind: input.spaceKind,
    repoPath: input.repoPath,
    repoUrl: input.repoUrl ?? null,
    cachedRepoId: input.cachedRepoId ?? null,
    repoGroupId: input.repoGroupId ?? null,
    repoGroupName: input.repoGroupName ?? null,
    requestedRef: { value: input.baseBranch, provenance: 'resolved-base-branch' },
    legacyBaseCommit: input.baseCommit,
  }
}
