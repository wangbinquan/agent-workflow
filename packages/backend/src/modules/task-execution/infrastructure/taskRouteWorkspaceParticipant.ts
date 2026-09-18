import {
  redactGitUrl,
  type GitCommitIdentity,
  type PlannedDirectoryNode,
  type PlannedRepo,
  type SpaceKind,
  type StartTask,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { eq } from 'drizzle-orm'

import type { SecretBox } from '@/auth/secretBox'
import { taskRepos, taskSpaceNodes } from '@/db/schema'
import { composePostgresqlRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { ensureCachedRepoIdentity } from '@/services/gitRepoCache'
import { resolveRepoGroupLayout } from '@/services/repoGroup'
import {
  cleanupMaterializedSpace,
  commitMaterializedSpace,
  materializeSpaceWithProvider,
  type PlannedSpaceLayout,
  type WorkspaceCleanupHookEvent,
  type WorkspaceCleanupReport,
} from '@/services/task'
import { ValidationError } from '@/util/errors'
import type {
  TaskRoutePreparedWorkspace,
  TaskRouteWorkspaceParticipant,
  TaskRouteWorkspaceRepository,
} from './taskRouteLaunchOperations'

export interface TaskRouteWorkspaceDependencies {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly secretBox?: SecretBox
  readonly cloneTimeoutMs?: number
  readonly workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
}

export interface TaskWorkspacePreparation {
  readonly taskId: string
  readonly task: StartTask
  readonly gitCommitIdentity: GitCommitIdentity | null
  readonly sourceTerminationSignal?: AbortSignal
  /**
   * RFC-287 G7 / RFC-359 AC-1（plan §5hn 批次二 ①）—— **延后仓库准备**。
   *
   * 为 true 时不做任何克隆 / 抓取 / 建树，只交出一份**占位**工作区：任务行先落
   * `pending`，真正的物化由驱动认领后作为第 0 步推进（`repositoryPreparation` 步骤），
   * 失败转 `failed` 且 git 原文留在行上。调用方决定何时开：JSON body 启动与
   * 定时 / webhook 触发开，multipart（要把上传物写进工作树）与代理 / 工作组直启不开。
   *
   * 判据与 `services/task.ts` 的那份**逐条相同**（scratch / `sourceTaskId` 重放不延后），
   * 由本函数自己兜住——让两条路的语义没有第二个人可以写错。
   */
  readonly defer?: boolean
}

/** Provider-bound filesystem materializer shared by initial launch and durable
 * repository-preparation retry. Authorization remains at the calling use case. */
export interface TaskWorkspaceMaterializer {
  prepare(input: TaskWorkspacePreparation): Promise<TaskRoutePreparedWorkspace>
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

export async function loadFrozenSpaceLayout(
  db: ProviderNeutralDatabase,
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

function persistedSpaceKind(kind: SpaceKind): TaskRoutePreparedWorkspace['spaceKind'] {
  if (kind === 'internal' || kind === 'inherited') {
    throw new Error(`postgresql-task-route-workspace-kind-invalid:${kind}`)
  }
  return kind
}

function repositoryProjection(
  repo: Awaited<ReturnType<typeof materializeSpaceWithProvider>>['repos'][number],
  workingBranch: string | null,
): TaskRouteWorkspaceRepository {
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

/**
 * RFC-287 G7 的延后判据，与 `services/task.ts` 那份逐条对齐：
 *   · `scratch` —— 临时空间没有远端要克隆，延后零收益，而占位行必须先认领一个
 *     `spaceKind`，写 'remote' 对 scratch 就是错的；
 *   · `sourceTaskId` 重放 —— 占位行存不住来源（冻结布局在**源任务**的 `task_repos` 上），
 *     延后会造出一个必然点不动的「重试准备」按钮（RFC-287 四轮门用户拍板）。
 */
function deferralApplies(input: TaskWorkspacePreparation): boolean {
  if (input.defer !== true) return false
  if (input.task.scratch === true) return false
  if (typeof (input.task as { sourceTaskId?: unknown }).sourceTaskId === 'string') return false
  return true
}

/**
 * 占位工作区：没有任何目录被占用，因此 `commit` / `rollback` 都是空操作
 *（真正的租约在第 0 步物化成功后才产生）。
 *
 * **`cachedRepoId` 必须在这里就落定**——AC-11 的「重试准备仓库」要靠它重建来源，
 * 而 `tasks.repo_url` 是脱敏存的、驱动不了重跑。身份解析（canonical hash → 一行
 * `cached_repos` + URL 密封）是纯 DB 写、几毫秒，留在同步段；克隆才异步。
 * 同理 `baseBranch` 先存**请求里的 `ref`**：重试重建启动输入时它不在其中，
 * 不存下来就会静默落到镜像默认分支（用户选了 `release/2.1`，重试却在 `main` 上改代码）。
 */
async function prepareDeferredWorkspace(
  dependencies: TaskRouteWorkspaceDependencies,
  store: ReturnType<typeof composePostgresqlRepositoryWorkspaceStore>,
  input: TaskWorkspacePreparation,
): Promise<TaskRoutePreparedWorkspace> {
  const task = input.task
  let cachedRepoId: string | null = null
  if (typeof task.repoUrl === 'string' && task.repoUrl.length > 0) {
    const identity = await ensureCachedRepoIdentity(
      {
        store,
        appHome: dependencies.appHome,
        ...(dependencies.secretBox === undefined ? {} : { secretBox: dependencies.secretBox }),
      },
      { url: task.repoUrl },
    )
    cachedRepoId = identity.cachedRepoId
  } else if (typeof task.cachedRepoId === 'string' && task.cachedRepoId.length > 0) {
    // 以 `cachedRepoId` 启动时它**本身就是身份**，直接落到占位行——漏掉这一支，
    // warm fetch 失败后点「重试准备」会撞 `repo-prep-source-unavailable`。
    cachedRepoId = task.cachedRepoId
  }
  const repoGroupId =
    typeof task.repoGroupId === 'string' && task.repoGroupId.length > 0 ? task.repoGroupId : null
  const repoGroupName =
    repoGroupId === null ? null : (await resolveRepoGroupLayout(store, repoGroupId)).groupName
  return Object.freeze({
    taskId: input.taskId,
    kind: 'single' as const,
    spaceKind: 'remote' as const,
    repoPath: '',
    // 脱敏由落行那一步统一做（`redactGitUrl(preparedWorkspace.repoUrl)`）；
    // 这里交原文，准备窗口内详情页才看得到自己在等哪个仓。
    repoUrl: typeof task.repoUrl === 'string' && task.repoUrl.length > 0 ? task.repoUrl : null,
    cachedRepoId,
    repoGroupId,
    repoGroupName,
    worktreePath: '',
    baseBranch: typeof task.ref === 'string' && task.ref.length > 0 ? task.ref : '',
    branch: '',
    baseCommit: null,
    // 「尚未物化」与「物化失败」不同：后者 `earlyError` 非空、行落 `failed`；
    // 本态为 null，行落 `pending`，等第 0 步。
    earlyError: null,
    repositories: [] as readonly TaskRouteWorkspaceRepository[],
    nodePaths: [] as readonly string[],
    commit: () => undefined,
    rollback: (): Promise<WorkspaceCleanupReport> =>
      Promise.resolve({ taskId: input.taskId, complete: true, failures: [] }),
  })
}

/** Production PostgreSQL route workspace owner. Filesystem materialization is
 * shared with SQLite, while every cached-repo/group/frozen-task read is bound
 * to the selected PostgreSQL participants. */
export function createTaskWorkspaceMaterializer(
  dependencies: TaskRouteWorkspaceDependencies,
): TaskWorkspaceMaterializer {
  const store = composePostgresqlRepositoryWorkspaceStore(dependencies.db)
  return Object.freeze({
    async prepare(input: TaskWorkspacePreparation) {
      if (deferralApplies(input)) {
        return await prepareDeferredWorkspace(dependencies, store, input)
      }
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
export function createTaskRouteWorkspaceParticipant(
  dependencies: TaskRouteWorkspaceDependencies,
): TaskRouteWorkspaceParticipant {
  const materializer = createTaskWorkspaceMaterializer(dependencies)
  return Object.freeze({
    async prepare(
      input: Parameters<TaskRouteWorkspaceParticipant['prepare']>[0],
    ): Promise<TaskRoutePreparedWorkspace> {
      return await materializer.prepare({
        taskId: input.taskId,
        task: input.task,
        gitCommitIdentity: input.gitCommitIdentity,
        ...(input.defer === undefined ? {} : { defer: input.defer }),
        ...(input.sourceTerminationSignal === undefined
          ? {}
          : { sourceTerminationSignal: input.sourceTerminationSignal }),
      })
    },
  })
}
