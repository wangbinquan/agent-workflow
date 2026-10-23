import {
  createNodeRunQueries,
  createNodeOutputQueries,
} from '@/modules/task-execution/public/queries'
import type {
  NodeRunFactSnapshot,
  NodeRunCheckpointSnapshot,
} from '@/modules/task-execution/public/queries'
import { deriveNodeRunRole } from '@/modules/task-execution/public/types'
import { isTaskWorkspaceUnbound } from '@agent-workflow/shared'
import { decodeRequestedSource } from '@/platform/persistence/taskRepositorySurface'
import {
  createTaskDetailQueries,
  createTaskPreparationQueries,
  createTaskTriggerQueries,
} from '@/modules/task-execution/public/queries'
import { createTaskPreparationParticipantInTx } from '@/modules/task-execution/public/participants'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  type MaterializedRepo,
  type MaterializedSpace,
  type WorkspaceCleanupHookEvent,
  type MaterializedSpaceCleanup,
  createMaterializedSpaceCleanup,
  cleanupMaterializedSpaceLease,
  type PlannedSpaceLayout,
  materializeSpaceWithProvider,
  createFileWorkspacePresenceQueries,
  composeWorkspaceMaintenanceCommand,
} from '@/modules/source-control/composition'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
// Task service — continuation and retained read projections.
// Cancel/resume/retry land in P-1-15 + M3 (P-3-08, P-3-09).

import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { assertWorktreePresentForResume } from '@/modules/task-execution/public/participants'
import {
  resolveTaskLaunchRuntimeConfiguration,
  resolveTaskSubagentLiveCapture,
  type TaskLaunchConfigurationQueries,
} from '@/modules/task-execution/public/queries'
import type {
  ScriptLanguage,
  GitCommitIdentity,
  FailureCode,
  StartTask,
  Task,
} from '@agent-workflow/shared'
import type { DwState } from '@agent-workflow/shared'
import {
  isRetryableGitFailure,
  DAEMON_SHUTDOWN_ABORT_REASON,
  isDaemonInterruptionAbortReason,
  REPO_PREP_NODE_ID,
  WorkflowDefinitionSchema,
  allowedFromForTaskEvent,
  diffWorkflowForSync,
  isTerminalNodeRunStatus,
  migrateWorkflowDefinitionToLatest,
  planCanonicalWorkflowLayout,
  parseTriggerContextJson,
} from '@agent-workflow/shared'
import type {
  Language,
  NodeRunStatus,
  NodeRunSyncSummary,
  TaskStatus,
  TaskTransitionEvent,
  Workflow,
  WorkflowDefinition,
  WorkflowSyncPreview,
} from '@agent-workflow/shared'
import {
  eq,
  type LegacySqliteTaskDatabase,
  type LegacyProviderNeutralDatabase,
} from '@/modules/task-execution/infrastructure/legacySqliteTransportMechanisms'
import { existsSync, readdirSync } from 'node:fs'

import { join } from 'node:path'
import { ulid } from 'ulid'
import { setDwStateTx } from '@/services/workgroup/state'
import type { SecretBox } from '@/auth/secretBox'

import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import { materializingSpaces } from '@/platform/workspace/materializingSpaces'
import { rollbackNodeRunWorktrees } from '@/services/nodeRollback'
import { composeGateContinuationPreDrive } from '@/modules/task-execution/composition/gateContinuationPreDrive'
import type { RollbackOutcome, RollbackRunRow } from '@/services/nodeRollback'
import { killStaleRunProcessTree } from '@/util/process'
import type { StaleRunKillOutcome } from '@/util/process'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import type { RuntimeSessionLeaseOperations } from '@/modules/task-execution/application/ports/runtimeSessionLeaseOperations'
import {
  createLocalEffectAttemptObserver,
  currentTaskExecutionContext,
  fenceTaskWrite,
  taskExecutionModule,
  withTaskExecutionWrite,
  type TaskExecutionIntentKind,
  type TaskExecutionIntentSource,
  TaskExecutionError,
} from '@/services/taskExecutionParticipants'
import { repairRuntimeSessionLeasesAfterOrphanReap } from '@/services/runtimeSessionLease'
import { recordRecoveryEvent } from '@/services/recovery'
import { setNodeRunStatus, setTaskStatus, transitionTaskStatusByEvent } from '@/services/lifecycle'
// RFC-359 W10 —— 中立异步孪生（两个引擎共用），从 public 合同出去；与 `@/services/lifecycle`
// 上同名的 bun:sqlite 专属**同步**版按名字区分开。
import {
  setNodeRunStatusInTransaction,
  submitTaskContinuationInTransaction,
} from '@/modules/task-execution/public/participants'
import type { TaskStatusUpdateExtra } from '@/services/lifecycle'
import { nextRetryIndex, mintNodeRun } from '@/services/nodeRunMint'
import { createRunSelectionOracleSnapshot } from '@/modules/task-execution/public/queries'
import { reclaimStaleRefLocks, runGit, withWorktreeRegistryLock } from '@/util/git'
import { removeDirectoryWithRetry } from '@/util/fsReclaim'
import { redactGitUrl } from '@agent-workflow/shared'
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  diagnosticTextOf,
} from '@/util/errors'
import type { SchedulerDriverPort } from '@/modules/task-execution/public/commands'
import { Paths } from '@/util/paths'
import { createLogger, type Logger } from '@/util/log'
import { resolveRepoGroupLayout } from '@/services/repoGroup'
import {
  composeSqliteRepositoryWorkspaceStore,
  type RepositoryWorkspaceStore,
} from '@/modules/source-control/composition'
import {
  builtinWorkflowSyncPreview,
  workflowSyncGateReason,
} from '@/modules/task-execution/public/participants'
import { SYSTEM_USER_ID } from '@/auth/actor'
import { freezeTaskExecutionCallClosure } from '@/services/execution/taskExecutionCallClosure'
import type { TaskExecutionResourceAuthority } from '@/services/execution/taskExecutionResources'
import { triggerPreflightIssue } from '@/services/execution/triggerPreflight'
import { assertFrozenTaskTriggerPreflight } from '@/modules/task-execution/infrastructure/frozenTaskTriggerPreflight'
import { collectExecutionRefs } from '@agent-workflow/shared'
import {} from '@/services/taskAuthorization'
import { composeAgentRunDistillObserver } from '@/modules/task-execution/composition/agentRunDistillObserver'
import { selectResumeRollbackTargets as selectResumeRollbackTargetsWithSelection } from '@/modules/task-execution/application/resumeRollbackTargets'
import * as taskDriveComposition from '@/modules/task-execution/composition/taskDriveLegacy'

type WorkspacePreparationRepositoryProjection = Parameters<
  NonNullable<ReturnType<typeof createLocalEffectAttemptObserver>>['succeedWorkspacePreparation']
>[1]['repositories'][number]
type RepositoryPreparationStep = taskDriveComposition.RepositoryPreparationStep
type RepositoryPreparationDescriptorReader =
  taskDriveComposition.RepositoryPreparationDescriptorReader

const {
  activeTaskDriverController,
  awaitTaskDriverReleasedSettled,
  awaitTaskDriverIdle,
  createDatabaseTaskDriverLifecyclePort,
  createTaskDriveCoordinatorFactory,
  createTaskExecutionPersistence,
  isTaskDriverActive,
  PersistedRepositoryPreparationStep,
  skipRepositoryPreparation,
} = taskDriveComposition

type TaskDriveRequest = Parameters<SchedulerDriverPort['drive']>[0]
type TaskDriveRuntimeOptions = Omit<TaskDriveRequest, 'taskId' | 'executionContext' | 'signal'>

/**
 * RFC-243 / RFC-345 T4a — closure freezing needs the exact Resource Catalog
 * authority captured for this launch. Call-node-free definitions skip the
 * participant (byte-compat); a call-bearing launch without that binding fails
 * closed instead of returning to the legacy live-row resolver.
 */
async function freezeClosureForLaunch(
  deps: Pick<TaskContinuationDependencies, 'launchResources'>,
  workflowId: string,
  definition: WorkflowDefinition,
): Promise<string | null> {
  const refs = collectExecutionRefs(definition)
  if (refs.workflowNames.size === 0 && refs.workgroupNames.size === 0) return null
  if (deps.launchResources === undefined) {
    throw new ValidationError(
      'workflow-call-ref-missing',
      'call-node launches require an authenticated resource authority for closure resolution',
    )
  }
  return await freezeTaskExecutionCallClosure({ id: workflowId, definition }, deps.launchResources)
}

const log = createLogger('task')

const taskDriverRegistry = taskExecutionModule.runtimeRegistry

function continuationSource(
  deps: TaskContinuationDependencies,
  kind: TaskExecutionIntentKind,
): TaskExecutionIntentSource {
  if (kind === 'gate-continuation') return 'internal'
  if (deps.actorUserId !== undefined && deps.actorUserId !== SYSTEM_USER_ID) return 'rest'
  if (deps.scheduledTaskId !== undefined) return 'scheduler'
  return deps.internalSource !== undefined || deps.callLaunch !== undefined ? 'internal' : 'auto'
}

/**
 * Submit the canonical continuation in the SAME transaction as the lifecycle
 * admission CAS.  The caller supplies a stable id before entering the
 * transaction so a lost CAS cannot leak an orphan wake or side effect.
 */
/**
 * RFC-359 —— 续跑 intent 的准入参与者，跑在**中立**事务句柄上。
 * 与 `submitTaskContinuationTx`（bun:sqlite 专属同步面）是同一套判据的两种解释；
 * `setTaskStatus` 的写事务搬到显式边界之后，这里的 `onTransitionTx` 回调用的是这一侧。
 */
async function submitContinuationIntentInTx(input: {
  tx: PersistenceTx
  taskId: string
  intentId: string
  kind: TaskExecutionIntentKind
  source: TaskExecutionIntentSource
  actorUserId: string | null
  payload: Readonly<Record<string, unknown>>
  now: number
  advanceOperationGeneration: boolean
}): Promise<void> {
  await submitTaskContinuationInTransaction(input.tx, input)
}

/** RFC-097 (audit S-8/S-23): is an in-process scheduler loop attached to this
 *  task right now? Used by resume/retry entry rejection and lifecycleRepair's
 *  scheduler-liveness preflight. */
export function isTaskActive(taskId: string): boolean {
  return isTaskDriverActive(taskId)
}

/**
 * P-4-06: abort every in-flight task. Used by daemon shutdown. The runner
 * SIGTERMs each opencode child via the controller's signal; the scheduler
 * then marks rows canceled/interrupted in the normal flow.
 *
 * RFC-202 T4: `reason` rides on the AbortController
 * (`controller.abort(reason)` → `signal.reason`) so the scheduler's abort
 * checkpoints can tell a daemon shutdown (→ interrupted + daemon-restart,
 * resumable) apart from a user cancel (no-arg abort → canceled by user).
 */
export function abortAllActiveTasks(reason: string): string[] {
  const tickets = taskDriverRegistry.abortAll(reason)
  return tickets.map((ticket) => ticket.token.taskId)
}

