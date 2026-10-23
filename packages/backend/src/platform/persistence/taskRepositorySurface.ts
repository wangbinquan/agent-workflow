import { mountDepth, redactGitUrl } from '@agent-workflow/shared'
import {
  projectTaskRepositorySurface,
  taskBranch,
  taskRepositoryNodePaths,
  type RequestedSource,
  type TaskRepositoryMount,
} from '@/platform/taskRepository'
type StoredTaskRepositoryMount = TaskRepositoryMount & { readonly worktreeDirName?: string }

/** Epoch-1 input; optional fields allow the existing narrow list queries to stay narrow. */
export interface TaskRepositorySourceColumns {
  readonly repoUrl?: string | null
  readonly cachedRepoId?: string | null
  readonly baseBranch?: string
  readonly repoGroupId?: string | null
  readonly repoGroupName?: string | null
  readonly spaceKind?: string
}

/**
 * II-a compatibility view, not an exact reconstruction for II-b: legacy local becomes internal;
 * remote with no group, cached id or URL becomes scratch; URL resolved through a cache cannot
 * be distinguished from a cached-repo request. requestedRef is the resolved base_branch, not
 * the original requested ref. II-b must retain those source facts separately when converting.
 */
export function decodeRequestedSource(row: TaskRepositorySourceColumns): RequestedSource {
  const kind =
    row.spaceKind === 'inherited'
      ? 'inherited'
      : row.spaceKind === 'internal' || row.spaceKind === 'local'
        ? 'internal'
        : row.spaceKind === 'scratch'
          ? 'scratch'
          : row.repoGroupId
            ? 'repo-group'
            : row.cachedRepoId
              ? 'cached-repo'
              : row.repoUrl
                ? 'url'
                : 'scratch'
  return {
    codec: 'requestedSource@v1',
    kind,
    cachedRepoId: row.cachedRepoId ?? null,
    repoUrl: row.repoUrl == null ? null : redactGitUrl(row.repoUrl),
    requestedRef: row.baseBranch ?? '',
    repoGroupId: row.repoGroupId ?? null,
    repoGroupName: row.repoGroupName ?? null,
  }
}

export interface TaskRepositorySurfaceColumns extends TaskRepositorySourceColumns {
  readonly id?: string
  readonly repoPath?: string
  readonly branch?: string
  readonly workingBranch?: string | null
  readonly baseCommit?: string | null
  readonly worktreePath?: string
  readonly repoCount?: number
}

/** Compare old DTO bytes only; RequestedSource above deliberately loses source distinctions. */
export function projectStoredTaskRepositorySurface(
  row: TaskRepositorySurfaceColumns,
  mounts: readonly StoredTaskRepositoryMount[] = [],
  nodePaths: readonly string[] = [],
  urlProjection: 'redacted' | 'stored' = 'redacted',
  directoryProjection: 'frozen' | 'supplied' = 'frozen',
) {
  const requestedSource = decodeRequestedSource(row)
  return projectTaskRepositorySurface(
    {
      requestedSource,
      taskBranch: taskBranch(row.id ?? '', row.workingBranch),
      workingBranch: row.workingBranch ?? null,
      nodePaths:
        directoryProjection === 'supplied'
          ? [...nodePaths]
          : nodePaths.length > 0
            ? [...nodePaths].sort((a, b) => mountDepth(a) - mountDepth(b) || a.localeCompare(b))
            : taskRepositoryNodePaths(mounts.map((mount) => mount.mountPath)),
    },
    row.worktreePath ?? '',
    mounts,
    {
      worktreeDirNames: new Map(
        mounts.map((mount) => [mount.ordinal, mount.worktreeDirName ?? mount.mountPath]),
      ),
      primary: {
        repoPath: row.repoPath ?? '',
        repoUrl: urlProjection === 'stored' ? (row.repoUrl ?? null) : requestedSource.repoUrl,
        cachedRepoId: requestedSource.cachedRepoId,
        baseBranch: requestedSource.requestedRef,
        branch: row.branch ?? taskBranch(row.id ?? '', row.workingBranch),
        baseCommit: row.baseCommit ?? null,
      },
      repoCount: row.repoCount ?? Math.max(1, mounts.length),
    },
  )
}

/** Summaries and WS frames must not gain the detail-only keys. */
export function projectStoredTaskRepositorySummary(
  row: TaskRepositorySurfaceColumns,
  urlProjection: 'redacted' | 'stored' = 'redacted',
) {
  const { repoPath, repoUrl, cachedRepoId, repoCount } = projectStoredTaskRepositorySurface(
    row,
    [],
    [],
    urlProjection,
  )
  return { repoPath, repoUrl, cachedRepoId, repoCount }
}

/** Keep materialized mount facts; only the absent-mount shape uses the old primary surface. */
export function projectStoredTaskRepositoryMounts(
  row: TaskRepositorySurfaceColumns,
  mounts: readonly TaskRepositoryMount[],
): TaskRepositoryMount[] {
  if (mounts.length > 0) return [...mounts]
  return projectStoredTaskRepositorySurface(row, [], [], 'stored').repos.map(
    ({ repoIndex, worktreeDirName: _directoryName, ...repo }) => ({ ...repo, ordinal: repoIndex }),
  )
}
