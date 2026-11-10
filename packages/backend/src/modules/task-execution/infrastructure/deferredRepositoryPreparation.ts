// RFC-478 —— 延后仓库准备（RFC-287 G7 / RFC-359 AC-1），原在 `services/task.ts`：驱动认领后第 0 步的描述读取与执行、
// 重试前的残骸回收、`task_repos` 投影的单一映射。它是 RFC-328 `workspace-prepare` effect 的现场、持久化写入协议与 fs / git 工作，
// 按 RFC-294 C10 落在 infrastructure；source-control 的物化、清理与组解析只经 consumer 自有的 `TaskRepositoryPreparationBinding`
// （bootstrap 装配），不取 source-control 的 composition 或内部。函数体除注明的 RFC-478 改动外原样迁来。
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  DAEMON_SHUTDOWN_ABORT_REASON,
  REPO_PREP_NODE_ID,
  isDaemonInterruptionAbortReason,
  isRetryableGitFailure,
  isTaskWorkspaceUnbound,
  redactGitUrl,
  type GitCommitIdentity,
  type StartTask,
  type Task,
  type TaskStatus,
} from '@agent-workflow/shared'
import type { SecretBox } from '@/auth/secretBox'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { decodeRequestedSource } from '@/platform/persistence/taskRepositorySurface'
import { ConflictError, diagnosticTextOf } from '@/util/errors'
import { removeDirectoryWithRetry } from '@/util/fsReclaim'
import { reclaimStaleRefLocks, runGit, withWorktreeRegistryLock } from '@/util/git'
import { createLogger } from '@/util/log'
import type {
  RepositoryPreparationDescriptorReader,
  RepositoryPreparationMechanicsPort,
} from '../application/drive/repositoryPreparationStep'
import { resolveTaskLaunchRuntimeConfiguration } from '../application/launchConfiguration'
import { createLocalEffectAttemptObserver } from '../application/localEffectObserver'
import { nextRetryIndex } from '../application/nextRetryIndex'
import { nodeRunMintIdentityForSlot } from '../application/nodeRunMintIdentity'
import type {
  MaterializedRepo,
  MaterializedSpace,
  MaterializedSpaceCleanup,
  PlannedSpaceLayout,
  WorkspaceCleanupHookEvent,
} from '../application/ports/preparedWorkspace'
import type { RepositoryPreparationLookup } from '../application/ports/repositoryPreparationLookup'
import type { TaskLaunchConfigurationQueries } from '../application/ports/taskLaunchConfiguration'
import { currentTaskExecutionContext } from '../application/taskExecutionContext'
import {
  acceptDurableRepositoryWorkspace,
  cleanupDurableRepositoryWorkspace,
  hasDurableRepositoryPreparation,
  prepareDurableRepositoryWorkspace,
} from './durableRepositoryPreparation'
import { mintNodeRun } from './legacyNodeRunMint'
import { createNodeRunQueries } from './nodeRunQueries'
import { setNodeRunStatusTx as setNodeRunStatusInTransaction } from './nodeRunLifecycleTransition'
import { fenceTaskWrite, withTaskExecutionWrite } from './ownedTaskExecution'
import type { TaskRepositoryPreparationBinding } from './repositoryPreparationBinding'
import { getTask } from './taskDetailRead'
import { setNodeRunStatus, setTaskStatus } from './taskLifecycle'
import { createTaskPreparationParticipantInTx } from './taskPreparationParticipant'
import { createTaskPreparationQueries } from './taskPreparationQueries'

const log = createLogger('task')

type WorkspacePreparationRepositoryProjection = Parameters<
  NonNullable<ReturnType<typeof createLocalEffectAttemptObserver>>['succeedWorkspacePreparation']
>[1]['repositories'][number]

/**
 * RFC-359 AC-1（plan §5hn 批次二 ①）—— **延后仓库准备**这一步真正需要的那些依赖。
 *
 * RFC-478：原先从测试依赖袋 `TaskContinuationDependencies` 里 `Pick` 出来，现按字段写出；`repositoryPreparation` 改为
 * **必填**——bootstrap 与全部用例装配都传它，「无绑定」时直调 source-control 物化的回落与 `repositoryWorkspace` 一并删除。
 */
export interface DeferredRepositoryPreparationDependencies {
  readonly db: PersistenceDb
  /** source-control 的物化、清理与组解析都经它（bootstrap 装配的 task 自有绑定）。 */
  readonly repositoryPreparation: TaskRepositoryPreparationBinding
  readonly repositoryPreparationLookup: RepositoryPreparationLookup
  /** 重放（`sourceTaskId`）用的冻结布局读取，由装配方交。 */
  readonly loadFrozenSpaceLayout: (sourceTaskId: string) => Promise<PlannedSpaceLayout>
  /** RFC-204: needed to unseal `cached_repos.url_enc` for a reuse-by-id launch. */
  secretBox?: SecretBox
  /** RFC-287 G7：任务启动路径的克隆/抓取超时（`config.gitCloneTimeoutMs`）。 */
  cloneTimeoutMs?: number
  /** RFC-287 G6：基线同步的总容忍窗口（ms，`config.gitBaselineSyncWindowMs`）；0 = 关闭重试。 */
  gitBaselineSyncWindowMs?: number
  /** The selected live configuration follows short-lived drive and continuation paths. */
  launchConfiguration?: TaskLaunchConfigurationQueries
  /** RFC-199 test seam for deterministic remove/ref/root cleanup failures. */
  workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
  /** 准备时才知道的那一格：占位行上冻结的提交身份由 descriptor 带回来。 */
  gitCommitIdentity?: GitCommitIdentity | null
}