/**
 * RFC-328 daemon shutdown admission protocol.  Seal first, drain every
 * claim→attach permit, then stop an exact token snapshot and perform a final
 * generation sweep.  The returned ids are the only local handles that did not
 * prove stopped inside the caller's budget.
 */
export async function shutdownActiveTaskExecutions(
  reason: string,
  budgetMs: number,
): Promise<readonly string[]> {
  if (reason.length === 0) throw new Error('task execution shutdown requires a reason')
  const tickets = await taskExecutionModule.dispose(reason)
  const boundedBudget = Math.max(0, budgetMs)
  if (tickets.length > 0 && boundedBudget > 0) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(tickets.map((ticket) => taskDriverRegistry.awaitStopped(ticket))),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, boundedBudget)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  // A handle may have attached and released while the snapshot was stopping;
  // the sealed gate means no new claim can start, so one final exact sweep is
  // complete rather than an open-ended taskId poll.
  const survivors = taskDriverRegistry.activeTokens()
  for (const token of survivors) taskDriverRegistry.requestStop(token, reason)
  return survivors.map((token) => token.taskId)
}

// RFC-359：同名的 SQLite 专属 `markTaskExecutionShutdownSurvivor` 已删除。优雅停机的幸存者处置
// 早在 W4-B1 批 2h 合成了两个引擎共用的一份
// （`DrizzleTaskExecutionShutdownOperations.interruptSurvivor` / `.markRecoveryRequired`，
// 由 `services/shutdown.ts` 经 `dependencies.operations` 调用），这一份自那以后生产侧零调用方。

export interface TaskContinuationDependencies {
  /** Frozen commit identity used when resuming repository preparation. */
  gitCommitIdentity?: GitCommitIdentity | null
  /** The selected live configuration follows short-lived drive and continuation paths. */
  launchConfiguration?: TaskLaunchConfigurationQueries
  /** Explicit launch command knobs retain precedence over live defaults. */
  launchConfigurationOverrides?: Pick<
    TaskContinuationDependencies,
    'defaultPerNodeTimeoutMs' | 'defaultNodeRetries' | 'sessionRestartBudget' | 'defaultRuntime'
  >
  /** Required by bootstrap when recovering a journaled preparation; absent only for legacy tasks. */
  repositoryPreparation?: taskDriveComposition.TaskRepositoryPreparationBinding
  /** RFC-332: required instance-level TaskEngine application surface. */
  schedulerDriver: Pick<SchedulerDriverPort, 'drive'>
  /**
   * RFC-204: needed to unseal `cached_repos.url_enc` for a reuse-by-id launch.
   * Optional so tests / internal faces that never reuse can omit it; when a row
   * IS sealed and this is missing, the launch fails closed rather than guessing.
   */
  secretBox?: SecretBox
  db: LegacyProviderNeutralDatabase
  /**
   * RFC-349 provider-selected post-commit memory participant. Bootstrap must
   * bind this for production launches; the optional shape keeps legacy tests
   * that never converge a clarify continuation source-compatible.
   */
  memoryDistillEnqueuer?: MemoryDistillEnqueuer
  /** Provider-selected recovery reads used by resume/retry preflight. The
   * worktree admission path fails closed when bootstrap omitted it. */
  taskRecoveryOperations?: TaskRecoveryOperations
  /** Physical references are interpreted by the selected workspace adapter. */
  workspacePresence?: WorkspacePresenceQueries
  /** Provider-selected cached repository/group persistence. Legacy direct
   * fixtures may omit it and receive the explicit SQLite adapter below. */
  repositoryWorkspace?: RepositoryWorkspaceStore
  /** Provider-selected native runtime-session lease operations. */
  runtimeSessionLeases?: RuntimeSessionLeaseOperations
  /** Test/recovery seam; production uses the structured process-tree reaper. */
  killStaleRunProcessTree?: typeof killStaleRunProcessTree
  /** Override app home (tests). Defaults to `Paths.root`. */
  appHome?: string
  /** Default per-node timeout (ms). Defaults from settings; tests can pin. */
  defaultPerNodeTimeoutMs?: number
  /**
   * RFC-287 G7：任务启动路径的克隆/抓取超时（`config.gitCloneTimeoutMs`）。
   *
   * 此前**只有仓库路由**（`routes/cached-repos.ts` / `routes/repoGroups.ts`）把这个
   * 配置传给 `resolveCachedRepo`，任务启动这条路径压根没接——管理员把它调小，
   * 手动导入仓库时生效，而真正会卡住启动接口的那次克隆仍按 30 分钟默认值跑。
   * 与 RFC-284 T30 挖出的「字段因类型缺席被 spread 静默丢弃」是同一类问题。
   */
  cloneTimeoutMs?: number
  /**
   * RFC-287 G6：基线同步的总容忍窗口（ms，`config.gitBaselineSyncWindowMs`）。
   * 只有网络类失败占窗口；0 = 关闭重试，保持 G6 之前的硬失败语义。
   */
  gitBaselineSyncWindowMs?: number
  /**
   * RFC-048: cadence + failure tolerance for the runner-side subagent live
   * capture poller. Threaded into `RunTaskOptions` → `runNode`. Omitted →
   * runner falls back to its compile-time defaults (1500ms / 5 failures);
   * `pollMs = 0` keeps RFC-027 behavior (post-run BFS only).
   */
  subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }
  /**
   * RFC-075: auto commit&push runtime config (resolved from settings by the
   * route). Threaded into `RunTaskOptions`. Omitted fields fall back to
   * opencode-default model + DEFAULT_COMMIT_PUSH_* constants.
   */
  commitPush?: {
    model?: string
    runtime?: string
    maxRepairRetries?: number
    diffMaxBytes?: number
    excludePatterns?: readonly string[]
    lang?: Language
  }
  /**
   * RFC-130 §6.1: built-in merge-conflict resolver runtime (config.mergeAgentRuntime
   * / deprecated mergeAgentModel), threaded into RunTaskOptions so a real merge-back
   * conflict resolves on the configured runtime (not just `defaultRuntime`).
   */
  mergeAgent?: {
    model?: string
    runtime?: string
  }
  /**
   * RFC-103 T2 (02-SCHED): global concurrency cap, resolved from settings
   * `maxConcurrentNodes` by the route and threaded into `RunTaskOptions` across
   * start / resume / retry. Omitted → scheduler default (4). Before RFC-103
   * this was never wired from the HTTP layer, so production tasks always ran at
   * the default regardless of the configured value.
   */
  maxConcurrentNodes?: number
  /**
   * RFC-266: per-task fan-out sub-pool capacity
   * (config.multiProcessSubprocessConcurrency), threaded via runtimeConfigOpts →
   * RunTaskOptions. Omitted → scheduler default (4). Until RFC-266 this was
   * never wired from the HTTP layer either (the exact defect RFC-103 fixed for
   * `maxConcurrentNodes`), so every fan-out ran at 4 regardless of the
   * configured value. Live changes reach RUNNING tasks through the
   * taskFanoutPools registry, not through this launch-time value.
   */
  multiProcessSubprocessConcurrency?: number
  /**
   * RFC-266: capacity of the daemon-wide pool for RFC-253 script nodes
   * (config.maxConcurrentScriptNodes), independent of `maxConcurrentNodes` so
   * scripts and agents never queue behind each other. Omitted → scheduler
   * default (4).
   */
  maxConcurrentScriptNodes?: number
  /** RFC-269: daemon-wide pool for code-host call nodes + their request knobs. */
  maxConcurrentCodeHostCalls?: number
  codeHostRequestTimeoutMs?: number
  codeHostResponseMaxBytes?: number
  /**
   * RFC-115: global per-node retry budget (config.defaultNodeRetries) threaded
   * via runtimeConfigOpts → RunTaskOptions across start / resume / retry.
   * Replaces the removed per-node `retries` override. Omitted → scheduler `?? 3`.
   */
  defaultNodeRetries?: number
  /**
   * RFC-313: 同会话追问链触顶后允许整体换几次干净会话（config.sessionRestartBudget），
   * 与 defaultNodeRetries 走同一条 runtimeConfigOpts → RunTaskOptions 管道。
   * 省略 → scheduler `?? DEFAULT_SESSION_RESTART_BUDGET`。
   */
  sessionRestartBudget?: number
  /**
   * RFC-115 (Codex F3): global default runtime NAME (config.defaultRuntime),
   * threaded via runtimeConfigOpts → RunTaskOptions. Before RFC-115 this was
   * resolved by resolveLaunchRuntimeConfig but NEVER forwarded from here, so
   * `config.defaultRuntime` had no effect on production task launches (every
   * agent.runtime=null node fell back to opencode). Omitted → scheduler default.
   */
  defaultRuntime?: string
  /**
   * RFC-253 — administrator interpreter overrides + dependency build budget.
   * RFC-284 T30 修配（用户拍板）：launch 臂一直经 `...launchRuntime` 在运行时
   * 携带这两键，但本类型缺席 + runtimeConfigOpts 未拾取 ⇒ 根任务与子任务
   * **双双静默丢弃**（RFC-253 覆盖生产死配）。补类型 + 漏斗 + 继承登记三点。
   */
  scriptInterpreters?: Partial<Record<ScriptLanguage, string>>
  scriptDepsInstallTimeoutMs?: number
  /** RFC-345 T4a: exact Resource Catalog authority used by production launch paths. */
  launchResources?: TaskExecutionResourceAuthority
  /** RFC-243 §3.2: daemon-wide active-child-task cap (config.maxActiveChildTasks). */
  maxActiveChildTasks?: number
  /** RFC-243 §3.2: invocation-chain depth ceiling (config.maxInvocationDepth). */
  maxInvocationDepth?: number
  /** TEST-ONLY runtime-neutral command-head override (mock binaries). */
  binaryOverride?: readonly string[]
  /** Daemon config path — threaded to the scheduler's single
   *  config.opencodePath resolution point (RFC-282 C1-2). */
  configPath?: string
  /** Await scheduler completion in this call (tests). HTTP route does NOT pass this. */
  awaitScheduler?: boolean
  /** Existing internal continuations keep their source and local repository reference. */
  internalSource?: { kind: 'local-path'; repoPath: string; baseBranch: string }
  /** Actor snapshot for continuation intent and runtime configuration. */
  actorUserId?: string
  /** Scheduler continuations preserve the originating schedule's intent source. */
  scheduledTaskId?: string
  /** A child continuation keeps its internal intent source. */
  callLaunch?: { readonly parentTaskId: string }

  /** RFC-199 test seam for deterministic remove/ref/root cleanup failures. */
  workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
}

function repositoryWorkspaceFor(
  deps: Pick<TaskContinuationDependencies, 'db' | 'repositoryWorkspace'>,
) {
  return deps.repositoryWorkspace ?? composeSqliteRepositoryWorkspaceStore(deps.db)
}

