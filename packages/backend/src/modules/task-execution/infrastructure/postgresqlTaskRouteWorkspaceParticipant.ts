import {
  redactGitUrl,
  type GitCommitIdentity,
  type PlannedDirectoryNode,
  type PlannedRepo,
  type SpaceKind,
  type StartTask,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'

import type { SecretBox } from '@/auth/secretBox'
import { taskRepos, taskSpaceNodes } from '@/db/schema'
import { composePostgresqlRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { resolveRepoGroupLayout } from '@/services/repoGroup'
import {
  cleanupMaterializedSpace,
  commitMaterializedSpace,
  materializeSpaceWithProvider,
  type PlannedSpaceLayout,
  type WorkspaceCleanupHookEvent,
} from '@/services/task'
import { ValidationError } from '@/util/errors'
import type {
  PostgresqlTaskRoutePreparedWorkspace,
  PostgresqlTaskRouteWorkspaceParticipant,
  PostgresqlTaskRouteWorkspaceRepository,
} from './postgresqlTaskRouteLaunchOperations'

export interface PostgresqlTaskRouteWorkspaceDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly secretBox?: SecretBox
  readonly cloneTimeoutMs?: number
  readonly workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
}

export interface PostgresqlTaskWorkspacePreparation {
  readonly taskId: string
  readonly task: StartTask
  readonly gitCommitIdentity: GitCommitIdentity | null
  readonly sourceTerminationSignal?: AbortSignal
}

/** Provider-bound filesystem materializer shared by initial launch and durable
 * repository-preparation retry. Authorization remains at the calling use case. */
export interface PostgresqlTaskWorkspaceMaterializer {
  prepare(input: PostgresqlTaskWorkspacePreparation): Promise<PostgresqlTaskRoutePreparedWorkspace>
}

function minimalNodePaths(mountPaths: readonly string[]): string[] {
  const paths = new Map<string, string>([['', '']])
  for (const mountPath of mountPaths) {
    let current = ''
    for (const segment of mountPath.split('/').filter(Boolean)) {
      current = current === '' ? segment : `${current}/${segment}`
      paths.set(current.toLowerCase(), current)
    }
  }
  const depth = (path: string) => path.split('/').filter(Boolean).length
  return [...paths.values()].sort(
    (left, right) => depth(left) - depth(right) || left.localeCompare(right),
  )
}

async function loadFrozenSpaceLayout(
  db: PostgresqlDatabaseClient,
  sourceTaskId: string,
): Promise<PlannedSpaceLayout> {
  const rows = await db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, sourceTaskId))
    .orderBy(taskRepos.repoIndex)
  if (rows.length === 0) {
    throw new ValidationError(
      'source-task-not-replayable',
      `task '${sourceTaskId}' has no frozen repo snapshot to relaunch from`,
    )
  }
  const repos: PlannedRepo[] = []
  for (const row of rows) {
    if (row.cachedRepoId === null || row.cachedRepoId.length === 0) {
      throw new ValidationError(
        'source-task-not-replayable',
        `task '${sourceTaskId}' has a repo with no cached mirror id; its space cannot be replayed`,
      )
    }
    repos.push({
      cachedRepoId: row.cachedRepoId,
      repoUrlRedacted: row.repoUrl ?? '',
      ref: row.baseBranch,
      subdir: row.subdir,
      mountPath: row.mountPath,
      readonly: row.readonly,
      viaGroups: [],
    })
  }
  const frozenNodes = await db
    .select({ path: taskSpaceNodes.nodePath })
    .from(taskSpaceNodes)
    .where(eq(taskSpaceNodes.taskId, sourceTaskId))
  const paths =
    frozenNodes.length > 0
      ? frozenNodes.map((row) => row.path)
      : minimalNodePaths(repos.map((repo) => repo.mountPath))
  const depth = (path: string) => path.split('/').filter(Boolean).length
  const nodes: PlannedDirectoryNode[] = paths
    .sort((left, right) => depth(left) - depth(right) || left.localeCompare(right))
    .map((path) => ({ path, origins: [] }))
  return { repos, nodes }
}

function persistedSpaceKind(kind: SpaceKind): PostgresqlTaskRoutePreparedWorkspace['spaceKind'] {
  if (kind === 'internal' || kind === 'inherited') {
    throw new Error(`postgresql-task-route-workspace-kind-invalid:${kind}`)
  }
  return kind
}