/** RFC-478：延后准备的描述读取（`PersistedRepositoryPreparationStep` 的读端口实现；函数体原样来自 `services/task.ts`）。 */
export function createDeferredRepositoryPreparationReader(input: {
  readonly deps: DeferredRepositoryPreparationDependencies
}): RepositoryPreparationDescriptorReader {
  return {
    async read(taskId) {
      const row = await createTaskPreparationQueries(input.deps.db).context(taskId)
      if (row === undefined) return { kind: 'terminal-won' }
      if (
        (row.status !== 'pending' && row.status !== 'running') ||
        row.workspacePruningAt !== null ||
        row.workspacePrunedAt !== null
      ) {
        return { kind: 'terminal-won' }
      }
      if (!isTaskWorkspaceUnbound(row.worktreePath)) return { kind: 'ready' }
      const latestPrep =
        (
          await createNodeRunQueries(input.deps.db).listFields(
            {
              taskId,
              nodeId: REPO_PREP_NODE_ID,
              order: 'retry-desc',
              limit: 1,
            },
            ['id'],
          )
        )[0] ?? null
      const requestedSource = row.requestedSource
      const source =
        requestedSource.repoGroupId !== null && requestedSource.repoGroupId.length > 0
          ? ({ kind: 'repo-group', repoGroupId: requestedSource.repoGroupId } as const)
          : requestedSource.cachedRepoId !== null && requestedSource.cachedRepoId.length > 0
            ? ({ kind: 'cached-repo', cachedRepoId: requestedSource.cachedRepoId } as const)
            : null
      if (source === null) {
        throw new ConflictError(
          'repo-prep-source-unavailable',
          `task '${taskId}' has no persisted repository preparation source`,
        )
      }
      return {
        kind: 'prepare',
        descriptor: {
          taskId,
          workflowId: row.workflowId,
          taskName: row.name,
          source,
          workingBranch: row.workingBranch,
          requestedRef:
            source.kind === 'cached-repo' && requestedSource.requestedRef !== ''
              ? requestedSource.requestedRef
              : null,
          spaceKind: row.spaceKind,
          gitCommitIdentity:
            row.gitUserName !== null && row.gitUserEmail !== null
              ? { name: row.gitUserName, email: row.gitUserEmail }
              : null,
          hasPriorAttempt: latestPrep !== null,
        },
      }
    },
  }
}

/** RFC-478：延后准备的执行（`PersistedRepositoryPreparationStep` 的执行端口实现；函数体原样来自 `services/task.ts`）。 */
export function createDeferredRepositoryPreparationMechanics(input: {
  readonly deps: DeferredRepositoryPreparationDependencies
  readonly appHome: string
}): RepositoryPreparationMechanicsPort {
  return {
    async prepare({ descriptor, context }) {
      const task = await getTask(input.deps.db, descriptor.taskId)
      if (task === null) return { kind: 'terminal-won' }
      if (
        descriptor.hasPriorAttempt &&
        !(await hasDurableRepositoryPreparation(input.deps.db, descriptor.taskId))
      ) {
        // RFC-359 W10 —— 这一笔**没有事务体**（`run: () => undefined`），它只是围栏：确认本
        // driver 仍是任务的活 owner（命中 `claimed` 的精确 owner 才放行并推进 revision），
        // 确认不了就不去动上一次准备留下的工件。中立原语一比一顶上——同一笔写事务里做同一次
        // owner CAS，失败仍抛 `task-execution-stale-owner`——于是这条 bun:sqlite 专属的
        // 同步 `withOwnedTaskTx` 在本文件消失。
        const fenceNow = Date.now()
        await withTaskExecutionWrite(input.deps.db, async (tx) => {
          await fenceTaskWrite(tx, {
            taskId: descriptor.taskId,
            context: context.execution,
            now: fenceNow,
          })
        })
        await reclaimStalePrepArtifacts(
          input.deps.repositoryPreparation,
          input.deps.repositoryPreparationLookup,
          input.appHome,
          task,
        )
      }
      const preparationInput = {
        workflowId: descriptor.workflowId,
        name: descriptor.taskName,
        inputs: {},
        ...(descriptor.source.kind === 'repo-group'
          ? { repoGroupId: descriptor.source.repoGroupId }
          : { cachedRepoId: descriptor.source.cachedRepoId }),
        ...(descriptor.workingBranch !== null ? { workingBranch: descriptor.workingBranch } : {}),
        ...(descriptor.requestedRef !== null ? { ref: descriptor.requestedRef } : {}),
      } as unknown as StartTask
      // RFC-478：与 source-control 的 `createMaterializedSpaceCleanup(taskId, null)` 同一个空账本，按 task 自有端口类型构造。
      const cleanup: MaterializedSpaceCleanup = {
        taskId: descriptor.taskId,
        ownedRoot: null,
        worktrees: [],
        state: 'owned',
        report: null,
      }
      const ownership: RepositoryPreparationOwnership = { cleanup }
      const result = await runDeferredRepoPreparation({
        deps: {
          ...input.deps,
          ...(input.deps.launchConfiguration === undefined
            ? {}
            : {
                cloneTimeoutMs: undefined,
                gitBaselineSyncWindowMs: undefined,
                ...(await resolveTaskLaunchRuntimeConfiguration(input.deps.launchConfiguration)),
              }),
          gitCommitIdentity: descriptor.gitCommitIdentity,
        },
        input: preparationInput,
        signal: context.signal,
        taskId: descriptor.taskId,
        prepTaskId: descriptor.taskId,
        task,
        space: {
          kind: 'single',
          spaceKind: descriptor.spaceKind,
          taskId: descriptor.taskId,
          worktreePath: '',
          branch: '',
          baseCommit: null,
          earlyError: null,
          resolvedSources: [],
          repos: [],
          nodePaths: [],
          cleanup,
        },
        ownership,
      })
      return result.ok ? { kind: 'ready' } : { kind: 'terminal-won' }
    },
  }
}

interface RepositoryPreparationOwnership {
  cleanup: MaterializedSpaceCleanup | null
}