/**
 * RFC-359 AC-1（plan §5hn 批次二 ①）—— **延后仓库准备**这一步真正需要的那些依赖。
 *
 * 从 `TaskContinuationDependencies` 里拆出来的理由与 §5ge / §5hn 批次一的几次拆分完全一样：
 * 这一步的函数体**早就是中立的**（`await db.select(...)` / `setTaskStatus` /
 * `setNodeRunStatus` / `mintNodeRun` 收的都已是 `PersistenceDb`），
 * 只有类型把它钉死在 SQLite 那一侧——`TaskContinuationDependencies.db` 是 `DbClient`。
 * 后果不是不好看：**RFC-287 G7 因此在 PostgreSQL 上根本没实现**
 *（`rfc359-w5hn-deferred-repo-preparation-parity` 钉着那处落差），
 * 因为 PG 的根拿不到一个它能构造的准备步骤，只能传 `skipRepositoryPreparation`。
 *
 * `repositoryWorkspace` 在这里是**必填**：`TaskContinuationDependencies` 那边缺省会回落到
 * `composeSqliteRepositoryWorkspaceStore(db)`，那正是本 RFC 在消灭的隐式 provider 绑定。
 * 装配方各自交自己那份（PG 根有 `composePostgresqlRepositoryWorkspaceStore`）。
 */
export interface DeferredRepositoryPreparationDependencies extends Pick<
  TaskContinuationDependencies,
  | 'secretBox'
  | 'cloneTimeoutMs'
  | 'gitBaselineSyncWindowMs'
  | 'launchConfiguration'
  | 'workspaceCleanupHook'
  // 准备时才知道的那一格：占位行上冻结的提交身份由 descriptor 带回来。
  | 'gitCommitIdentity'
> {
  readonly repositoryPreparation?: taskDriveComposition.TaskRepositoryPreparationBinding
  readonly db: LegacyProviderNeutralDatabase
  /** Only legacy direct-service callers without an injected root binding. */
  readonly repositoryWorkspace?: RepositoryWorkspaceStore
  /**
   * 重放（`sourceTaskId`）用的冻结布局读取。SQLite 那份在本文件里是同步 `.all()`，
   * PostgreSQL 那份在 `taskRouteWorkspaceParticipant.ts` 里是中立异步——
   * 两份都已存在，让装配方交自己那一份，这一步就不必认识任何一个引擎。
   */
  readonly loadFrozenSpaceLayout: (sourceTaskId: string) => Promise<PlannedSpaceLayout>
}

/**
 * RFC-359 AC-1（plan §5hn 批次二 ①）—— 两个 provider 共用的**延后仓库准备**步骤。
 *
 * 交给 `TaskDriveCoordinator` 当 `repositoryPreparation`：任务行先落 `pending`，
 * 克隆 / 抓取 / 多仓物化 / 建工作树由驱动认领后作为第 0 步推进，失败转 `failed`
 * 且 git 原文可见（RFC-287 G7）。
 */
export function composeDeferredRepositoryPreparationStep(input: {
  readonly deps: DeferredRepositoryPreparationDependencies
  readonly appHome: string
}): taskDriveComposition.PersistedRepositoryPreparationStep {
  return createPersistedRepositoryPreparationStep(input)
}

function requireTaskRecoveryOperations(deps: TaskContinuationDependencies): TaskRecoveryOperations {
  if (deps.taskRecoveryOperations === undefined) {
    throw new Error('task-recovery-operations-not-composed')
  }
  return deps.taskRecoveryOperations
}

/**
 * RFC-103 T1 (01-LIFE-05) — pick the rollback targets for resume: the freshest
 * top-level (`parentNodeRunId === null`) run per node, kept only when it is in a
 * resumable terminal state (failed/interrupted). fanout/loop child rows are
 * excluded so a shard/iteration child (which carries a parentNodeRunId and can
 * have a later ULID than its node's top-level row) can't shadow the node row and
 * force a rollback to the wrong (child) `pre_snapshot`. Mirrors the authoritative
 * `pickFreshestRun` `topLevelOnly` default (freshness.ts).
 */
// RFC-359 AC-1（第 10 刀）：实现搬到 `modules/task-execution/application/resumeRollbackTargets.ts`
// ——那里是全仓唯一一份（PostgreSQL 的 resume 参与者原来有一份逐字相同的副本）。
// 这里保留同名再导出，本文件既有的三条调用路与外部导入面一个字不用改。
export function selectResumeRollbackTargets<
  R extends {
    id: string
    seq: number | null
    nodeId: string
    parentNodeRunId: string | null
    status: string
    childTaskId?: string | null
  },
>(runs: readonly R[]): Promise<R[]> {
  return selectResumeRollbackTargetsWithSelection(
    runs,
    createRunSelectionOracleSnapshot(
      runs.map((row) => ({ ...row, taskId: '' })),
      { scope: { kind: 'rows' } },
    ),
    '',
  )
}

/**
 * RFC-109 (Codex design-gate F4) — generalized rollback-target selector for the
 * resume/sync core. Same freshest-top-level-per-node selection as
 * `selectResumeRollbackTargets`, but the allowed status set is a parameter:
 *
 *   - resume passes ['failed','interrupted'] → byte-identical to the original.
 *   - syncTaskWorkflow passes ['failed','interrupted','canceled'] so a canceled
 *     WRITE node's partial worktree writes are rolled back to its pre_snapshot
 *     BEFORE the scheduler revives it (RFC-095 makes canceled rows dispatchable;
 *     the whole-task sync path — unlike retryNode — had no rollback for them).
 *
 * `isWrapperNode` carves out wrapper rows from the canceled case: a canceled
 * wrapper row is an RFC-095 revival signal that resumes IN-PLACE (loop keeps its
 * iteration, git keeps its baseline) — rolling it back would undo completed inner
 * work. resume never hits this branch (no canceled in its status set).
 */
export async function selectSyncRollbackTargets<
  R extends {
    id: string
    seq: number | null
    nodeId: string
    parentNodeRunId: string | null
    status: string
  },
>(
  runs: readonly R[],
  statuses: readonly string[],
  isWrapperNode: (nodeId: string) => boolean,
): Promise<R[]> {
  const latestPerNode = new Map<string, R>()
  const selection = createRunSelectionOracleSnapshot(
    runs.map((row) => ({ ...row, taskId: '' })),
    { scope: { kind: 'rows' } },
  )
  for (const nodeId of new Set(
    runs.filter((run) => run.parentNodeRunId === null).map((run) => run.nodeId),
  )) {
    const selected = (await selection.familyHistory('', { nodeId }, { topLevelOnly: true })).at(-1)
    const run = runs.find((row) => row.id === selected?.id)
    if (run !== undefined) latestPerNode.set(nodeId, run)
  }
  return [...latestPerNode.values()].filter((r) => {
    if (!statuses.includes(r.status)) return false
    if (r.status === 'canceled' && isWrapperNode(r.nodeId)) return false
    return true
  })
}

/**
 * RFC-103 T2 — single source for threading runtime config (auto commit&push +
 * global concurrency) from `TaskContinuationDependencies` into `RunTaskOptions`. Used by
 * startTask / resumeTask / retryNode so the three kick sites can't drift: the
 * historical bug (01-LIFE-06) was retryNode dropping commit&push entirely, and
 * `maxConcurrentNodes` was never threaded from any HTTP entry (02-SCHED).
 */
export function runtimeConfigOpts(
  deps: Pick<
    TaskContinuationDependencies,
    | 'commitPush'
    | 'mergeAgent'
    | 'maxConcurrentNodes'
    | 'multiProcessSubprocessConcurrency'
    | 'maxConcurrentScriptNodes'
    | 'maxConcurrentCodeHostCalls'
    | 'codeHostRequestTimeoutMs'
    | 'codeHostResponseMaxBytes'
    | 'defaultPerNodeTimeoutMs'
    | 'defaultNodeRetries'
    | 'sessionRestartBudget'
    | 'defaultRuntime'
    | 'maxActiveChildTasks'
    | 'maxInvocationDepth'
    | 'scriptInterpreters'
    | 'scriptDepsInstallTimeoutMs'
    | 'memoryDistillEnqueuer'
  >,
): Partial<TaskDriveRuntimeOptions> {
  return {
    // RFC-366: agent-run distill. Threaded through the SAME funnel as every
    // other runtime option for the reason this funnel exists (RFC-103 T2): the
    // three kick sites — startTask / resumeTask / retryNode — must not drift,
    // and a resumed or retried run's agents are exactly the ones worth learning
    // from. Absent enqueuer (legacy fixtures) → the engine's no-op observer.
    ...(deps.memoryDistillEnqueuer === undefined
      ? {}
      : { agentRunSettled: composeAgentRunDistillObserver(deps.memoryDistillEnqueuer) }),
    ...(deps.maxActiveChildTasks !== undefined
      ? { maxActiveChildTasks: deps.maxActiveChildTasks }
      : {}),
    ...(deps.maxInvocationDepth !== undefined
      ? { maxInvocationDepth: deps.maxInvocationDepth }
      : {}),
    ...(deps.commitPush?.model !== undefined ? { commitPushModel: deps.commitPush.model } : {}),
    ...(deps.commitPush?.runtime !== undefined
      ? { commitPushRuntime: deps.commitPush.runtime }
      : {}),
    // RFC-130 §6.1: built-in merge-conflict resolver runtime.
    ...(deps.mergeAgent?.model !== undefined ? { mergeAgentModel: deps.mergeAgent.model } : {}),
    ...(deps.mergeAgent?.runtime !== undefined
      ? { mergeAgentRuntime: deps.mergeAgent.runtime }
      : {}),
    ...(deps.commitPush?.maxRepairRetries !== undefined
      ? { commitPushMaxRepairRetries: deps.commitPush.maxRepairRetries }
      : {}),
    ...(deps.commitPush?.diffMaxBytes !== undefined
      ? { commitPushDiffMaxBytes: deps.commitPush.diffMaxBytes }
      : {}),
    ...(deps.commitPush?.excludePatterns !== undefined
      ? { commitPushExcludePatterns: deps.commitPush.excludePatterns }
      : {}),
    // RFC-157: commit-message output language (undefined ≡ en-US downstream).
    ...(deps.commitPush?.lang !== undefined ? { commitPushLang: deps.commitPush.lang } : {}),
    ...(deps.maxConcurrentNodes !== undefined
      ? { maxConcurrentNodes: deps.maxConcurrentNodes }
      : {}),
    // RFC-266: the fan-out sub-pool + the independent script pool ride the SAME
    // funnel. The fan-out one was persisted by Settings and consumed by the
    // scheduler but wired by nobody in between.
    ...(deps.multiProcessSubprocessConcurrency !== undefined
      ? { multiProcessSubprocessConcurrency: deps.multiProcessSubprocessConcurrency }
      : {}),
    ...(deps.maxConcurrentScriptNodes !== undefined
      ? { maxConcurrentScriptNodes: deps.maxConcurrentScriptNodes }
      : {}),
    // RFC-269: the code-host pool + request knobs ride the same funnel.
    ...(deps.maxConcurrentCodeHostCalls !== undefined
      ? { maxConcurrentCodeHostCalls: deps.maxConcurrentCodeHostCalls }
      : {}),
    ...(deps.codeHostRequestTimeoutMs !== undefined
      ? { codeHostRequestTimeoutMs: deps.codeHostRequestTimeoutMs }
      : {}),
    ...(deps.codeHostResponseMaxBytes !== undefined
      ? { codeHostResponseMaxBytes: deps.codeHostResponseMaxBytes }
      : {}),
    // RFC-253（RFC-284 T30 修配）：管理员解释器覆盖 + 依赖构建预算——此前唯二
    // 被漏斗丢弃的 launchRuntime 键（根任务即断线，见 TaskContinuationDependencies 字段注释）。
    ...(deps.scriptInterpreters !== undefined
      ? { scriptInterpreters: deps.scriptInterpreters }
      : {}),
    ...(deps.scriptDepsInstallTimeoutMs !== undefined
      ? { scriptDepsInstallTimeoutMs: deps.scriptDepsInstallTimeoutMs }
      : {}),
    // RFC-115: per-node timeout + retry budget + default runtime. Previously
    // timeout was hand-spread at each runTask call site and defaultRuntime was
    // never threaded at all (Codex F3) — single funnel now so every start /
    // resume / retry / fusion entry gets all three consistently.
    ...(deps.defaultPerNodeTimeoutMs !== undefined
      ? { defaultPerNodeTimeoutMs: deps.defaultPerNodeTimeoutMs }
      : {}),
    ...(deps.sessionRestartBudget !== undefined
      ? { sessionRestartBudget: deps.sessionRestartBudget }
      : {}),
    ...(deps.defaultNodeRetries !== undefined
      ? { defaultNodeRetries: deps.defaultNodeRetries }
      : {}),
    ...(deps.defaultRuntime !== undefined ? { defaultRuntime: deps.defaultRuntime } : {}),
  }
}

