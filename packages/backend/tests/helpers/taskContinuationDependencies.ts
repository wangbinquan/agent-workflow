// RFC-478 —— 原 `services/task.ts` 的任务续跑依赖袋，原样迁来。生产只经两处 `Pick` 取它的字段（运行时选项漏斗与延后
// 仓库准备，现各有显式类型）；用例与 helper 仍用这一整袋描述装配参数。它取 collaboration composition 的类型，只在用例侧合法。
import type { composeGateContinuationSupport } from '@/modules/collaboration/composition'
import type { SecretBox } from '@/auth/secretBox'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import type {
  RepositoryWorkspaceStore,
  WorkspaceCleanupHookEvent,
} from '@/modules/source-control/composition'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import type { RuntimeSessionLeaseOperations } from '@/modules/task-execution/application/ports/runtimeSessionLeaseOperations'
import type { TaskExecutionResourceAuthority } from '@/modules/task-execution/application/ports/taskExecutionResourceSnapshots'
import type { SchedulerDriverPort } from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { TaskLaunchConfigurationQueries } from '@/modules/task-execution/application/ports/taskLaunchConfiguration'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import type { HumanGateOpenParticipantFactory } from '@/modules/task-execution/composition/required-ports'
import type { TaskRepositoryPreparationBinding } from '@/modules/task-execution/infrastructure/repositoryPreparationBinding'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { killStaleRunProcessTree } from '@/util/process'
import type { GitCommitIdentity, Language, ScriptLanguage } from '@agent-workflow/shared'

export interface TaskContinuationDependencies {
  readonly taskExecutionParticipants: Parameters<
    typeof composeGateContinuationSupport
  >[0]['taskExecutionParticipants']
  readonly humanGateOpen: HumanGateOpenParticipantFactory
  readonly historyRestrictions: HistoryRestrictionPort
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
  repositoryPreparation?: TaskRepositoryPreparationBinding
  /** RFC-332: required instance-level TaskEngine application surface. */
  schedulerDriver: Pick<SchedulerDriverPort, 'drive'>
  /**
   * RFC-204: needed to unseal `cached_repos.url_enc` for a reuse-by-id launch.
   * Optional so tests / internal faces that never reuse can omit it; when a row
   * IS sealed and this is missing, the launch fails closed rather than guessing.
   */
  secretBox?: SecretBox
  db: PersistenceDb
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