/**
 * RFC-287 G7 —— `task_repos` 行的**单一映射**。
 *
 * 延后准备（G7）让这批行有了两个写入时机：预物化路径在落任务行的同一事务里写，
 * 延后路径要等准备完成后回填。两处若各抄一份映射，迟早会走散——而走散的症状极
 * 隐蔽：多仓任务少一列、诊断接口读空、structural diff 拿不到 worktreeDirName。
 */
function taskRepoRowsFor(
  taskId: string,
  materializedRepos: MaterializedRepo[],
  workingBranch: string | null,
): WorkspacePreparationRepositoryProjection[] {
  return materializedRepos.map((r) => ({
    taskId,
    repoIndex: r.repoIndex,
    repoPath: r.repoPath,
    repoUrl: r.repoUrl !== null ? redactGitUrl(r.repoUrl) : null,
    cachedRepoId: r.cachedRepoId,
    baseBranch: r.baseBranch,
    branch: r.branch,
    workingBranch,
    baseCommit: r.baseCommit,
    worktreePath: r.worktreePath,
    worktreeDirName: r.mountPath,
    mountPath: r.mountPath,
    subdir: r.subdir,
    readonly: r.readonly,
    readonlyDirtyCount: null,
    workspaceProfileVersion: r.workspaceProfileVersion ?? null,
    workspaceProfileDigest: r.workspaceProfileDigest ?? null,
    hasSubmodules: r.hasSubmodules,
    submoduleInitOk: r.submoduleInitOk,
    submoduleInitError: r.submoduleInitError,
    schemaVersion: 1,
  }))
}

/**
 * RFC-287 四轮门(用户拍板)—— 重跑准备**之前**,把上一次准备留下的残骸定向清掉。
 *
 * 为什么需要:`materializeSpace` 建完工作树、回填事务提交**之前**进程被 SIGKILL /
 * OOM / 掉电时,磁盘上已经有 `{appHome}/worktrees/{slug}/{taskId}` 与镜像里注册的
 * `agent-workflow/{taskId}` 分支,而 DB 里 `worktree_path` 仍是 `''`。三处 GC 全都
 * 「恰好」跳过它(任务级 GC 判空路径、孤儿回收器按 taskId 判锚定见任务行还在、
 * taskDelete 读空路径),于是 AC-11 的重试每次都逐字撞
 * `fatal: a branch named 'agent-workflow/{taskId}' already exists` ——**永久修不好**,
 * 因为路径与分支名都由**不变的 taskId** 派生(四轮门实测)。
 *
 * 只在**重试**这条路径上做,不动全仓共用的 `createWorktree` 语义(用户在两个候选里
 * 选了这条)。全部失败都只记 warn:清理是尽力而为,真正的判据是紧随其后的建树本身。
 */