const missingMemoryDistillEnqueuer: MemoryDistillEnqueuer = Object.freeze({
  async enqueue() {
    throw new TaskExecutionError(
      'task-execution-recovery-required',
      'memory distill enqueuer is not composed for clarify continuation convergence',
    )
  },
})

/**
 * RFC-359 AC-1（plan §5ha 第 ① 步）—— 「造一台任务驱动协调器」需要的**确切**依赖面。
 *
 * 为什么把它从 `TaskContinuationDependencies` 里摘出来：这台协调器是 `RootTaskLaunchKernel`
 * 的四件入参之一，PostgreSQL daemon 在自己那边**就地**造一台
 * （`cli/postgresqlDaemonApplication.ts:953`），与 `TaskContinuationDependencies` 无关；
 * 而 SQLite 侧唯一的造法锁在本文件里、且以 legacy 启动路的那个大依赖包为入参，
 * 于是 `cli/start.ts` **造不出内核**——这正是启动面合一（plan §5gv）Step B 的卡点。
 *
 * 这个类型是**按函数体实际读到的字段**列的，不是拍脑袋收窄：
 * `runtimeConfigOpts` 那一组（它自己就已经是 `Pick<TaskContinuationDependencies, …>`）＋ 下面这六个。
 * `TaskContinuationDependencies` 仍然满足它，所以本文件内四处既有构造点一个字都不用改。
 */
export type TaskDriveCoordinatorDependencies = Parameters<typeof runtimeConfigOpts>[0] &
  Pick<
    TaskContinuationDependencies,
    | 'schedulerDriver'
    | 'binaryOverride'
    | 'configPath'
    | 'subagentLiveCapture'
    | 'memoryDistillEnqueuer'
    | 'workspacePresence'
    | 'launchConfiguration'
    | 'launchConfigurationOverrides'
  > & {
    /**
     * RFC-359 AC-1（plan §5hm）：收成中立句柄。此前这一格是从 `TaskContinuationDependencies` Pick 来的
     * `LegacySqliteTaskDatabase`——**不是因为协调器真要 SQLite**，而是它装的驱动生命周期端口
     * 当年只有 SQLite 一份（要 `DbClient`）。端口合一之后那个约束没了：
     * 协调器这一路上读 `db` 的三处（生命周期端口、闸门继续前置、工作区清理）全是中立实现。
     * `TaskContinuationDependencies` 仍然满足这个更宽的类型，所以本文件内既有构造点一个字都不用改。
     */
    readonly db: LegacyProviderNeutralDatabase
  }

/** RFC-387: test-only assembly for the legacy entry points; removed in W4. */
export function composeTestTaskDriveFactory(input: {
  readonly deps: TaskDriveCoordinatorDependencies
  readonly appHome: string
  readonly persistence?: ReturnType<typeof createTaskExecutionPersistence>
  readonly repositoryPreparation?: RepositoryPreparationStep
  readonly gateContinuationPreDrive?: taskDriveComposition.GateContinuationPreDriveStep
  readonly refreshLaunchConfig?: () =>
    | Partial<TaskDriveCoordinatorDependencies>
    | Promise<Partial<TaskDriveCoordinatorDependencies>>
  readonly launchConfiguration?: TaskLaunchConfigurationQueries
}): taskDriveComposition.TaskDriveCoordinatorFactory {
  const persistence =
    input.persistence ??
    createTaskExecutionPersistence(input.deps.db, {
      workspacePresence: input.deps.workspacePresence,
    })
  const maintenance = composeWorkspaceMaintenanceCommand({
    db: input.deps.db,
    appHome: input.appHome,
    terminalMaintenance: persistence.terminalMaintenance,
    isMaterializingTask: (taskId) => materializingSpaces.has(taskId),
    invalidateWorkspacePath: () => {},
  })
  return createTaskDriveCoordinatorFactory({
    async runConfiguration() {
      const source = input.launchConfiguration ?? input.deps.launchConfiguration
      const fresh =
        source === undefined
          ? await input.refreshLaunchConfig?.()
          : {
              ...(await resolveTaskLaunchRuntimeConfiguration(source)),
              subagentLiveCapture: await resolveTaskSubagentLiveCapture(source),
              ...input.deps.launchConfigurationOverrides,
            }
      const deps = { ...input.deps, ...fresh }
      return {
        appHome: input.appHome,
        ...(deps.binaryOverride === undefined ? {} : { binaryOverride: deps.binaryOverride }),
        ...(deps.configPath === undefined ? {} : { configPath: deps.configPath }),
        ...(deps.subagentLiveCapture === undefined
          ? {}
          : { subagentLiveCapture: deps.subagentLiveCapture }),
        ...runtimeConfigOpts(
          source === undefined
            ? deps
            : {
                ...fresh,
                memoryDistillEnqueuer: input.deps.memoryDistillEnqueuer,
              },
        ),
      }
    },
    lifecycle: createDatabaseTaskDriverLifecyclePort({
      db: input.deps.db,
      persistence,
      workspacePresence: input.deps.workspacePresence,
      log,
      finalizeWorkspace: (taskId) => maintenance.finalizeClaimedWorkspace(taskId),
    }),
    gateContinuationPreDrive:
      input.gateContinuationPreDrive ??
      composeGateContinuationPreDrive({
        db: input.deps.db,
        persistence,
        memoryDistillEnqueuer: input.deps.memoryDistillEnqueuer ?? missingMemoryDistillEnqueuer,
      }),
    repositoryPreparation: input.repositoryPreparation ?? skipRepositoryPreparation,
    engine: () => input.deps.schedulerDriver,
    failures: persistence,
    log,
  })
}

function createPersistedRepositoryPreparationStep(input: {
  readonly deps: DeferredRepositoryPreparationDependencies
  readonly appHome: string
}): taskDriveComposition.PersistedRepositoryPreparationStep {
  const reader: RepositoryPreparationDescriptorReader = {
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
  return new PersistedRepositoryPreparationStep(reader, {
    async prepare({ descriptor, context }) {
      const task = await getTask(input.deps.db, descriptor.taskId)
      if (task === null) return { kind: 'terminal-won' }
      if (
        descriptor.hasPriorAttempt &&
        !(await taskDriveComposition.hasDurableRepositoryPreparation(
          input.deps.db,
          descriptor.taskId,
        ))
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
        await reclaimStalePrepArtifacts(input.deps.db, input.appHome, task)
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
      const ownership: RepositoryPreparationOwnership = {
        cleanup: createMaterializedSpaceCleanup(descriptor.taskId, null),
      }
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
        appHome: input.appHome,
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
          cleanup: ownership.cleanup as MaterializedSpaceCleanup,
        } as MaterializedSpace,
        ownership,
      })
      return result.ok ? { kind: 'ready' } : { kind: 'terminal-won' }
    },
  })
}

// RFC-359 AC-6：句柄放宽到中立、函数转 async。它读的两张表（`task_repos` / `task_space_nodes`）
// 都是普通 drizzle 查询，零方言；钉在 bun:sqlite 上的只有那两个 `.all()` 同步终结子。
// 三个调用点本来就在 `async (sourceTaskId) => …` 里，加一个 await 即可。
async function loadFrozenSpaceLayout(
  db: LegacyProviderNeutralDatabase,
  sourceTaskId: string,
): Promise<PlannedSpaceLayout> {
  return createTaskPreparationQueries(db).frozenLayout(sourceTaskId)
}

interface RepositoryPreparationOwnership {
  cleanup: MaterializedSpaceCleanup | null
}

/**
 * Built-in host snapshots are generated by several platform entry points. Keep
 * their geometry policy here at the one task-freeze boundary so present and
 * future built-ins cannot forget to call the shared planner. Invalid JSON is
 * left untouched so the established validation/runtime error remains the
 * authoritative failure instead of being masked by a layout exception.
 */
export function layoutBuiltinWorkflowSnapshot<T>(snapshot: T): T {
  const parsed = WorkflowDefinitionSchema.safeParse(snapshot)
  if (!parsed.success) return snapshot
  // Validation is the authority, but layout the raw document when it already
  // has the complete shape so historical top-level extensions survive. Zod's
  // definition object intentionally strips unknown top-level keys.
  const source =
    typeof snapshot === 'object' &&
    snapshot !== null &&
    Array.isArray((snapshot as Record<string, unknown>)['inputs']) &&
    Array.isArray((snapshot as Record<string, unknown>)['nodes']) &&
    Array.isArray((snapshot as Record<string, unknown>)['edges'])
      ? (snapshot as unknown as WorkflowDefinition)
      : parsed.data
  const planned = planCanonicalWorkflowLayout(source).next
  if (planned === source && source === snapshot) return snapshot
  return planned as T
}

/** Read-model projection; ordinary workflow snapshots retain authored geometry verbatim. */
export function projectWorkflowSnapshotForRead<T>(snapshot: T, builtin: boolean): T {
  return builtin ? layoutBuiltinWorkflowSnapshot(snapshot) : snapshot
}

