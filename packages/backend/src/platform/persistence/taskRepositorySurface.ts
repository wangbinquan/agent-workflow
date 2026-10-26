import { renderSchemaExpression, type SchemaExpression } from './schema/expressions'
import { engineForHandle } from './sessionTables'
import { sql } from 'drizzle-orm'
import {
  decodeRequestedSourceJson,
  projectTaskRepositorySurface,
  requestedSourcePrimary,
  requestedSourceView,
  taskBranch,
  type RequestedSource,
  type TaskRepositoryMount,
} from '@/platform/taskRepository'
import { mountDepth, redactGitUrl } from '@agent-workflow/shared'
type StoredTaskRepositoryMount = TaskRepositoryMount & { readonly worktreeDirName?: string }

/** Epoch-1 input; optional fields allow the existing narrow list queries to stay narrow. */
export interface TaskRepositorySourceColumns {
  readonly requestedSource?: string
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
  const frozenSource =
    row.requestedSource === undefined ? null : decodeRequestedSourceJson(row.requestedSource)
  const requestedSource =
    frozenSource === null ? decodeRequestedSource(row) : requestedSourceView(frozenSource)
  const primaryUrl = row.repoUrl === undefined ? requestedSource.repoUrl : row.repoUrl
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
            : [],
    },
    row.worktreePath ?? '',
    mounts,
    {
      worktreeDirNames: new Map(
        mounts.map((mount) => [mount.ordinal, mount.worktreeDirName ?? mount.mountPath]),
      ),
      primary: {
        ...(frozenSource === null
          ? {}
          : requestedSourcePrimary(frozenSource, taskBranch(row.id ?? '', row.workingBranch))),
        repoPath: row.repoPath ?? frozenSource?.repoPath ?? '',
        repoUrl:
          urlProjection === 'stored' || primaryUrl === null ? primaryUrl : redactGitUrl(primaryUrl),
        cachedRepoId:
          row.cachedRepoId === undefined ? requestedSource.cachedRepoId : row.cachedRepoId,
        baseBranch: row.baseBranch ?? requestedSource.requestedRef,
        branch: row.branch ?? taskBranch(row.id ?? '', row.workingBranch),
        baseCommit:
          row.baseCommit === undefined ? (frozenSource?.legacyBaseCommit ?? null) : row.baseCommit,
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

/** requestedSource@v2 has already validated this nullable string. The expression is
 * shared with its index so requested-only probes stay bounded on both engines. */
export const requestedSourceCachedRepoExpression: SchemaExpression = {
  kind: 'raw',
  reason:
    'RFC-395 T: index the validated requestedSource@v2 cached repository without a mirror column.',
  sqlite: "json_extract(requested_source, '$.cachedRepoId')",
  postgresql: "(requested_source::jsonb ->> 'cachedRepoId')",
}

export function requestedSourceCachedRepoSql(db: object) {
  return sql<
    string | null
  >`${sql.raw(renderSchemaExpression(requestedSourceCachedRepoExpression, engineForHandle(db).provider))}`
}