async function reclaimStalePrepArtifacts(
  binding: Pick<TaskRepositoryPreparationBinding, 'groupCachedRepoIds'>,
  lookup: RepositoryPreparationLookup,
  appHome: string,
  task: Task,
): Promise<void> {
  const requestedSource = decodeRequestedSource(task)
  // ① 候选镜像:单仓来自 tasks.cached_repo_id;组来自成员的 cachedRepoId。
  const mirrorIds = new Set<string>()
  if (typeof requestedSource.cachedRepoId === 'string' && requestedSource.cachedRepoId.length > 0) {
    mirrorIds.add(requestedSource.cachedRepoId)
  }
  if (typeof requestedSource.repoGroupId === 'string' && requestedSource.repoGroupId.length > 0) {
    try {
      // RFC-478：组成员经准备绑定解析（与绑定的 `groupName` 同源：同一个 `resolveRepoGroupLayout`、同一个仓库工作区存储）。
      for (const cachedRepoId of await binding.groupCachedRepoIds(requestedSource.repoGroupId)) {
        if (cachedRepoId.length > 0) mirrorIds.add(cachedRepoId)
      }
    } catch {
      // 组定义已变/已删——建树那步会给出更准确的错误，这里不抢报。
    }
  }

  // ② 先删目录（git 还认着注册项，prune 才能收掉）。
  //
  // ⚠️ 整段包在 try 里（五轮门 Codex F5）：`readdirSync` 原来裸在任何 try 之外，而
  // 本函数跑在 **CAS 回 pending + attach 租约之后、后台补偿闭包建立之前**。把
  // `{appHome}/worktrees` 换成普通文件（或让 daemon 对它无读权限）就能让它抛
  // ENOTDIR/EACCES ⇒ 异常从 `retryRepoPreparation` 穿出、无人 release 租约 ⇒ 任务
  // 卡在 pending 且 `isTaskActive` 恒真，此后 retry 同时被 active 与 pending 两道门
  // 拒掉，只能修磁盘 + 重启 daemon。「全部失败只记 warn」这句承诺当时并不成立。
  try {
    const worktreesRoot = join(appHome, 'worktrees')
    if (existsSync(worktreesRoot)) {
      for (const slug of readdirSync(worktreesRoot, { withFileTypes: true })) {
        if (!slug.isDirectory()) continue
        const leaf = join(worktreesRoot, slug.name, task.id)
        if (!existsSync(leaf)) continue
        // `await` 而非同步删除（五轮门 Codex F4）：本函数在**请求路径上**
        // （retryRepoPreparation 的后台分叉之前），一个几十 GB / 百万文件的残留
        // worktree 会把 Bun 的单事件循环冻到遍历结束——HTTP 响应、取消请求、
        // deadline timer 全部排在它后面。
        // RFC-356 T4：改走全仓唯一的退避删除原语。这里拿不到该 slug 对应的镜像仓
        // （镜像集合要到下面步骤 ③ 才解析），所以用不上 `reclaimWorktreePath` 的
        // 阶梯第 2 档，只复用第 1 层。
        const reclaimed = await removeDirectoryWithRetry(leaf, { log })
        if (reclaimed.removed) {
          log.info('reclaimed a stale prep worktree before retry', { taskId: task.id, path: leaf })
        } else {
          log.warn('could not remove a stale prep worktree', {
            taskId: task.id,
            path: leaf,
            attempts: reclaimed.attempts,
            error: reclaimed.lastError ?? '',
          })
        }
      }
    }
  } catch (err) {
    log.warn('could not scan worktrees root while reclaiming stale prep state', {
      taskId: task.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ③ 再在每个候选镜像里 prune 注册项 + 删掉按 taskId 派生的隔离分支。
  for (const id of mirrorIds) {
    const localPath = await lookup.findLocalPath(id)
    if (localPath === null || !existsSync(localPath)) continue
    try {
      // `prune` 与 `add` / `remove` 一样会改 common-dir registry，必须走同一把
      // registry 锁（五轮门 Codex F6）：不持锁时，另一个任务正在同一镜像上
      // `worktree add` 的半初始化注册项会被本次 prune 观察到并删掉，让对方的 add
      // 失败或留下不完整 registry——`util/git.ts` 的锁注释里记着这类真实事故。
      await withWorktreeRegistryLock(localPath, () => runGit(localPath, ['worktree', 'prune']))
      // 分支名不止 `agent-workflow/{taskId}`：同一镜像在仓库组里可被挂载多次，
      // 第 2 份起是 `agent-workflow/{taskId}-2`、`-3`…（repoGroupLayout 的去重后缀）。
      // 只删不带后缀那条，会让第二仓的建树永远撞 "branch already exists"、每次重试
      // 复现、无法自愈（五轮门 Codex F3）。按前缀枚举全删。
      // RFC-356 T4：先清陈旧的 ref lock。被 abort 掐掉的 `git worktree add` 会留下
      // `refs/heads/agent-workflow/{taskId}.lock`，而仓内此前**没有任何生产路径清它**
      // ——下一次在同一分支名上建树就永远撞 `cannot lock ref … File exists`，与 issue #13
      // 同形（残留物挡住重建、且无自愈路径）。锁挡住的 ref 未必存在，所以 for-each-ref
      // 看不到它，必须按前缀直接扫锁文件。只删 60s 之前落的锁，不抢活着的 git。
      const locksCleared = await reclaimStaleRefLocks({
        repoPath: localPath,
        branchRef: `agent-workflow/${task.id}*`,
        log,
      })
      if (locksCleared > 0) {
        log.info('reclaimed stale branch ref locks before retry', {
          taskId: task.id,
          count: locksCleared,
        })
      }
      const listed = await runGit(localPath, [
        'for-each-ref',
        '--format=%(refname)',
        `refs/heads/agent-workflow/${task.id}`,
        `refs/heads/agent-workflow/${task.id}-*`,
      ])
      for (const ref of listed.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)) {
        await runGit(localPath, ['update-ref', '-d', ref])
        log.info('reclaimed a stale prep branch before retry', { taskId: task.id, ref })
      }
    } catch (err) {
      log.warn('could not reclaim stale prep git state', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * RFC-287 G7 —— 仓库准备（任务的「第 0 步」），**单一实现**。
 *
 * 两个调用方共用它：正常启动的后台续跑，以及 AC-11 的「重试准备仓库」。抄第二份是
 * 不可接受的——这段里有窗口化重试、两种失败形态、回填与路径回写的同事务约束、租约
 * 换真、以及取消竞速下的状态保留，任何一项走散都只在故障路径上现形。
 *
 * 返回 `ok:false` 表示准备失败且**已记账**（合成行 failed、任务 failed、租约已释放），
 * 调用方不得再往下走调度。
 */
async function prepareLegacyDeferredWorkspace(
  input: StartTask,
  deps: DeferredRepositoryPreparationDependencies,
  taskId: string,
  signal: AbortSignal,
): Promise<MaterializedSpace> {
  const options = {
    ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
    ...(deps.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: deps.cloneTimeoutMs }),
    ...(deps.workspaceCleanupHook === undefined
      ? {}
      : { workspaceCleanupHook: deps.workspaceCleanupHook }),
  }
  // RFC-478：绑定必填，「无绑定」时直调 source-control 物化的回落（没有调用方）删除。
  return deps.repositoryPreparation.legacy.prepare({
    task: input,
    taskId,
    signal,
    gitCommitIdentity: deps.gitCommitIdentity ?? null,
    loadFrozenSpaceLayout: deps.loadFrozenSpaceLayout,
    ...options,
  })
}

async function runDeferredRepoPreparation(args: {
  deps: DeferredRepositoryPreparationDependencies
  input: StartTask
  signal: AbortSignal
  taskId: string
  prepTaskId: string
  task: Task
  space: MaterializedSpace
  ownership: RepositoryPreparationOwnership
}): Promise<{ ok: boolean; preparedTask: Task | null }> {
  const { deps, input, signal, taskId, prepTaskId, task, space, ownership } = args
  // 第 0 步：仓库准备。失败不抛给 HTTP（此刻请求早已返回），而是把任务转
  // `failed` 并把 git 原文留在行上——这正是 G7 要的「失败可见」。
  //
  // 合成一条 `__repo_prep__` node_run（同 `__commit_push__` 先例）：它不是工作流
  // 里的节点，而是框架自己的一步，但用户必须能在时间线上看到它——否则看到的就是
  // 一个「pending 了很久然后 failed」的任务，不知道卡在克隆、更不知道该重试什么。
  // 有了这一行，「重试准备仓库」直接复用既有的 retryNode，不必造第二套重试语义。
  // 先 pending 再转 running：RFC-098 修订 #10 的护栏禁止顶层行「born-running」
  // ——那样的行对 frontier 不可见，恢复扫描也认不出来。合成行不能例外。
  //
  // retryIndex / cause 按**既有的准备行**推导，不能写死 0/'initial'（三轮门 Codex
  // 契约面 P2）：AC-11 每重试一次都从这里再铸一行，写死的话三次尝试全部落成
  // 「第 0 次、首次」，API 原样吐出这两列、UI 的「重试」列连着显示 0——执行是对的，
  // 但历史永久记成假事实，审计、诊断与按 retryIndex 排序的调用方全被打乱。
  // `topLevelOnly` 不需要：准备行没有父行；同理 iteration 恒 0。
  const priorPrepRuns = await createNodeRunQueries(deps.db).listFields(
    { taskId, nodeId: REPO_PREP_NODE_ID },
    ['retryIndex'],
  )
  const prepRetryIndex = nextRetryIndex(priorPrepRuns)
  const prepRunId = await mintNodeRun(deps.db, {
    ...nodeRunMintIdentityForSlot(
      {
        kind: 'synthetic',
        syntheticKind: 'repo-prep',
        owner: { kind: 'task', id: taskId },
        discriminator: REPO_PREP_NODE_ID,
      },
      { kind: 'current' },
    ),
    taskId,
    nodeId: REPO_PREP_NODE_ID,
    status: 'pending',
    cause: prepRetryIndex === 0 ? 'initial' : 'retry-node',
    retryIndex: prepRetryIndex,
    iteration: 0,
  })
  await setNodeRunStatus({
    db: deps.db,
    nodeRunId: prepRunId,
    to: 'running',
    allowedFrom: ['pending'],
    reason: 'repo-prep-start',
    extra: {},
  })
  const executionContext = currentTaskExecutionContext(taskId)
  const prepEffect =
    executionContext === undefined
      ? undefined
      : createLocalEffectAttemptObserver({
          persistence: executionContext.persistence.effects,
          taskId,
          nodeRunId: prepRunId,
          kind: 'workspace-prepare',
          stableActionOrdinal: 'workspace-prepare:task-root',
          candidateId: 'deferred-repository-preparation',
          request: {
            v: 1,
            taskId,
            workflowId: input.workflowId,
            repositorySource:
              input.repoGroupId !== undefined
                ? 'group'
                : input.repoUrl !== undefined || input.cachedRepoId !== undefined
                  ? 'single'
                  : input.sourceTaskId !== undefined
                    ? 'source-task'
                    : 'scratch',
            spaceKind: space.spaceKind,
          },
          resourceKeys: [`workspace-prepare:${taskId}`],
          context: executionContext,
        })
  await prepEffect?.beforeAct()
  const settlePrepFailure = async (error: unknown, phase: string): Promise<void> => {
    try {
      await prepEffect?.fail(error, { phase })
    } catch (settleError) {
      log.warn('repository preparation effect failure receipt was fenced', {
        taskId,
        phase,
        error: settleError instanceof Error ? settleError.message : String(settleError),
      })
    }
  }
  // 准备失败有**两种形态**，都要落到行上：
  //   · `earlyError` —— 物化自己吞下的失败（建工作树、多仓挂载…）；
  //   · **抛出** —— `resolveCachedRepo` 的超时/锁/校验失败走 DomainError
  //     （实测：克隆超时抛 `repo-cache-locked` 504，压根不经 earlyError）。
  // 只接前者会让最常见的一类失败（拉不动远端）重新变回「什么都不留」。
  //
  // RFC-287 G6：网络类失败在**总容忍窗口**内退避重试（默认 60s，可配，0=关闭）。
  // 用总窗口而不是固定次数——用户关心「最多等多久」，不关心「重试几次」。
  // 鉴权 / 仓库不存在 / 无权限**不占窗口**，立刻失败：让用户 1 秒内看到
  // 「你写错地址了」，而不是等满 60 秒再告诉他同一件事。
  //
  // 窗口约束的是**重试等待**，不是单次克隆——proposal §2 G6 明写「一次正在推进
  // 的克隆不打断」。所以一个 500MB 的仓在 60s 窗口下照样能克隆十分钟：管单次
  // 时长的是另一个旋钮 `gitCloneTimeoutMs`。两者职责不同，别拿窗口去掐克隆。
  // （T14 实现门按「窗口=墙钟总时长」读它并报为缺陷，这里把契约写死免得再议。）
  const syncWindowMs = deps.gitBaselineSyncWindowMs ?? 60_000
  const windowDeadline = Date.now() + syncWindowMs
  let prepared: MaterializedSpace
  let backoffMs = 1_000
  for (;;) {
    try {
      // RFC-359 AC-1（plan §5hn 批次二 ①）：直接打中立物化面。RFC-478：只经装配方交来的准备绑定——日志化准备走
      // `prepareDurableRepositoryWorkspace`，其余走绑定的 `legacy.prepare`——这一步不认识任何引擎。
      const durable = await prepareDurableRepositoryWorkspace({
        db: deps.db,
        binding: deps.repositoryPreparation,
        taskId,
        gitCommitIdentity: deps.gitCommitIdentity ?? null,
        ...(input.workingBranch === undefined ? {} : { workingBranch: input.workingBranch }),
        signal,
      })
      prepared = durable ?? (await prepareLegacyDeferredWorkspace(input, deps, prepTaskId, signal))
    } catch (err) {
      prepared = {
        ...space,
        // 用**完整诊断**而不是裸 message：warm 路径把 git stderr 放在 details 里。
        earlyError: diagnosticTextOf(err),
      }
    }
    if (prepared.earlyError === null) break
    // 先判可重试性、再看窗口——反过来会让永久失败也白白消耗一次退避。
    if (!isRetryableGitFailure(prepared.earlyError)) break
    const remaining = windowDeadline - Date.now()
    if (remaining <= 0) break
    // 退避本身就会把窗口睡穿时，不要「睡满再开一次新尝试」——那一次是在窗口
    // 已经耗尽之后才起步的，既拖长用户等待，也让「最多等 W」这句话不成立。
    // 窗口内还睡得下才继续（T14 实现门）。
    if (backoffMs >= remaining) break
    log.warn('repo preparation failed with a retryable network error; retrying within window', {
      taskId,
      remainingMs: remaining,
      error: prepared.earlyError,
    })
    await prepEffect?.retry(new Error(prepared.earlyError), 'transport-policy')
    if (signal.aborted) break
    await new Promise<void>((resolve) => {
      const settle = (): void => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        clearTimeout(timer)
        settle()
      }
      const timer = setTimeout(settle, Math.min(backoffMs, remaining))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    backoffMs = Math.min(backoffMs * 2, 15_000)
  }
  if (prepared.earlyError !== null && signal.aborted) {
    // 停机与用户取消**共用同一个信号**，但归宿完全相反（三轮门并发面抓到的回归：
    // 本分支上一版只判 `aborted`，把优雅停机也当成用户取消）。
    //
    // RFC-202 T4 的既有约定写在 `scheduler.ts` 的同名判据里：`DAEMON_SHUTDOWN_ABORT_REASON`
    // 必须落 `interrupted` + daemon-restart 摘要，好让 Resume 与 boot auto-resume 都能
    // 接得住——「daemon 重启」不是用户决定。判成 canceled 的后果是**永久楔死**：准备行
    // 落终态 canceled，boot reap 把任务翻 interrupted 却改不动已终态的行，而
    // `RETRYABLE_PREP_STATUSES` 只认 failed/interrupted ⇒ 重试撞 `repo-prep-not-retryable`、
    // resume 撞 `task-repo-prep-incomplete`、auto-resume 按设计跳过，只剩删任务重开。
    // 这恰好把下面 AC-16 那扇刚修好的门（认 interrupted）从 canceled 这一侧又打开了。
    const daemonShutdown = isDaemonInterruptionAbortReason(signal.reason)
    // RFC-287 AC-14 —— **取消导致的失败不是失败**。
    //
    // 三轮门 AC 对账实测（该 AC 此前一条测试都没有）：在准备窗口内点取消，git 子
    // 进程确实被打断了（288ms 就回来，不是等 clone 自己超时），可紧接着准备段把
    // 这次中止**当成普通 git 失败**，抢先把 `pending → failed` CAS 成功；等
    // `cancelTask` 回过头来写 `canceled` 时任务已是终态，于是保留 failed。用户点了
    // 取消，得到的却是一个「失败」的任务，还附着一句 git 中止的错误——归因完全错误，
    // 且 AC-14 要求的 canceled 落不下来。
    //
    // 下面那段竞速保护（CAS 抛出即保留既有终态）挡不住这一种：它防的是「取消**先**
    // 写成功」，而这里是「取消还没来得及写」。判据只能是信号本身。
    //
    // 处置：合成行落 canceled（不能留在 running——恢复扫描会把它当还在跑），任务
    // 状态**不碰**，交给 cancelTask 按它自己的流程终结；租约照常释放，否则取消之后
    // 这行任务的每次重试都撞 `task-still-running`。
    await settlePrepFailure(new Error(prepared.earlyError), 'aborted')
    try {
      await setNodeRunStatus({
        db: deps.db,
        nodeRunId: prepRunId,
        // 停机 ⇒ interrupted（保持可重试，与 boot reap 对齐）；用户取消 ⇒ canceled。
        to: daemonShutdown ? 'interrupted' : 'canceled',
        allowedFrom: ['running'],
        reason: daemonShutdown ? 'repo-prep-daemon-shutdown' : 'repo-prep-canceled',
        extra: {
          identity: {
            finishedAt: Date.now(),
          },
        },
      })
    } catch (err) {
      log.warn('repo-prep row already terminal when recording cancel', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const cur = await createTaskPreparationQueries(deps.db).status(taskId)
    return {
      ok: false,
      preparedTask: {
        ...task,
        status:
          (cur?.status as TaskStatus | undefined) ?? (daemonShutdown ? 'pending' : 'canceled'),
      },
    }
  }
  if (prepared.earlyError !== null) {
    // 租约释放必须在 finally 里——两个写点都是**会抛**的 CAS：任务在准备窗口内
    // 被取消时，`setTaskStatus` 见到 terminal 的 'canceled' 会抛
    // ConflictError('illegal-task-transition')（lifecycle.ts 的终态保护），
    // 直着写就会跳过下面的 release，把驱动租约永久漏在注册表里——此后这个任务
    // 的每次重试都撞 `task-still-running`，只有重启 daemon 能解。
    //
    // 我原先那句注释「CAS 失败即放弃，不覆写」把语义写反了：不覆写是对的，但它
    // 是**靠抛出**实现的，不是靠静默返回。（T14 实现门）
    await settlePrepFailure(new Error(prepared.earlyError), 'failed')
    try {
      // 合成行先落 failed，且 errorMessage 是 git 的原话——时间线上点开这一步能
      // 看到「fatal: unable to access …」，而不是一句无从下手的「启动失败」。
      await setNodeRunStatus({
        db: deps.db,
        nodeRunId: prepRunId,
        to: 'failed',
        allowedFrom: ['running'],
        reason: 'repo-prep-failed',
        extra: {
          identity: {
            finishedAt: Date.now(),
            errorMessage: prepared.earlyError,
          },
        },
      })
    } catch (err) {
      // 取消路径已经把这条合成行终结过了——不是错误，记一笔即可。
      log.warn('repo-prep row already terminal when recording failure', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    let finalStatus: TaskStatus = 'failed'
    try {
      // 走 RFC-097 的 CAS 写点：allowedFrom 只放 pending——准备阶段任务必然还在
      // pending（G7 不新增状态）。已取消/已推进时抛出，此时**保留既有终态**。
      await setTaskStatus({
        db: deps.db,
        taskId,
        to: 'failed',
        allowedFrom: ['pending'],
        reason: 'repo-prep-failed',
        extra: {
          finishedAt: Date.now(),
          errorSummary: `repo preparation failed: ${prepared.earlyError}`,
          errorMessage: prepared.earlyError,
        },
      })
    } catch (err) {
      // 取消赢了这场竞速：任务已是 canceled，不得被准备失败改写成 failed。
      // 回给调用方的状态也必须是库里的真值，不能一律报 failed。
      const cur = await createTaskPreparationQueries(deps.db).status(taskId)
      finalStatus = (cur?.status as TaskStatus | undefined) ?? 'failed'
      log.warn('task left prep window before failure could be recorded; keeping current status', {
        taskId,
        status: finalStatus,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // B-F8 的回收**不能放在这里**——这一点是实测逼出来的。
    //
    // 准备失败只是任务进入 `failed`，它随时可能被 AC-11 的「重试准备」拉起来，
    // 而重试要靠 `tasks.cached_repo_id` 重建来源。在失败点就把身份行删掉，等于
    // 亲手拆掉刚为 AC-11 建起来的地基（实测：删完之后重试撞 cached-repo-not-found）。
    //
    // 正确的回收时机是**任务真正离场**（删除任务 / 工作区 GC 回收），那时才没人
    // 会再重试它。已登记进 audit-backlog，随下一个 RFC 落到 gc.ts 的既有清扫里。
    return { ok: false, preparedTask: { ...task, status: finalStatus } }
  }
  // 二轮实现门 B-F2 / AC-14：**回写之前复检任务状态**。
  //
  // 取消与准备成功是一对竞速：`cancelTask` 先 abort、最多等 5 秒再写 canceled，而
  // 物化可能恰好在这段里成功返回。没有这道复检的话，下面那个事务会**无条件按 id**
  // 把路径与仓库字段写进一个已经 canceled 的任务，并把合成准备行置成 done——用户
  // 明明取消了，界面上却出现一个「准备完成」的已取消任务，随后 `runTask` 认领时才
  // 被拦下。AC-14 原文要求「回写与 kick 前的状态 CAS 复检，已取消任务不得被准备
  // 完成拉起执行」。
  //
  // 复检发现任务已离开 pending 时：物化产物必须**当场清理**（它已经建出了工作树，
  // 但再也不会有任务行锚定它——不清就是孤儿目录），然后按当前真实状态收场。
  const stillPending = (await createTaskPreparationQueries(deps.db).status(taskId))?.status
  // ⚠️ 判据必须**同时**看信号，不能只看任务状态（四轮门 Codex 并发面实测）。
  //
  // `cancelTask` 是「先 abort、最多等 5 秒、再写 canceled」。若物化恰好在这段窗口里
  // **成功**返回（大仓在 gitignore 预置那步慢一点就够），`earlyError` 是 null ⇒ 上面
  // 的取消分支被跳过；而此刻任务状态还是 pending ⇒ 这道复检也放行 ⇒ 按 id 无 CAS 地
  // 回填 tasks/task_repos/task_space_nodes、把准备行写成 done、还点火 scheduler。
  // 终局是 `task=canceled` 但 `__repo_prep__=done`、路径与仓库投影都已落库、调度器
  // 确实起来过——AC-14 的「取消不得完成准备或 kick」没有兑现。
  // 信号一旦 aborted，无论任务行有没有写完，这次准备的产物都不该落库。
  if (stillPending !== 'pending' || signal.aborted) {
    log.warn('task left the prep window before backfill; discarding the materialized space', {
      taskId,
      status: stillPending ?? '(gone)',
    })
    // 走既有的清理定式（同 startTask 的 catch 分支）：cleanup 是**账本数据**而不是
    // 函数，真正执行清理的是 `cleanupMaterializedSpaceLease`。
    try {
      const durableCleanup = await cleanupDurableRepositoryWorkspace({
        db: deps.db,
        binding: deps.repositoryPreparation,
        taskId,
        gitCommitIdentity: deps.gitCommitIdentity ?? null,
        ...(input.workingBranch === undefined ? {} : { workingBranch: input.workingBranch }),
        signal,
      })
      // RFC-478：非日志化准备的清理改经绑定（即 `cleanupMaterializedSpaceLease(space.cleanup, hook)`，外加一次只对 scratch 有效的
      // 登记清除；延后准备的来源只有缓存仓 / 仓库组）。
      const report =
        durableCleanup ??
        (await deps.repositoryPreparation.legacy.cleanup(prepared, deps.workspaceCleanupHook))
      if (!report.complete) {
        log.warn('orphaned materialized space only partially cleaned', {
          taskId,
          failures: report.failures.length,
        })
      }
    } catch (err) {
      log.warn('failed to clean up the orphaned materialized space', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    await settlePrepFailure(new Error('task left repository preparation window'), 'discarded')
    // 三轮门并发面抓到的两条，同一个出口上：
    //
    // **F4——准备行不能留在 running**。本分支此前只清物化产物就返回，那条合成行永远
    // 停在 running。同一函数的取消分支注释里已经写明理由（恢复扫描会把它当还在跑），
    // 这里漏了。状态跟着任务的真实归宿走：任务 interrupted ⇒ 行也 interrupted（保持
    // 可重试）；其余（canceled / 被删）⇒ canceled。
    const leftStatus =
      (stillPending ?? '') === 'interrupted' || signal.reason === DAEMON_SHUTDOWN_ABORT_REASON
        ? 'interrupted'
        : 'canceled'
    try {
      await setNodeRunStatus({
        db: deps.db,
        nodeRunId: prepRunId,
        to: leftStatus,
        allowedFrom: ['running'],
        reason: 'repo-prep-task-left-window',
        extra: {
          identity: {
            finishedAt: Date.now(),
          },
        },
      })
    } catch (err) {
      log.warn('repo-prep row already terminal when task left the prep window', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    // **F1——租约必须还回去**。这是本函数**唯一**一条不还租约的出口（失败分支有
    // finally、取消分支显式 release、成功分支交给 runTask 的 finally）。首启路径侥幸
    // 被外层闭包的 finally 兜住，**重试路径没有那层**（它把 runTask 用 void 发出去，
    // 不能无条件在闭包里 release，否则会在 runTask 还在跑时把租约放掉）。
    //
    // 漏掉的后果是任务**永久楔死**：`isTaskActive` 恒真 ⇒ retryNode / resume 409
    // `task-still-running`、deleteTask 409 `task-active`、lifecycle 修复被
    // liveness gate 拒、orphanReconcile 与 gc 永久跳过它、`awaitTaskDriverStopped`
    // 永不 resolve（终止参与者跟着挂死）。只有重启 daemon 能解。
    return { ok: false, preparedTask: (await getTask(deps.db, taskId)) as Task }
  }
  // 所有权租约换成真的：占位态给的是空租约（ownedRoot=null、零 worktree），
  // 物化成功后必须换成 materializeSpace 产出的那份，否则清理/回滚协议管不到
  // 刚建出来的工作树——任务删除时会留下孤儿目录。
  ownership.cleanup = prepared.cleanup
  // 回填：占位落行时仓库尚未物化，目录只有根；准备结算补齐成员目录。
  // 与任务行的路径回写放进**同一个事务**——多仓任务的 repos 与 tasks.workspaceRootRef
  // 必须同时可见，否则一个恰好落在中间的读者（诊断接口、structural diff、前端
  // 详情页）会看到「有工作树但没有成员仓」这种不存在的状态。
  //
  // RFC-395：主仓 DTO 与 repoCount 从有序挂载投影；冻结 requested_source 保持原请求。
  // 根引用、空间属性与所有挂载必须共同回填，读取端才能同时看到完整主仓与成员数量。
  const preparedHead = prepared.repos[0]
  const preparedRepoRows = taskRepoRowsFor(taskId, prepared.repos, input.workingBranch ?? null)
  const preparedFinishedAt = Date.now()
  // RFC-359 W10 —— 回填投影改走中立写事务（`withTaskExecutionWrite` → `databaseSessionFor`），
  // 事务边界与「四件事同生共死」的语义一格不动，只是不再依赖 bun:sqlite 专属的同步 `dbTxSync`。
  // 体内每一条语句都必须 `await`：`.run()` 在 PostgreSQL 上不 await 就是一个没人等的 Promise，
  // 语句要么落在事务外、要么根本不发，而两边都不会抛。
  const persistPreparedProjection = async (tx: PersistenceTx): Promise<void> => {
    await acceptDurableRepositoryWorkspace(tx, taskId)
    await createTaskPreparationParticipantInTx(tx).writeWorkspace({
      taskId,
      worktreePath: prepared.worktreePath,
      branch: prepared.branch,
      baseCommit: prepared.baseCommit,
      spaceKind: prepared.spaceKind,
      repositories: preparedRepoRows.map(
        ({
          taskId: _taskId,
          repoIndex,
          worktreeDirName: _directory,
          schemaVersion: _version,
          ...mount
        }) => ({ ...mount, ordinal: repoIndex }),
      ),
      nodePaths: prepared.nodePaths,
    })
    // 准备行置 done **并入同一事务**（五轮门 Codex 数据完整性面 F2，用户拍板）。
    //
    // 原先它是事务外的下一次 await，于是「三张投影表已提交、prep 行还是 running」
    // 是一段必经的中间态。崩溃落在那里之后：boot reap 把 task 与 prep 都翻
    // interrupted；auto-resume 见 worktreePath 非空 ⇒ 走普通 resume（不是 prep 重试）；
    // 调度器又把不在 workflow scope 里的 prep 行过滤掉 ⇒ 任务可以跑完全部业务节点，
    // 而审计历史上永久留着「仓库准备被中断」。这也直接违反 AC-10 的「prep done 之后
    // 才有工作树」——回填后工作树已在，而 prep 没 done。
    // 同一事务之后这个组合不可达。
    await setNodeRunStatusInTransaction({
      tx,
      nodeRunId: prepRunId,
      to: 'done',
      allowedFrom: ['running'],
      reason: 'repo-prep-done',
      extra: {
        identity: {
          finishedAt: preparedFinishedAt,
        },
      },
    })
  }
  const preparationReceipt = {
    phase: 'prepared',
    repoCount: prepared.repos.length,
    spaceKind: prepared.spaceKind,
  } as const
  if (prepEffect === undefined) {
    await withTaskExecutionWrite(deps.db, persistPreparedProjection)
  } else {
    await prepEffect.succeedWorkspacePreparation(preparationReceipt, {
      taskId,
      prepNodeRunId: prepRunId,
      finishedAt: preparedFinishedAt,
      task: {
        worktreePath: prepared.worktreePath,
        branch: prepared.branch,
        baseCommit: prepared.baseCommit,
        repoPath: preparedHead?.repoPath ?? '',
        repoUrl:
          preparedHead?.repoUrl !== null && preparedHead?.repoUrl !== undefined
            ? redactGitUrl(preparedHead.repoUrl)
            : null,
        cachedRepoId: preparedHead?.cachedRepoId ?? null,
        baseBranch: preparedHead?.baseBranch ?? '',
        repoCount: Math.max(1, prepared.repos.length),
      },
      repositories: preparedRepoRows,
      nodePaths: prepared.nodePaths,
    })
  }
  // 响应体重读一次：它是在准备之前、用占位值构造的，直接返回会让调用方拿到空
  // worktreePath——前端据此显示空路径，脚本据此写文件会写到错地方（实测：HTTP
  // 契约测试往空路径写文件，diff 自然为空）。回填已落库，重读即得真实值，比在
  // 这里手抄一份投影更不容易走散。
  return { ok: true, preparedTask: (await getTask(deps.db, taskId)) as Task }
}