export function layoutBuiltinWorkflowSnapshotJson(snapshotJson: string): string {
  // 只吞 **JSON 语法错误**。原版是一个包住整段的 `catch {}`，于是
  // `planCanonicalWorkflowLayout` 抛出时也走「原样返回」——布局真的坏了，对外却与
  // 「这份快照本来就没有几何」完全同形，只有下游某条恰好检查坐标的断言才会偶然发现，
  // 且报出来的是「某个节点没有坐标」这种离病因十万八千里的症状（实测：分片里
  // `__dw_orchestrator__` 缺坐标，单跑却绿，查了一整轮才定位到是这个 catch）。
  // 布局器对一份**已经通过 schema 校验**的定义抛异常是真 bug，必须大声失败。
  let document: unknown
  try {
    document = JSON.parse(snapshotJson)
  } catch {
    return snapshotJson
  }
  const planned = layoutBuiltinWorkflowSnapshot(document)
  return planned === document ? snapshotJson : JSON.stringify(planned)
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
 * Cancel an in-flight task. Aborts the in-process controller (runner SIGTERMs
 * the opencode child), then waits briefly for the scheduler to settle.
 *
 * Rejects if the task is already terminal.
 */
/**
 * RFC-066 PR-B T13: roll back the worktree state before a node_run for the
 * resume / single-node-retry paths. RFC-092 T1: thin shell over the shared
 * `rollbackNodeRunWorktrees` (services/nodeRollback.ts) — the single authority
 * for historical snapshot rollback. Fresh-session retry uses isolated worktrees;
 * historical resume semantics are preserved
 * exactly: empty/missing shas are skipped, a multi-repo row whose
 * `preSnapshotReposJson` is NULL (predates PR-B) falls through to the legacy
 * single-string rollback, and an unparseable map degrades to a per-repo no-op
 * (NOT a single-repo fallback — see nodeRollback.ts for the real control flow
 * the old comment here misdescribed).
 */
async function rollbackNodeRunForResume(
  db: LegacyProviderNeutralDatabase,
  task: Task,
  run: RollbackRunRow,
  log: ReturnType<typeof createLogger>,
  opts?: { checkOnly?: boolean },
): Promise<RollbackOutcome> {
  return await rollbackNodeRunWorktrees(
    {
      taskId: task.id,
      db,
      worktreePath: task.worktreePath,
      repos: task.repos,
    },
    run,
    { ...(opts?.checkOnly ? { checkOnly: true } : {}) },
    log,
  )
}

// RFC-359 —— 判据本体搬进 `modules/task-execution/application/worktreeResumePreflight`，
// 两个 provider 共用一份（合一前 PostgreSQL 部署注入的是空操作，见那边的注释）。
// 这里保留原名的转发，让本文件既有的调用点不动。

/**
 * RFC-098 WP-9: snapshot-lost escalation shared by resumeTask / retryNode.
 * A `'snapshot-missing'` rollback failure means a recorded pre-snapshot was
 * gc-pruned from the (shared) source-repo odb — the fail-closed rollback
 * touched nothing, but the baseline the resume contract promises to restore
 * is gone forever. Silently proceeding would re-run nodes on top of the
 * failed attempt's leftover writes, so the task flips pending → failed
 * (`errorSummary='snapshot-lost'`) and the HTTP caller sees a 409.
 * Returns `never`; throws ConflictError after the CAS.
 */
async function escalateSnapshotLost(
  db: LegacyProviderNeutralDatabase,
  recovery: TaskRecoveryOperations,
  taskId: string,
  run: { id: string; nodeId: string },
  outcome: RollbackOutcome,
  reason: 'resumeTask' | 'retryNode' | 'syncTaskWorkflow',
): Promise<never> {
  const detail = outcome.failures
    .filter((f) => f.code === 'snapshot-missing')
    .map((f) =>
      f.worktreeDirName !== undefined ? `${f.worktreeDirName}: ${f.message}` : f.message,
    )
    .join('; ')
  await setTaskStatus({
    db,
    taskId,
    to: 'failed',
    allowedFrom: ['pending'],
    extra: {
      finishedAt: Date.now(),
      errorSummary: 'snapshot-lost',
      errorMessage: `node_run ${run.id} (node ${run.nodeId}) pre-snapshot lost: ${detail}`,
      failedNodeId: run.nodeId,
    },
    reason: `${reason}:snapshot-lost`,
  })
  await recordRecoveryEvent(recovery, {
    taskId,
    nodeRunId: run.id,
    kind: 'snapshot-lost',
    reason: detail,
    before: { status: 'pending' },
    after: { status: 'failed' },
  })
  throw new ConflictError(
    'snapshot-lost',
    `cannot ${reason === 'resumeTask' ? 'resume' : 'retry'}: node_run ${run.id} pre-snapshot is missing from the object database (pruned by gc?): ${detail}`,
  )
}

/**
 * RFC-108 T9 (AR-14): a node_run's opencode child is still alive AND survived
 * SIGTERM→SIGKILL (identity-matched to our recorded spawn binary, so confidently
 * ours), so rolling its worktree back would git-reset UNDER a live writer
 * (double-write corruption). Fail SAFE: flip the task pending → failed
 * (`errorSummary='live-child-survived'`) and surface a 409 instead of resetting.
 * Mirrors escalateSnapshotLost's contract. Returns `never`.
 */
async function escalateLiveChildSurvived(
  db: LegacyProviderNeutralDatabase,
  recovery: TaskRecoveryOperations,
  taskId: string,
  run: { id: string; nodeId: string; pid: number | null },
  reason: 'resumeTask' | 'retryNode' | 'syncTaskWorkflow',
  killOutcome: StaleRunKillOutcome = 'kill-failed',
): Promise<never> {
  await setTaskStatus({
    db,
    taskId,
    to: 'failed',
    allowedFrom: ['pending'],
    extra: {
      finishedAt: Date.now(),
      errorSummary: 'live-child-survived',
      errorMessage: `node_run ${run.id} (node ${run.nodeId}) child reap could not be proven (${killOutcome}, pid ${run.pid ?? '?'}); refusing to reset the worktree while a writer may still be alive`,
      failedNodeId: run.nodeId,
    },
    reason: `${reason}:live-child-survived`,
  })
  await recordRecoveryEvent(recovery, {
    taskId,
    nodeRunId: run.id,
    kind: 'live-child-survived',
    reason: `child reap unproven: ${killOutcome}; pid ${run.pid ?? '?'}`,
    before: { status: 'pending' },
    after: { status: 'failed' },
  })
  throw new ConflictError(
    'live-child-survived',
    `cannot ${reason === 'resumeTask' ? 'resume' : 'retry'}: node_run ${run.id} child reap is unproven (${killOutcome}, pid ${run.pid ?? '?'}); the worktree cannot be safely reset while it may still be writing`,
  )
}

async function reapRunBeforeWorktreeReset(
  db: LegacyProviderNeutralDatabase,
  taskId: string,
  run: {
    id: string
    nodeId: string
    pid: number | null
    startedAt: number | null
    spawnBinaryPath: string | null
    spawnLaunchNonce?: string | null
  },
  reason: 'resumeTask' | 'retryNode' | 'syncTaskWorkflow',
  deps: TaskContinuationDependencies,
  log: Logger,
): Promise<void> {
  const heldNativeLease = await createNodeRunQueries(db).heldSession(run.id)
  const killOutcome = await (deps.killStaleRunProcessTree ?? killStaleRunProcessTree)(run)
  const recovery = requireTaskRecoveryOperations(deps)
  if (killOutcome === 'killed') {
    log.warn(`${reason}: stale runtime child group-killed before rollback`, {
      nodeRunId: run.id,
      pid: run.pid,
    })
  }
  if (heldNativeLease !== undefined) {
    if (killOutcome !== 'not-alive' && killOutcome !== 'killed') {
      await escalateLiveChildSurvived(db, recovery, taskId, run, reason, killOutcome)
    }
    // A proven-dead terminal holder must be neutralized/discarded before the
    // scheduler can admit a replacement. The helper validates terminal state
    // and preserves reset/identity-invalid fail-closed semantics.
    if (deps.runtimeSessionLeases === undefined) {
      throw new Error('runtime-session-lease-operations-not-composed')
    }
    if (
      (await repairRuntimeSessionLeasesAfterOrphanReap(deps.runtimeSessionLeases, true, run.id)) !==
      1
    ) {
      await escalateLiveChildSurvived(db, recovery, taskId, run, reason, 'kill-failed')
    }
  } else if (killOutcome === 'kill-failed') {
    await escalateLiveChildSurvived(db, recovery, taskId, run, reason, killOutcome)
  }
}

async function reapHeldRuntimeSessionOwnersForTask(
  db: LegacyProviderNeutralDatabase,
  taskId: string,
  reason: 'resumeTask' | 'retryNode' | 'syncTaskWorkflow',
  deps: TaskContinuationDependencies,
  log: Logger,
): Promise<void> {
  const ownerIds = await createNodeRunQueries(db).heldSessionRunIds(taskId)
  for (const nodeRunId of ownerIds) {
    const run = await createNodeRunQueries(db).read(nodeRunId)
    if (run === null) {
      await escalateLiveChildSurvived(
        db,
        requireTaskRecoveryOperations(deps),
        taskId,
        { id: nodeRunId, nodeId: '(missing)', pid: null },
        reason,
        'no-pid',
      )
      continue
    }
    await reapRunBeforeWorktreeReset(db, taskId, run, reason, deps, log)
  }
}

// RFC-359 AC-1（第 11 刀）：`cancelTask` 已删除。取消只有**一份**实现
// （`modules/task-execution/infrastructure/childTaskLifecycleParticipant.ts`
// 的 `cancelTaskProjection`），生产装配走 `modules/task-execution/composition/taskCancellation.ts`，
// 测试装配走 `tests/helpers/cancelEngine.ts`。RFC-202 T3 的那条判据
//（awaiting_review / awaiting_human 可取消）跟着实现搬到了共用那份的
// `CANCELABLE_TASK_STATUSES`。

/** RFC-387: test-only exact-intent wake over the factory; removed in W4. */
export async function wakeHumanGateContinuation(
  taskId: string,
  continuationRef: string,
  deps: TaskContinuationDependencies,
): Promise<void> {
  if (deps.awaitScheduler === true) await awaitTaskDriverIdle(taskId)
  else if (isTaskDriverActive(taskId)) return
  await composeTestTaskDriveFactory({ deps, appHome: deps.appHome ?? Paths.root }).session.submit({
    taskId,
    intentId: continuationRef,
    completionMode: deps.awaitScheduler === true ? 'await-settle' : 'background',
  })
}

/**
 * RFC-387: test-only dynamic-workflow admission over the factory; removed in W4.
 * RFC-167 — the dynamic-workflow confirm gate's resume core: write the
 * decision's durable state ATOMICALLY within the resume admission CAS, then
 * re-kick the scheduler. approve passes BOTH columns (swap the confirmed DAG
 * into `workflow_snapshot` + flip dw.phase='executing'); reject passes only
 * `workgroupConfigJson` (phase='generating' + the feedback) — either way a
 * failed resume (lost CAS / 410 worktree preflight) leaves the task exactly
 * as it was, so the gate stays open and the decision can be retried (Codex
 * impl-gate P1: no torn phase-vs-status stranding). Thin shell over
 * `resumeKick`, mirroring syncTaskWorkflow.
 */
export async function resumeDynamicWorkflowExecution(
  db: LegacySqliteTaskDatabase,
  id: string,
  deps: TaskContinuationDependencies,
  swap: { workflowSnapshot?: string; dw: DwState },
): Promise<Task> {
  return resumeKick(db, id, deps, {
    intentKind: 'gate-continuation',
    event: { kind: 'resume' },
    ...(swap.workflowSnapshot !== undefined
      ? { extra: { workflowSnapshot: swap.workflowSnapshot } }
      : {}),
    selectRollback: (runs) => selectResumeRollbackTargets(runs),
    reason: 'resumeTask',
    conflictCode: 'task-not-resumable',
    verb: 'resume',
    worktreePreflight: true,
    // RFC-217 T2 (design-gate P1) — the phase flip MUST ride the resume
    // admission CAS: a lost CAS / failed worktree preflight leaves the gate
    // open and the decision retryable; a standalone phase write would strand
    // the task in 'executing'/'generating' while still awaiting_review.
    onClaimTx: async (tx) => await setDwStateTx(tx, id, swap.dw),
  })
}

/**
 * RFC-109 — shared "reanimate a parked/terminal task and continue from the
 * breakpoint" core, extracted from resumeTask. Both resumeTask and
 * syncTaskWorkflow drive it; the ONLY differences are the transition event
 * (which fixes the allowed-from set via the shared `nextTaskStatus` table), the
 * optional `extra` columns written ATOMICALLY inside the admission CAS (sync
 * swaps `workflow_snapshot` + `workflow_version` here), and the rollback-target
 * selector.
 *
 * RFC-387: test-only admission and factory drive; removed in W4.
 * The pending lifecycle CAS (RFC-097 audit S-8) is the command-admission winner
 * and moves BEFORE any git rollback. The same transaction writes the canonical
 * intent; only its durable owner claim authorizes subsequent execution effects.
 */
async function resumeKick(
  db: LegacyProviderNeutralDatabase,
  id: string,
  deps: TaskContinuationDependencies,
  opts: {
    intentKind: 'resume' | 'sync-workflow' | 'gate-continuation'
    event: TaskTransitionEvent
    extra?: TaskStatusUpdateExtra
    selectRollback: (
      runs: readonly NodeRunCheckpointSnapshot[],
    ) => Promise<readonly NodeRunCheckpointSnapshot[]>
    reason: 'resumeTask' | 'syncTaskWorkflow'
    conflictCode: string
    verb: string
    /**
     * RFC-108 T6 (AR-15): when true, 410 before the CAS if the worktree is gone
     * (gc reclaimed a resumable task). resumeTask opts in; syncTaskWorkflow
     * (RFC-109) leaves it off for now (it may opt in once its harness uses a
     * real worktree). The T7 cross-row snapshot pre-pass below is unconditional.
     */
    worktreePreflight?: boolean
    onClaimTx?: (
      tx: PersistenceTx,
      transition: {
        from: TaskStatus
        to: TaskStatus
      },
    ) => void | Promise<void>
  },
): Promise<Task> {
  const task = await getTask(db, id)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${id}' not found`)
  }
  const allowedFrom = allowedFromForTaskEvent(opts.event)
  // RFC-359 两阶段停机：上一任 driver 的运行时已停但库里 owner 行 / intent 还在转移时，先等它 settle——
  // 否则准入放行后 continuation intent 会撞上仍是 claimed 的旧 intent（task-continuation-conflict）。
  await taskDriverRegistry.awaitReleasedSettled(id)
  // RFC-097 (audit S-8): an in-process scheduler loop already owns this task —
  // a second driver would double-write the worktree.
  if (isTaskActive(id)) {
    throw new ConflictError(
      opts.conflictCode,
      `task '${id}' is actively running (scheduler attached); cannot ${opts.verb}`,
    )
  }
  if (!allowedFrom.includes(task.status)) {
    throw new ConflictError(
      opts.conflictCode,
      `task '${id}' is ${task.status}; only [${allowedFrom.join('/')}] tasks can ${opts.verb}`,
    )
  }
  // RFC-243 §4.2 — a child execution whose owning call row already settled
  // must not be re-driven: nobody will ever merge its further output.
  await assertChildTaskDrivable(db, task, opts.verb)

  // RFC-292: re-check the exact execution snapshot before the admission CAS.
  await assertFrozenTaskTriggerPreflight(
    db,
    id,
    opts.extra?.workflowSnapshot === undefined
      ? undefined
      : {
          workflowSnapshot: opts.extra.workflowSnapshot,
          refClosureJson: opts.extra.refClosureJson ?? null,
        },
  )

  // RFC-108 T6 (AR-15): 410 before the admission CAS when the worktree is gone
  // (gc reclaimed a resumable task) — never flip to pending then 500 on a
  // missing cwd. Gated per-caller (resumeTask opts in).
  if (opts.worktreePreflight === true) {
    if (deps.taskRecoveryOperations === undefined) {
      throw new Error('task-recovery-operations-not-composed')
    }
    await assertWorktreePresentForResume(
      deps.taskRecoveryOperations,
      task,
      opts.verb,
      (reference) =>
        (deps.workspacePresence ?? createFileWorkspacePresenceQueries()).exists(reference),
    )
  }

  // RFC-097 command admission — the pending CAS moves BEFORE the git rollback
  // so a concurrent resume/retry/sync loses here with zero side effects. RFC-109:
  // routed through the shared event table; `extra` carries sync's atomic
  // snapshot+version swap (one CAS UPDATE — a lost race never tears the row).
  const intentId = ulid()
  const intentNow = Date.now()
  try {
    await transitionTaskStatusByEvent({
      db,
      taskId: id,
      event: opts.event,
      allowTerminal: true,
      extra: {
        finishedAt: null,
        errorSummary: null,
        errorMessage: null,
        failedNodeId: null,
        ...opts.extra,
      },
      onTransitionTx: async (tx, transition) => {
        await opts.onClaimTx?.(tx, transition)
        await submitContinuationIntentInTx({
          tx,
          taskId: id,
          intentId,
          kind: opts.intentKind,
          source: continuationSource(deps, opts.intentKind),
          actorUserId: deps.actorUserId ?? null,
          payload: { v: 1, event: opts.event.kind },
          now: intentNow,
          advanceOperationGeneration: opts.intentKind !== 'gate-continuation',
        })
      },
      reason: opts.reason,
    })
  } catch (err) {
    if (err instanceof ConflictError) {
      if (
        err.code === 'task-source-terminal-closed' ||
        err.code === 'task-source-terminal-merged'
      ) {
        throw err
      }
      throw new ConflictError(
        opts.conflictCode,
        `task '${id}' changed state concurrently; only [${allowedFrom.join('/')}] tasks can ${opts.verb}`,
      )
    }
    throw err
  }

  let admittedTask: Task | null = null
  const admittedContinuation: RepositoryPreparationStep = {
    async run(context) {
      // Direct framework children (commit-message / merge-resolve agents) are
      // nested node_runs and intentionally absent from `toRollback`. Fence every
      // held native-session owner for the task before any rollback or fresh kick.
      await reapHeldRuntimeSessionOwnersForTask(db, id, opts.reason, deps, log)

      // Collect the latest non-done run per nodeId — those need rollback + a fresh
      // attempt. Freshness is ULID id-order, matching the scheduler's authority
      // (isFresherNodeRun). retryIndex ordering was wrong: a clarify-driven rerun is
      // minted with retryIndex 0 but a newer id, so an older failed retry with a
      // higher retryIndex would shadow it and resume would roll the worktree back to
      // the wrong row's pre_snapshot. See
      // scheduler-boundary-resume-retryindex-vs-id.test.ts.
      const runs = await createNodeRunQueries(db).listResumeRuns(
        id,
        task.repos.map((repo) => repo.mountPath),
      )
      const toRollback = await opts.selectRollback(runs)

      // RFC-108 T7 (AR-17): cross-node-run all-or-nothing pre-pass. The within-row
      // rollback is fail-closed, but the reset loop below touches rows one at a
      // time — if a LATER row's pre_snapshot was gc-pruned, earlier rows are already
      // reset (and their children killed) when escalateSnapshotLost fires, leaving a
      // half-rolled-back worktree. Verify EVERY row's snapshot still resolves to a
      // commit (side-effect-free `checkOnly`) BEFORE killing/resetting anything.
      for (const r of toRollback) {
        const probe = await rollbackNodeRunForResume(db, task, r.rollback, log, { checkOnly: true })
        if (probe.failures.some((f) => f.code === 'snapshot-missing')) {
          await escalateSnapshotLost(
            db,
            requireTaskRecoveryOperations(deps),
            id,
            r,
            probe,
            opts.reason,
          ) // throws 409
        }
      }

      // RFC-098 WP-8 (audit S-15) + RFC-108 T9 (AR-14): kill pass FIRST, separated
      // from the rollback pass for cross-row safety. If the row's opencode child
      // from a previous daemon is still alive, group-kill it (SIGTERM→SIGKILL)
      // BEFORE any worktree is rolled back — a survivor would keep writing into a
      // worktree we are about to reset. T9: a child that SURVIVES the kill (matched
      // to our recorded spawn binary, so confidently OURS + alive) is the
      // double-write danger the old fuzzy gate let slip — REFUSE the whole resume
      // (409) rather than git-reset under a live writer. Killing is idempotent and
      // safe; only the rollback is gated on every child being dead/recycled.
      for (const r of toRollback) {
        await reapRunBeforeWorktreeReset(db, id, r, opts.reason, deps, log)
      }

      for (const r of toRollback) {
        const outcome = await rollbackNodeRunForResume(db, task, r.rollback, log)
        // RFC-098 WP-9: a gc-pruned pre-snapshot is NOT warn-and-continue — the
        // fail-closed rollback touched nothing, but the baseline is gone forever;
        // flip the task failed (errorSummary='snapshot-lost') and surface a 409.
        // Other failure codes keep the historical warn-and-continue net below.
        if (outcome.failures.some((f) => f.code === 'snapshot-missing')) {
          await escalateSnapshotLost(
            db,
            requireTaskRecoveryOperations(deps),
            id,
            r,
            outcome,
            opts.reason,
          )
        }
        // The scheduler creates a new node_run with retry_index = max+1 on its
        // own when it sees no pending run for the node, so we just leave the
        // failed row as historical. The task row already flipped pending above
        // (RFC-097 admission winner); a rollback failure keeps it pending — same
        // warn-and-continue net as before, runTask kicks regardless. A daemon
        // crash mid-rollback leaves a pending orphan that boot reaping flips to
        // interrupted (reapOrphanRuns, RFC-097 crash-window compensation).
      }

      const next = (await getTask(db, id)) as Task
      admittedTask = next

      const controller = activeTaskDriverController(id)
      if (controller === undefined || controller.signal !== context.signal) {
        log.error(`${opts.reason}: exact controller was replaced before task drive`, {
          taskId: id,
        })
        return { kind: 'terminal-won' }
      }
      return { kind: 'ready' }
    },
  }
  const coordinator = composeTestTaskDriveFactory({
    deps,
    appHome: deps.appHome ?? Paths.root,
  }).coordinatorFor({ admittedContinuation })
  const receipt = await coordinator.submit({
    taskId: id,
    intentId,
    completionMode: deps.awaitScheduler === true ? 'await-settle' : 'background',
  })
  if (receipt.kind === 'not-attached') {
    return (await getTask(db, id)) as Task
  }
  if (deps.awaitScheduler === true) return (await getTask(db, id)) as Task
  return admittedTask ?? ((await getTask(db, id)) as Task)
}