function repositoryProjection(
  repo: Awaited<ReturnType<typeof materializeSpaceWithProvider>>['repos'][number],
  workingBranch: string | null,
): PostgresqlTaskRouteWorkspaceRepository {
  return Object.freeze({
    repoIndex: repo.repoIndex,
    repoPath: repo.repoPath,
    repoUrl: repo.repoUrl === null ? null : redactGitUrl(repo.repoUrl),
    cachedRepoId: repo.cachedRepoId,
    baseBranch: repo.baseBranch,
    branch: repo.branch,
    workingBranch,
    baseCommit: repo.baseCommit,
    worktreePath: repo.worktreePath,
    worktreeDirName: repo.worktreeDirName,
    mountPath: repo.mountPath,
    subdir: repo.subdir,
    readonly: repo.readonly,
    workspaceProfileVersion: repo.workspaceProfileVersion ?? null,
    workspaceProfileDigest: repo.workspaceProfileDigest ?? null,
    hasSubmodules: repo.hasSubmodules,
    submoduleInitOk: repo.submoduleInitOk,
    submoduleInitError: repo.submoduleInitError,
  })
}

/** Production PostgreSQL route workspace owner. Filesystem materialization is
 * shared with SQLite, while every cached-repo/group/frozen-task read is bound
 * to the selected PostgreSQL participants. */
export function createPostgresqlTaskWorkspaceMaterializer(
  dependencies: PostgresqlTaskRouteWorkspaceDependencies,
): PostgresqlTaskWorkspaceMaterializer {
  const store = composePostgresqlRepositoryWorkspaceStore(dependencies.db)
  return Object.freeze({
    async prepare(input: PostgresqlTaskWorkspacePreparation) {
      const space = await materializeSpaceWithProvider(
        input.task,
        {
          appHome: dependencies.appHome,
          repositoryWorkspace: store,
          loadFrozenSpaceLayout: (sourceTaskId) =>
            loadFrozenSpaceLayout(dependencies.db, sourceTaskId),
          gitCommitIdentity: input.gitCommitIdentity,
          ...(dependencies.secretBox === undefined ? {} : { secretBox: dependencies.secretBox }),
          ...(dependencies.cloneTimeoutMs === undefined
            ? {}
            : { cloneTimeoutMs: dependencies.cloneTimeoutMs }),
          ...(input.sourceTerminationSignal === undefined
            ? {}
            : { sourceTerminationLaunchSignal: input.sourceTerminationSignal }),
          ...(dependencies.workspaceCleanupHook === undefined
            ? {}
            : { workspaceCleanupHook: dependencies.workspaceCleanupHook }),
        },
        input.taskId,
      )
      const repositories = space.repos.map((repo) =>
        repositoryProjection(repo, input.task.workingBranch ?? null),
      )
      const head = repositories[0]
      const repoGroupId = input.task.repoGroupId ?? null
      const repoGroupName =
        repoGroupId === null ? null : (await resolveRepoGroupLayout(store, repoGroupId)).groupName
      return Object.freeze({
        taskId: space.taskId,
        kind: space.kind,
        spaceKind: persistedSpaceKind(space.spaceKind),
        repoPath: head?.repoPath ?? space.resolvedSources[0]?.repoPath ?? '',
        repoUrl:
          head?.repoUrl ??
          (space.resolvedSources[0]?.repoUrl === null ||
          space.resolvedSources[0]?.repoUrl === undefined
            ? null
            : redactGitUrl(space.resolvedSources[0].repoUrl)),
        cachedRepoId: head?.cachedRepoId ?? space.resolvedSources[0]?.cachedRepoId ?? null,
        repoGroupId,
        repoGroupName,
        worktreePath: space.worktreePath,
        baseBranch: head?.baseBranch ?? space.resolvedSources[0]?.baseBranch ?? '',
        branch: space.branch,
        baseCommit: space.baseCommit,
        earlyError: space.earlyError,
        repositories,
        nodePaths: [...space.nodePaths],
        commit: () => commitMaterializedSpace(space),
        rollback: () => cleanupMaterializedSpace(space, dependencies.workspaceCleanupHook),
      })
    },
  })
}

/** Route-facing adapter. The exact admitted actor remains consumed by the
 * launch operation while filesystem materialization receives only closed data. */
export function createPostgresqlTaskRouteWorkspaceParticipant(
  dependencies: PostgresqlTaskRouteWorkspaceDependencies,
): PostgresqlTaskRouteWorkspaceParticipant {
  const materializer = createPostgresqlTaskWorkspaceMaterializer(dependencies)
  return Object.freeze({
    async prepare(
      input: Parameters<PostgresqlTaskRouteWorkspaceParticipant['prepare']>[0],
    ): Promise<PostgresqlTaskRoutePreparedWorkspace> {
      return await materializer.prepare({
        taskId: input.taskId,
        task: input.task,
        gitCommitIdentity: input.gitCommitIdentity,
        ...(input.sourceTerminationSignal === undefined
          ? {}
          : { sourceTerminationSignal: input.sourceTerminationSignal }),
      })
    },
  })
}