/**
 * RFC-109 — parse a task's frozen `workflow_snapshot` (already JSON-decoded into
 * an object by rowToTask, so `unknown` here) into a structured definition, the
 * same schema the scheduler parses at runTask entry. Throws on a corrupt
 * snapshot (an exceptional state for a task that launched successfully).
 */
function parseSnapshotDefinition(snapshot: unknown): WorkflowDefinition {
  return migrateWorkflowDefinitionToLatest(WorkflowDefinitionSchema.parse(snapshot))
}

/**
 * RFC-109 (Codex impl-gate re-review P2) — the wrapper top-level statuses after
 * which `wrapper_progress_json` is a pure debug breadcrumb the runtime never
 * re-reads. Mirrors `wrapperRunLifecycle.findResumableWrapperRun` exactly, which
 * returns null (→ fresh wrapper row, no progress decode) for these and resumes
 * from progress for everything else (RFC-095 keeps canceled/interrupted live).
 */
const WRAPPER_BREADCRUMB_TERMINAL: ReadonlySet<string> = new Set(['done', 'failed', 'exhausted'])

/**
 * RFC-109 — assemble the per-node `NodeRunSyncSummary` the sync diff consumes,
 * from a task's node_runs. `hasCompletedRun` / `hasLiveWrapperState` come from
 * the rows alone; `producedPorts` (the preserved run's actual output ports, used
 * only by the preview's data-loss warnings) is supplied by the caller when it
 * has queried node_run_outputs — the sync SERVICE leaves it empty because it
 * only acts on `differs` + `blockers`, neither of which reads producedPorts.
 */
export function buildSyncRunSummary(
  runs: readonly Pick<
    NodeRunFactSnapshot,
    'id' | 'nodeId' | 'parentNodeRunId' | 'status' | 'wrapperProgressJson'
  >[],
  producedPortsByNode?: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, NodeRunSyncSummary> {
  const runIdToNode = new Map(runs.map((r) => [r.id, r.nodeId]))
  const completed = new Set<string>()
  const liveWrapper = new Set<string>()
  for (const r of runs) {
    if (r.parentNodeRunId === null && r.status === 'done') completed.add(r.nodeId)
    // Live wrapper state = state WrapperRuntime would actually RE-READ on resume.
    // Codex impl-gate re-review P2: `wrapper_progress_json` is left in place after
    // a TERMINAL wrapper transition as a debug breadcrumb and is never read again
    // (wrapperRunLifecycle.ts). Mirror findResumableWrapperRun's gate exactly — it
    // resumes (and decodes progress for) every status EXCEPT done/failed/exhausted
    // (RFC-095 keeps canceled/interrupted resumable). So a done/failed/exhausted
    // wrapper with a leftover breadcrumb must NOT count as live (else a completed
    // task false-blocks). A non-terminal child row is an in-progress shard.
    if (
      r.parentNodeRunId === null &&
      r.wrapperProgressJson != null &&
      !WRAPPER_BREADCRUMB_TERMINAL.has(r.status)
    ) {
      liveWrapper.add(r.nodeId) // parked / resumable wrapper holding real progress
    }
    if (r.parentNodeRunId !== null && !isTerminalNodeRunStatus(r.status as NodeRunStatus)) {
      const parentNode = runIdToNode.get(r.parentNodeRunId)
      if (parentNode !== undefined) liveWrapper.add(parentNode) // wrapper has an in-progress shard/iteration child
    }
  }
  const nodeIds = new Set<string>([
    ...runs.map((r) => r.nodeId),
    ...(producedPortsByNode?.keys() ?? []),
  ])
  const out = new Map<string, NodeRunSyncSummary>()
  for (const nodeId of nodeIds) {
    out.set(nodeId, {
      hasCompletedRun: completed.has(nodeId),
      producedPorts: producedPortsByNode?.get(nodeId) ?? new Set<string>(),
      hasLiveWrapperState: liveWrapper.has(nodeId),
    })
  }
  return out
}

// RFC-359 AC-1（第 13 刀下）**退役**：`syncTaskWorkflow`（RFC-109 的那 160 行）已删除。
// 它是 `syncWorkflow` 的第二份实现，只在 SQLite 上跑过；两个引擎现在共用
// `taskRouteOperations.syncWorkflow`（两段式交棒 + 回滚基线跨行预检 + 与 retry / resume 同一套
// 准入机制）。回归判据整套迁到 `tests/rfc109-sync-task-workflow.test.ts`，并改成双引擎跑。

/**
 * RFC-109 — assemble the `workflow-sync-preview` for a task whose workflow is
 * resolved + visible (the route handles deleted / not-visible before calling).
 * Computes the version delta, the full node diff (with the data-loss warnings
 * that need the preserved runs' actual produced ports), and whether the live
 * definition currently fails static validation.
 */
export async function computeWorkflowSyncPreview(
  db: LegacyProviderNeutralDatabase,
  task: Task,
  workflow: Workflow,
  resourceAuthority: TaskExecutionResourceAuthority,
): Promise<WorkflowSyncPreview> {
  // RFC-104 built-in workflows are never manually executed (POST sync-workflow
  // would 403) — so the banner must not appear for them (Codex impl-gate F4).
  // RFC-359: the projection lives in the shared domain so PostgreSQL answers identically.
  if (workflow.builtin) return builtinWorkflowSyncPreview(task, workflow.version)
  const oldDef = parseSnapshotDefinition(task.workflowSnapshot)
  const newDef = workflow.definition
  let candidateClosureJson: string | null = null
  const closureIssues: Array<{ code: string; message: string }> = []
  try {
    candidateClosureJson = await freezeClosureForLaunch(
      { launchResources: resourceAuthority },
      workflow.id,
      newDef,
    )
  } catch (error) {
    closureIssues.push({
      code: error instanceof DomainError ? error.code : 'workflow-call-ref-missing',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  const runs = await createNodeRunQueries(db).list({ taskId: task.id })

  // The freshest done top-level run per node + the output ports it produced —
  // the basis for the `dangling-input-port` warning (Codex F2).
  const freshestDoneRunIdByNode = new Map<string, string>()
  const runsByNode = new Map<string, NodeRunFactSnapshot[]>()
  for (const r of runs) {
    const list = runsByNode.get(r.nodeId)
    if (list === undefined) runsByNode.set(r.nodeId, [r])
    else list.push(r)
  }
  const selection = createRunSelectionOracleSnapshot(runs, { scope: { kind: 'rows' } })
  for (const nodeId of runsByNode.keys()) {
    const fresh = (
      await selection.familyHistory(task.id, { nodeId }, { topLevelOnly: true, statusIn: ['done'] })
    ).at(-1)
    if (fresh !== undefined) freshestDoneRunIdByNode.set(nodeId, fresh.id)
  }
  const runIds = [...freshestDoneRunIdByNode.values()]
  const outRows = await createNodeOutputQueries(db).listProducedPorts(runIds)
  const portsByRun = new Map<string, Set<string>>()
  for (const o of outRows) {
    const set = portsByRun.get(o.nodeRunId)
    if (set === undefined) portsByRun.set(o.nodeRunId, new Set([o.portName]))
    else set.add(o.portName)
  }
  const producedPortsByNode = new Map<string, ReadonlySet<string>>()
  for (const [nodeId, runId] of freshestDoneRunIdByNode) {
    producedPortsByNode.set(nodeId, portsByRun.get(runId) ?? new Set<string>())
  }

  const diff = diffWorkflowForSync(oldDef, newDef, buildSyncRunSummary(runs, producedPortsByNode))
  const validation = validateWorkflowDef(
    newDef,
    await buildWorkflowValidationContext(db, {
      definition: newDef,
      currentWorkflow: { id: workflow.id, name: workflow.name },
      frozenClosureJson: candidateClosureJson,
    }),
  )
  const validationIssues = validation.ok
    ? []
    : validation.issues
        .filter((i) => (i.severity ?? 'error') === 'error')
        .map((i) => ({ code: i.code, message: i.message }))
  const triggerContextJson = await createTaskTriggerQueries(db).frozenContext(task.id)
  const triggerIssue = triggerPreflightIssue({
    root: newDef,
    closureJson: candidateClosureJson,
    source: parseTriggerContextJson(triggerContextJson),
  })
  const triggerIssues =
    triggerIssue === null
      ? []
      : [
          {
            code: triggerIssue.code,
            message:
              triggerIssue.code === 'trigger-context-invalid'
                ? 'the frozen task trigger context is invalid'
                : triggerIssue.code === 'trigger-context-missing'
                  ? `workflow requires webhook trigger context at ${triggerIssue.dependency.pointer}`
                  : `workflow trigger field '${triggerIssue.dependency.field}' is unavailable at ${triggerIssue.dependency.pointer}`,
          },
        ]
  const invalidIssues = [...closureIssues, ...validationIssues, ...triggerIssues]

  // RFC-359: 判据落在共用 domain 里，PostgreSQL 的预览用同一条。
  const reason = workflowSyncGateReason({
    status: task.status,
    worktreeMissing: isTaskWorkspaceUnbound(task.worktreePath),
  })
  const syncable = reason === 'ok'

  return {
    syncable,
    reason,
    workflowId: task.workflowId,
    workflowName: task.workflowName,
    currentVersion: task.workflowVersion,
    latestVersion: workflow.version,
    differs: diff.differs,
    invalid: invalidIssues.length > 0,
    invalidIssues,
    diff,
  }
}

/**
 * Retry one node_run, optionally cascading to all downstream nodes that
 * depended on it (P-3-09). The retry happens by:
 *
 *   - rolling the worktree back to the node_run's `pre_snapshot`
 *   - marking the target run + (cascaded) downstream runs as failed so the
 *     scheduler picks them up on the next runTask() invocation
 *   - flipping task.status back to pending
 *   - kicking the scheduler
 */
/**
 * RFC-243 §4.2 — child-side gate: once the parent's call row is TERMINAL the
 * invocation is over; re-running the child would write into an iso the parent
 * will never merge (retrying the CALL NODE on the parent is the sanctioned
 * re-run path). Non-child tasks and live call rows pass untouched; a missing
 * call row (dirty data) fails open to the pre-RFC-243 behavior.
 */
async function assertChildTaskDrivable(
  db: LegacyProviderNeutralDatabase,
  task: { id: string; parentTaskId?: string | null; parentNodeRunId?: string | null },
  verb: string,
): Promise<void> {
  const callRowId = task.parentNodeRunId ?? null
  if ((task.parentTaskId ?? null) === null || callRowId === null) return
  const row = await createNodeRunQueries(db).readFields(callRowId, ['status'])
  if (row === null) return
  if (isTerminalNodeRunStatus(row.status as NodeRunStatus)) {
    throw new ConflictError(
      'call-row-finalized',
      `task '${task.id}' is a child execution whose call node run already settled ('${row.status}'); ${verb} the parent's call node instead`,
    )
  }
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
  db: LegacyProviderNeutralDatabase,
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
      for (const m of (
        await resolveRepoGroupLayout(
          composeSqliteRepositoryWorkspaceStore(db),
          requestedSource.repoGroupId,
        )
      ).repos) {
        if (m.cachedRepoId.length > 0) mirrorIds.add(m.cachedRepoId)
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
    const { cachedRepos } = tablesOf(db)
    // RFC-359 AC-1（plan §5ft 同一条）：中立读法——`.all()` 是 bun:sqlite 专属的同步终结符。
    const row = (await db.select().from(cachedRepos).where(eq(cachedRepos.id, id)).limit(1))[0]
    if (row === undefined || !existsSync(row.localPath)) continue
    try {
      // `prune` 与 `add` / `remove` 一样会改 common-dir registry，必须走同一把
      // registry 锁（五轮门 Codex F6）：不持锁时，另一个任务正在同一镜像上
      // `worktree add` 的半初始化注册项会被本次 prune 观察到并删掉，让对方的 add
      // 失败或留下不完整 registry——`util/git.ts` 的锁注释里记着这类真实事故。
      await withWorktreeRegistryLock(row.localPath, () =>
        runGit(row.localPath, ['worktree', 'prune']),
      )
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
        repoPath: row.localPath,
        branchRef: `agent-workflow/${task.id}*`,
        log,
      })
      if (locksCleared > 0) {
        log.info('reclaimed stale branch ref locks before retry', {
          taskId: task.id,
          count: locksCleared,
        })
      }
      const listed = await runGit(row.localPath, [
        'for-each-ref',
        '--format=%(refname)',
        `refs/heads/agent-workflow/${task.id}`,
        `refs/heads/agent-workflow/${task.id}-*`,
      ])
      for (const ref of listed.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)) {
        await runGit(row.localPath, ['update-ref', '-d', ref])
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

/** RFC-387: test-only repository retry over the factory; removed in W4. */
export async function retryRepositoryPreparation(
  db: LegacySqliteTaskDatabase,
  taskId: string,
  deps: TaskContinuationDependencies,
): Promise<Task> {
  const appHome = deps.appHome ?? Paths.root
  const factory = composeTestTaskDriveFactory({
    deps: { ...deps, db },
    appHome,
    repositoryPreparation: createPersistedRepositoryPreparationStep({
      deps: {
        ...deps,
        db,
        repositoryWorkspace: repositoryWorkspaceFor({ ...deps, db }),
        loadFrozenSpaceLayout: (sourceTaskId) => loadFrozenSpaceLayout(db, sourceTaskId),
      },
      appHome,
    }),
  })
  await taskDriveComposition
    .createRepositoryPreparationRetryCommand({
      db,
      coordinator: {
        submit: (request) =>
          factory.session.submit({
            ...request,
            completionMode: deps.awaitScheduler === true ? 'await-settle' : 'background',
          }),
      },
      isTaskActive: isTaskDriverActive,
      awaitTaskSettled: awaitTaskDriverReleasedSettled,
    })
    .retry(taskId, deps.actorUserId === undefined ? undefined : { actorUserId: deps.actorUserId })
  return (await getTask(db, taskId)) as Task
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
  appHome: string,
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
  if (deps.repositoryPreparation !== undefined)
    return deps.repositoryPreparation.legacy.prepare({
      task: input,
      taskId,
      signal,
      gitCommitIdentity: deps.gitCommitIdentity ?? null,
      loadFrozenSpaceLayout: deps.loadFrozenSpaceLayout,
      ...options,
    })
  // The pre-RFC363 direct-service test/local compatibility face has no root.
  // Production deferred composition always supplies repositoryPreparation.
  if (deps.repositoryWorkspace === undefined)
    throw new Error('legacy-repository-workspace-not-composed')
  return materializeSpaceWithProvider(
    input,
    {
      appHome,
      repositoryWorkspace: deps.repositoryWorkspace,
      loadFrozenSpaceLayout: deps.loadFrozenSpaceLayout,
      ...(deps.gitCommitIdentity === undefined
        ? {}
        : { gitCommitIdentity: deps.gitCommitIdentity }),
      sourceTerminationLaunchSignal: signal,
      ...options,
    },
    taskId,
  )
}

async function runDeferredRepoPreparation(args: {
  deps: DeferredRepositoryPreparationDependencies
  input: StartTask
  appHome: string
  signal: AbortSignal
  taskId: string
  prepTaskId: string
  task: Task
  space: MaterializedSpace
  ownership: RepositoryPreparationOwnership
}): Promise<{ ok: boolean; preparedTask: Task | null }> {
  const { deps, input, appHome, signal, taskId, prepTaskId, task, space, ownership } = args
  if (
    deps.repositoryPreparation === undefined &&
    (await taskDriveComposition.hasDurableRepositoryPreparation(deps.db, taskId))
  )
    throw new Error('journaled-repository-preparation-binding-missing')
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
    ...deriveNodeRunRole({
      nodeId: REPO_PREP_NODE_ID,
      rerunCause: prepRetryIndex === 0 ? 'initial' : 'retry-node',
    }),
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
      // RFC-359 AC-1（plan §5hn 批次二 ①）：直接打中立物化面。`materializeSpace` 是它的
      // SQLite 适配壳（`repositoryWorkspace` 缺省回落到 `composeSqliteRepositoryWorkspaceStore`），
      // 这一步的装配方**必须**自己交仓库工作区存储，才谈得上两个引擎共用。
      const durable =
        deps.repositoryPreparation === undefined
          ? null
          : await taskDriveComposition.prepareDurableRepositoryWorkspace({
              db: deps.db,
              binding: deps.repositoryPreparation,
              taskId,
              gitCommitIdentity: deps.gitCommitIdentity ?? null,
              ...(input.workingBranch === undefined ? {} : { workingBranch: input.workingBranch }),
              signal,
            })
      prepared =
        durable ?? (await prepareLegacyDeferredWorkspace(input, deps, appHome, prepTaskId, signal))
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
      const durableCleanup =
        deps.repositoryPreparation === undefined
          ? null
          : await taskDriveComposition.cleanupDurableRepositoryWorkspace({
              db: deps.db,
              binding: deps.repositoryPreparation,
              taskId,
              gitCommitIdentity: deps.gitCommitIdentity ?? null,
              ...(input.workingBranch === undefined ? {} : { workingBranch: input.workingBranch }),
              signal,
            })
      const report =
        durableCleanup ??
        (await cleanupMaterializedSpaceLease(prepared.cleanup, deps.workspaceCleanupHook))
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
  // 与任务行的路径回写放进**同一个事务**——多仓任务的 repos 与 tasks.worktreePath
  // 必须同时可见，否则一个恰好落在中间的读者（诊断接口、structural diff、前端
  // 详情页）会看到「有工作树但没有成员仓」这种不存在的状态。
  //
  // RFC-066 还要求 tasks 上的 legacy 仓库列逐字镜像 task_repos[0]，repoCount
  // 等于成员行数。延后准备的占位 INSERT 不可能提前知道这些值，所以这里必须把
  // **整份兼容投影**一起回填；只回填路径会让成功任务永久显示成 1 仓，且详情页
  // 丢失远端 URL / cache id / base branch。
  const preparedHead = prepared.repos[0]
  const preparedRepoRows = taskRepoRowsFor(taskId, prepared.repos, input.workingBranch ?? null)
  const preparedFinishedAt = Date.now()
  // RFC-359 W10 —— 回填投影改走中立写事务（`withTaskExecutionWrite` → `databaseSessionFor`），
  // 事务边界与「四件事同生共死」的语义一格不动，只是不再依赖 bun:sqlite 专属的同步 `dbTxSync`。
  // 体内每一条语句都必须 `await`：`.run()` 在 PostgreSQL 上不 await 就是一个没人等的 Promise，
  // 语句要么落在事务外、要么根本不发，而两边都不会抛。
  const persistPreparedProjection = async (tx: PersistenceTx): Promise<void> => {
    await taskDriveComposition.acceptDurableRepositoryWorkspace(tx, taskId)
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

export async function getTask(db: LegacyProviderNeutralDatabase, id: string): Promise<Task | null> {
  const detail = await createTaskDetailQueries(db).read(id)
  if (detail === null) return null
  const task = {
    ...detail.task,
    workflowSnapshot: projectWorkflowSnapshotForRead(
      detail.task.workflowSnapshot,
      detail.definitionOrigin === 'platform',
    ),
  }
  const codes = await loadTaskFailureCodes(db, [
    { id: task.id, status: task.status, failedNodeId: task.failedNodeId },
  ])
  const failureCode = codes.get(task.id)
  return failureCode !== undefined ? { ...task, failureCode } : task
}

/**
 * RFC-203 T4 — deterministic failed-run oracle: for failed tasks, project the
 * RFC-145 failure code of the FAILED NODE's freshest top-level run into the
 * task-level DTO (Task / TaskSummary.failureCode) so the list page and the
 * failure banner can localize copy without fetching node runs. One batched
 * query for any number of tasks; tasks without failedNodeId (scheduler-level
 * failures) resolve to null.
 */
/**
 * RFC-357：参数类型放宽到两个 provider 的公共基类型。函数体只有一次 drizzle 批量查询
 * 加一次纯函数挑选（`pickFreshestRun`），本就与 provider 无关；放宽之后 PostgreSQL 的
 * 列表页可以直接复用它，不必再像 `postgresqlTaskRouteOperations.failedCode` 那样逐行发
 * 一次查询（那是本 RFC 要消灭的 N+1 之一）。`DbClient` 仍可赋值给它，既有调用点零改动。
 */
export async function loadTaskFailureCodes(
  db: LegacyProviderNeutralDatabase,
  rows: ReadonlyArray<{ id: string; status: string; failedNodeId: string | null }>,
): Promise<Map<string, FailureCode | null>> {
  const out = new Map<string, FailureCode | null>()
  const wanted = rows.filter((r) => r.status === 'failed' && r.failedNodeId !== null)
  if (wanted.length === 0) return out
  const runRows = await createNodeRunQueries(db).listFields({ taskIds: wanted.map((r) => r.id) }, [
    'taskId',
    'nodeId',
    'id',
    'seq',
    'parentNodeRunId',
    'status',
    'failureCode',
  ])
  const snapshot = createRunSelectionOracleSnapshot(runRows, { scope: { kind: 'rows' } })
  const runsById = new Map(runRows.map((row) => [row.id, row]))
  for (const t of wanted) {
    const selected = (
      await snapshot.familyHistory(t.id, { nodeId: t.failedNodeId! }, { topLevelOnly: true })
    ).at(-1)
    const fresh = selected === undefined ? undefined : runsById.get(selected.id)
    out.set(t.id, (fresh?.failureCode ?? null) as FailureCode | null)
  }
  return out
}
