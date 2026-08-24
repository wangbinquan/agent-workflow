// DAG scheduler for one task.
//
// M3 added agent-multi (fan-out), wrapper-git, retries, pre-snapshot rollback,
// resume, and single-node retry. M4 P-4-01 + P-4-03 extend the scheduler with
//   - wrapper-loop iteration scheduling + 3 built-in exit conditions
//   - recursive "scope" execution so wrapper nesting works for any composition
//     (git-in-loop, loop-in-git, loop-in-loop, git-in-git)
//
// A "scope" is the set of node ids that execute under one parent — the top
// level is the root scope; each wrapper has an inner scope = its nodeIds[].
// The level-parallel scheduler operates on a scope at a time. Wrapper nodes
// live in their parent scope; when one is reached, the scheduler recurses
// into the wrapper's inner scope (once for wrapper-git, up to maxIterations
// times for wrapper-loop).

import type {
  Agent,
  ClarifyCrossAgentNode,
  ClarifyNode,
  EnvelopeFollowupReason,
  FailureCode,
  Language,
  MergeState,
  MergeStateOrNull,
  NodeKind,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WrapperFanoutPort,
  TriggerContext,
} from '@agent-workflow/shared'
import {
  DAEMON_RESTART_ERROR_SUMMARY,
  DAEMON_SHUTDOWN_ABORT_REASON,
  FANOUT_DONE_PORT_NAME,
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  DEFAULT_SESSION_RESTART_BUDGET,
  decideRetryShape,
  retryAttemptCap,
  type RetryShapeState,
  type EnvelopeFollowupOutcome,
  channelEdgeDataflowSkip,
  NODE_KIND,
  NODE_KIND_BEHAVIORS,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  parseTriggerContextJson,
  agentHasClarifyChannel,
  analyzeWorkflowScopeTree,
  buildWorkflowScopeParentMap,
  buildPriorOutputBlock,
  deriveWrapperFanoutOutputs,
  followupPolicyForFailure,
  findClarifyNodeForAgent,
  findCrossClarifyNodeForQuestioner,
  findDesignerNodeForCrossClarify,
  findFanoutAggregator,
  findQuestionerNodeForCrossClarify,
  isMergeStateSettled,
  resolveClarifySessionMode,
  resolveCrossClarifySessionMode,
  resolveKeyOf,
  projectWorkflowDependency,
  readContinueOnMaxIterations,
  resolveWorkflowSourceRef,
  renderCallWorkgroupGoalTemplate,
  stringifyKind,
  tryParseKind,
  exclusionPlanFor,
  describeWrapperKind,
  splitPortItems,
} from '@agent-workflow/shared'
import {
  bindWorkspaceExcludeParticipant,
  resolveRepositoryPublicationTransportFromKeyFile,
  type RepositoryPublicationTransport,
} from '@/modules/source-control/composition'
import {
  applyAutoPromote,
  computeShardScope,
  estimateShardTotal,
  findBoundaryEdgesToInner,
} from '@/services/fanout'
import { and, asc, desc, eq, isNotNull, notLike, sql } from 'drizzle-orm'
// RFC-253 — script node execution.
import { mkdirSync } from 'node:fs'
import {
  maskScriptEnvValues,
  readScriptDependencies,
  readScriptEnv,
  readScriptLanguage,
  scriptOutputMode,
  resolveScriptReadonly,
  SCRIPT_PERMANENT_FAILURE_CODES,
  type ScriptLanguage,
} from '@agent-workflow/shared'
import { getRuntimeDriver, runRootFor } from './runtime'
import { buildInheritedActor } from '@/auth/actor'
import { loadConfig } from '@/config'
import { ensureScriptDepsEnv, ScriptDepsInstallError, type ScriptDepsEnv } from './scriptDepsEnv'
import { extractScriptPorts } from './scriptPorts'
import {
  describeInterpreterResolution,
  resolveScriptInterpreter,
  runScriptProcess,
} from './scriptRun'
import type { DbClient } from '@/db/client'
import {
  clarifyRounds,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  taskCollaborators,
  taskRepos,
  tasks,
} from '@/db/schema'
// RFC-271 T6d — RuntimeRef 域的单一解析点（三处 agentId 裸读收口于此）。
// `getAgentById` 的 import 随之删除：scheduler 不再自己查 agent 行。
import { fanoutInnerAgentRefKey, resolveNodeAgentRef } from '@/services/ref/runtimeRef'
import { resolveInjection } from '@/services/execution/resolveInjection'
import { triggerPreflightIssue } from '@/services/execution/triggerPreflight'
import {
  createClarifyRound,
  dispatchCrossClarifyNode,
  findClarifyNode,
  resolveCrossNodeStopped,
} from '@/services/clarify/service'
import {
  computeRemaining,
  resolveEffectiveClarifyChannel,
  shouldInjectStopNotice,
} from '@/services/clarifyRounds'
import { buildClarifyQueueContext } from '@/services/clarifyQueue'
import { getNodeClarifyDirectiveRow } from '@/services/taskClarifyDirective'
import {
  decideResumeSessionId,
  type ClarifyInlineFallbackReason,
} from '@/services/sessionModeFallback'
import { evaluateExitCondition, parseExitCondition } from '@/services/exitCondition'
import { loadUndispatchedParkTargets } from '@/services/taskQuestions'
import { resolveBorrowForNode } from '@/services/taskQuestionDispatch'
import { autoDispatchDeferredQuestions } from '@/services/clarifyAutoDispatch'
import {
  trySetTaskStatus,
  setNodeRunStatus,
  transitionNodeRunStatus,
  transitionMergeState,
  tryTransitionMergeState,
} from '@/services/lifecycle'
import {
  continuesClarifyLineage,
  frozenRuntimeOfSession,
  isClarifyRerunCause,
  loadRunEnvelopeNonce,
  mintNodeRun,
  resolveFrozenRuntime,
  resolveSchedulerRunRow,
} from '@/services/nodeRunMint'

import { resolveInternalAgentRuntime } from '@/services/runtimeRegistry'
import { getTaskWriteSem, gcTaskWriteSem } from '@/services/taskWriteLocks'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import {
  taskStopProjection,
  type TaskStopCause,
} from '@/modules/task-execution/domain/sourceTermination'
import {
  collectDataflowInboundEdges,
  collectImplicitInboundRefs,
  nodeKindIndex,
} from '@/modules/task-execution/domain/inboundEdges'
import { resolveNodeActivationForDispatch } from '@/modules/task-execution/application/resolveNodeActivation'
import { getNodePoolSemaphore } from '@/services/processNodeConcurrency'
import { getTaskFanoutSem, gcTaskFanoutSem } from '@/services/taskFanoutPools'
import { buildReviewPromptContext, dispatchReviewNode } from '@/services/review'
import {
  areTransitiveUpstreamsCompleted,
  buildFreshestSettledPerNode,
  consumedMapsEqual,
  isFresherNodeRun,
  isNodeRunFresh,
  parseConsumedJson,
  pickFreshestRun,
  pickReusableShardRun,
  pickUpstreamSourceRun,
  type NodeRunRow,
} from '@/services/freshness'
import {
  decideScopeOutcome,
  isDispatchable,
  isReviewSupersededRow,
  WRAPPER_KINDS,
  wrapperExternalUpstreamSources,
  wrapperRevivalEvidence,
} from '@/services/dispatchFrontier'
import { runNode, type RunResult } from '@/services/runner'
import { forcedPortPathsForTask, toContainerRelative } from '@/services/portArtifacts'
import { CLARIFY_FORBIDDEN_PREFIX, parsePortValidationFailuresJson } from '@/services/envelope'
import {
  dismissOpenClarifyParksForAutonomous,
  isTaskClarifySuppressed,
} from '@/services/workgroup/lifecycle'
import { runCommitPush } from '@/services/commitPushRunner'
import {
  buildCommitAgent,
  buildCommitMessagePrompt,
  buildRepairPrompt,
  commitPushNodeId,
  COMMIT_MESSAGE_PORT,
} from '@/services/commitPush'
import {
  DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES,
  DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES,
  // RFC-271 T6d — 两处调用点的归属策略（实测不同，见 runtimeRef.ts 的表）。
  DISPATCH_CALL_POLICY,
  FANOUT_HYDRATE_CALL_POLICY,
} from '@agent-workflow/shared'
import {
  decodeWrapperProgress,
  encodeWrapperProgress,
  type WrapperProgress,
} from '@/services/wrapperProgress'
import { emitTaskStatus, getTask } from '@/services/task'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger, type Logger } from '@/util/log'
// RFC-060 PR-E: splitDiff* imports removed — they were used only by the
// agent-multi fan-out path (now deleted). wrapper-fanout consumes a `list<T>`
// shardSource instead of slicing a string diff.
import { gitBlobHashes, gitChangedFiles, runGit, worktreeFilesChanged } from '@/util/git'
import {
  completeHumanResolvedConflict,
  // snapshotNodeIsoFinal / mergeBackNodeIso remain imported for the WRAPPER
  // merge path only (mergeBackWrapperIso — outside RFC-188's agent-site
  // scope). Wrapper CREATE shares createIsoUnderLock with every AGENT site so
  // sibling `git worktree add` mutations cannot race in the common repository.
  discardNodeIso,
  type IsoHandle,
  type MergeBackConflict,
  mergeBackNodeIso,
  rebuildIsoHandle,
  MergeAgentChildUnreapedError,
  resolveConflictWithAgent,
  snapshotNodeIsoFinal,
  undoPriorShardDeltaInIso,
} from '@/services/nodeIsolation'
// RFC-188: the shared assembly for isolated agent runs — iso lock-window,
// iso-column persistence and the merge-back/settle block (formerly five
// hand-copies in this file).
import {
  createIsoUnderLock,
  markMergeFailed,
  mergeBackAndSettle,
  type MergeSettleOutcome,
  persistIsoBase,
  persistIsoNodeTree,
} from '@/services/isolatedAgentRun'
import {
  buildMergeAgent,
  buildMergeResolvePrompt,
  mergeResolveNodeId,
  type MergeConflictManifest,
} from '@/services/mergeAgent'
import {
  runWorkgroupEngine,
  type WorkgroupEngineHooks,
  type WorkgroupHostRunRequest,
  type WorkgroupHostRunResult,
} from '@/services/workgroup/engine'
import { loadWorkgroupTaskState } from '@/services/workgroup/state'
import { runDynamicWorkflowGenerate } from '@/services/dynamicWorkflowRunner'
import { DW_ORCHESTRATOR_NODE_ID } from '@/services/orchestratorAgent'
import { isWorkgroupTask } from '@agent-workflow/shared'
// RFC-243 §1.2 — the engine fork is decided by the executor registry (a pure
// resolver extracted verbatim from the inline dispatch this file used to own).
import { resolveTaskEngine } from '@/services/execution/engines'
import { getExecutionOutcome } from '@/services/execution/outcome'
import { watchTaskTerminal } from '@/services/execution/executionWatch'
import {
  currentMaxInvocationDepth,
  ensureChildTaskBudget,
  registerKnownChildTask,
} from '@/services/execution/childBudget'
import {
  childClosureSubset,
  frozenWorkflowFromClosure,
  frozenWorkgroupFromClosure,
  type FrozenWorkgroupRef,
} from '@/services/execution/closure'
import { TERMINAL_TASK_STATUSES, type StartTask } from '@agent-workflow/shared'
import type { MaterializedSpace, StartTaskDeps } from '@/services/task'
// RFC-210 replay: submodule topology read-back + the fail-closed gate around it.
import { IsoSubmodulesSchema } from '@agent-workflow/shared'
import { existsSync } from 'node:fs'
import { basename, join as pathJoin } from 'node:path'
// RFC-266: the scheduler no longer CONSTRUCTS any semaphore — all three come
// from the daemon-scoped registries (processNodeConcurrency / taskFanoutPools /
// taskWriteLocks), so a settings change resizes the very instances in use.
import type { Semaphore } from '@/util/semaphore'
import { ulid } from 'ulid'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import { executeCodeHostCall } from '@/services/codeHost/call'
import {
  resolveCodeHostConnectionsFromKeyFile,
  type CodeHostConnectionsService,
} from '@/services/codeHost/connections'
import { resolveProjectFallback } from '@/services/codeHost/project'
import { Paths } from '@/util/paths'
import { sha256Hex } from '@/util/hash'
import { runAssembly, type IsoLike } from '@/services/schedulerAssembly'

export interface RunTaskOptions {
  taskId: string
  db: DbClient
  appHome: string
  /**
   * RFC-304: fences MR leases across a restart. A lease minted by a previous
   * daemon is void, so a machine that died holding leases does not lock every
   * MR it touched until each one expires. Defaults to `'dev'` when unset, which
   * is correct for tests and single-process runs.
   */
  daemonGeneration?: string
  /** TEST-ONLY runtime-neutral command-head override (mock binaries; its
   *  presence also keeps real credential bridges off — RFC-282 C1). */
  binaryOverride?: readonly string[]
  /** Daemon config path — config.opencodePath/claudeCodePath fold into the
   *  FROZEN binary at mint time (RFC-282 C1-2; RFC-111 D15 alignment). */
  configPath?: string
  log?: Logger
  /**
   * When aborted, any node currently running is SIGTERMed via runNode and the
   * task transitions to status=canceled. Subsequent nodes are not started.
   */
  signal?: AbortSignal
  /**
   * Default per-node timeout in ms (from settings). RFC-115: the per-node
   * `timeoutMs` override is removed — this global value applies to every node.
   */
  defaultPerNodeTimeoutMs?: number
  /**
   * RFC-115: global per-node retry budget (from config.defaultNodeRetries).
   * Replaces the per-node `retries` override; `?? 3` fallback for mock/unwired.
   */
  defaultNodeRetries?: number
  /**
   * RFC-313: 同会话追问链触顶后允许整体换几次干净会话（from config.sessionRestartBudget）。
   * 与 defaultNodeRetries 相乘决定 attempt 硬上限，见 shared `retryAttemptCap`。
   */
  sessionRestartBudget?: number
  /**
   * RFC-253 — administrator interpreter overrides for script nodes. Absent
   * entries resolve from the daemon's PATH.
   */
  scriptInterpreters?: Partial<Record<ScriptLanguage, string>>
  /** RFC-253 — wall clock for one dependency-environment build. */
  scriptDepsInstallTimeoutMs?: number
  /**
   * Daemon-wide pool shared across tasks by AGENT-class process nodes — agent
   * nodes, workgroup host nodes, fan-out shards and aggregators. Default 4.
   * RFC-266: script nodes have their own pool below and no longer compete here.
   */
  maxConcurrentNodes?: number
  /** RFC-266: daemon-wide pool for script nodes, independent of the agent pool. Default 4. */
  maxConcurrentScriptNodes?: number
  /** RFC-269: independent pool for code-host call nodes (default 8). */
  maxConcurrentCodeHostCalls?: number
  /** RFC-269: per-request wall clock; node-level `timeoutMs` overrides it. */
  codeHostRequestTimeoutMs?: number
  /** RFC-269: cap on the `response` port value before explicit truncation. */
  codeHostResponseMaxBytes?: number
  /**
   * RFC-269: the credential service. Absent ⇒ code-host nodes fail with
   * `code-host-not-configured` (the same self-skip discipline the OIDC and
   * webhook surfaces use when `secretBox` is missing).
   */
  codeHostConnections?: CodeHostConnectionsService
  /** RFC-269: outbound fetch seam; production omits it, tests inject a stub. */
  codeHostFetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** RFC-321 exact publication transport; tests may inject, production resolves the daemon key. */
  repositoryPublicationTransport?: RepositoryPublicationTransport
  /** Concurrency cap for fan-out child subprocesses (P-3-02). Default 4. */
  multiProcessSubprocessConcurrency?: number
  /**
   * RFC-060 D.T6: runtime cartesian guard for wrapper-fanout. When a single
   * wrapper-fanout (possibly with nested wrapper-fanouts) would mint more
   * than this many total shards, the wrapper finalizes 'failed' with
   * `wrapper-fanout-cartesian-exceeds-max` rather than minting the shards.
   * Default 256.
   */
  fanoutMaxShardTotal?: number
  /** RFC-243 §3.2: daemon-wide active-child-task cap (default 8). */
  maxActiveChildTasks?: number
  /** RFC-243 §3.2: invocation-chain depth ceiling (default 3). */
  maxInvocationDepth?: number
  /**
   * RFC-048: forwarded verbatim to every `runNode` call so the runner spins
   * up its subagent live-capture poller with the operator-configured cadence.
   * Omitted → runner falls back to its compile-time defaults.
   */
  subagentLiveCapture?: { pollMs: number; consecutiveFailureLimit: number }
  /**
   * RFC-075: model for the built-in commit agent (commit message + push
   * repair). Omitted → opencode's installed default. Repair budget + diff
   * truncation use the DEFAULT_COMMIT_PUSH_* constants (Settings wiring is a
   * follow-up; the runtime reads sensible defaults today).
   */
  commitPushModel?: string
  /** RFC-117: runtime profile NAME for the built-in commit agent (config.commitPushRuntime); wins over commitPushModel. */
  commitPushRuntime?: string
  /** RFC-130 §6.1: deprecated model fallback for the built-in merge-conflict resolver agent (config.mergeAgentModel). */
  mergeAgentModel?: string
  /** RFC-130 §6.1: runtime profile NAME for the built-in merge agent (config.mergeAgentRuntime); wins over mergeAgentModel. */
  mergeAgentRuntime?: string
  /** RFC-075: repair-retry budget; falls back to DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES. */
  commitPushMaxRepairRetries?: number
  /** RFC-075: diff byte cap for the commit-message prompt; falls back to DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES. */
  commitPushDiffMaxBytes?: number
  /** RFC-308: immutable exclusion settings slice for this scheduler operation. */
  commitPushExcludePatterns?: readonly string[]
  /** RFC-308: resume/retry asks the scheduler to rebuild persisted worktree profiles. */
  ensureWorkspaceProfiles?: boolean
  /** RFC-157: commit-message output language (initial + repair); undefined ≡ en-US. */
  commitPushLang?: Language
  /**
   * RFC-111 D1/D15 + RFC-112: global default runtime NAME (from
   * config.defaultRuntime). At the agent-dispatch site each node's runtime is
   * resolved once from `agent.runtime ?? defaultRuntime` (name → protocol+binary
   * via the registry) and frozen onto node_runs. resume reads the frozen value.
   * Omitted → 'opencode'. Internal agents (commit&push) stay on opencode (D14).
   */
  defaultRuntime?: string
  // RFC-113 §5: the RFC-112 P2 `claudeCodePath` thread is GONE — the built-in
  // claude binary now lives on the claude runtime row's binary_path (config
  // migrated into it) and flows through the normal runtimeBinary freeze.
}

/**
 * RFC-284 T20（§4）—— 子任务继承面的唯一登记：buildChildDeps 按本清单整体透传，
 * 新增 RunTaskOptions 字段时**必须**在测试的处置表里表态（inherit / per-task /
 * dropped-独立供给），编译期穷尽（satisfies Record<keyof RunTaskOptions,…>）
 * 防「看起来像可继承」的字段被顺手漏配或顺手多配。
 *
 * 实施偏差（相对 design 草稿的「拆 inheritable 嵌套子对象」）：字面嵌套会让
 * RunTaskOptions/StartTaskDeps 的全部构造点与测试夹具连坐改形，而两型 15 个
 * 同名字段的注释各自承载调度语义/路由接线两套契约、不宜合并——注册表 + Pick
 * 派生型给出同等单源与更强的双向锁，类型面零搬迁。
 */
export const INHERITABLE_RUN_CONFIG_KEYS = [
  // RFC-304: identifies the PROCESS, so a child task must carry the same one.
  // A child with a different generation would treat its own parent's live MR
  // leases as void and take an MR out from under a running round.
  'daemonGeneration',
  'binaryOverride',
  'configPath',
  'appHome',
  'defaultPerNodeTimeoutMs',
  'defaultNodeRetries',
  'sessionRestartBudget',
  'defaultRuntime',
  'maxConcurrentNodes',
  'maxConcurrentScriptNodes',
  'maxConcurrentCodeHostCalls',
  'codeHostRequestTimeoutMs',
  'codeHostResponseMaxBytes',
  'multiProcessSubprocessConcurrency',
  'maxActiveChildTasks',
  'maxInvocationDepth',
  'subagentLiveCapture',
  // RFC-308: a child task remains in the same launch operation and must not
  // lose the platform publication policy at the call boundary.
  'commitPushExcludePatterns',
  // RFC-284 T30 修配（用户拍板转正）：RFC-253 两键此前根任务即断线（launch 臂
  // runtime 携带、类型缺席、漏斗丢弃）——修通根侧的同时按拍板下传子任务。
  'scriptInterpreters',
  'scriptDepsInstallTimeoutMs',
] as const satisfies ReadonlyArray<keyof RunTaskOptions>

export type InheritableRunConfig = Pick<
  RunTaskOptions,
  (typeof INHERITABLE_RUN_CONFIG_KEYS)[number]
>

/** 按注册表拾取继承面；undefined 值不落键（保持 exactOptionalPropertyTypes 语义
 *  与旧逐字段 `!== undefined` 展开逐字节同构）。appHome 为必填恒在。 */
export function pickInheritableRunConfig(opts: RunTaskOptions): InheritableRunConfig {
  const out: Record<string, unknown> = {}
  for (const key of INHERITABLE_RUN_CONFIG_KEYS) {
    const value = opts[key]
    if (value !== undefined) out[key] = value
  }
  return out as InheritableRunConfig
}

type NodeStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'interrupted'
  | 'skipped'
  | 'exhausted'
  | 'awaiting_review'
  | 'awaiting_human'

interface SchedulerState {
  db: DbClient
  task: typeof tasks.$inferSelect
  taskId: string
  definition: WorkflowDefinition
  opts: RunTaskOptions
  log: Logger
  inputsMap: Record<string, string>
  /** RFC-292: parsed once from the frozen task row; inherited by every scope. */
  triggerContext: TriggerContext | null
  /**
   * RFC-266: the two INDEPENDENT daemon-wide pools. `agentSem` covers agent
   * nodes, workgroup host nodes and fan-out shards/aggregators; `scriptSem`
   * covers RFC-253 script nodes. A given executor takes exactly ONE of them and
   * never both, so the pools introduce no lock order between themselves.
   */
  agentSem: Semaphore
  scriptSem: Semaphore
  /** RFC-269: the code-host call pool. */
  codeHostSem: Semaphore
  writeSem: Semaphore
  /** RFC-266: per-task fan-out sub-pool, from the daemon-scoped registry so a
   *  settings change reaches a task that is already running. */
  subprocessSem: Semaphore
  /** nodeId → innermost wrapper id containing it. */
  containerOf: Map<string, string>
  /** Top-level scope set of node ids. */
  topLevelIds: Set<string>
  /**
   * RFC-066: per-repo metadata loaded once at scheduler entry, threaded
   * through every templateMeta dispatch + the multi-repo
   * `pre_snapshot_repos_json` write path. Single-repo tasks get a length-1
   * array mirroring the legacy `task.repoPath` / `task.baseBranch` columns
   * (`worktreeDirName: ''`, so `{{__repo_names__}}` renders empty — the
   * single-repo byte-baseline is preserved). Always non-empty; defensive
   * fallback in runTask handles the ultra-rare task row that predates
   * migration 0034's INSERT FROM backfill.
   */
  repos: Array<{
    /** RFC-248 AC-19: 回写 `task_repos.readonly_dirty_count` 时定位行。 */
    repoIndex: number
    repoPath: string
    worktreePath: string
    worktreeDirName: string
    /** RFC-248: 规范仓 key = 挂载路径；'' = 挂根。取代 worktreeDirName。 */
    mountPath: string
    /**
     * RFC-248 D11: 只读成员——不写 pre_snapshot、resume 不回滚、不进 git_diff、
     * 不参与自动提交推送。物理上仍可写（框架不在文件系统层面阻止），任务收尾时
     * 检出 dirty 就发告警。
     */
    readonly: boolean
    baseBranch: string
    /** RFC-187 §4 (Codex impl-gate P1) — per-repo base for the zero-delta-done check.
     *  A multi-repo task's `tasks.worktreePath` is a NON-git parent container, so
     *  diffing it would just throw; each repo must be diffed at its own worktree/base. */
    baseCommit: string | null
  }>
  /**
   * RFC-193 D9 — THIS scope's canonical container root. Top level =
   * `task.worktreePath`; inside a git/loop wrapper the innerState carries the
   * wrapper-canonical's containerPath (single-repo: == repos[0] iso root;
   * multi-repo: their parent dir — same container semantics as
   * task.worktreePath). Consumers that read files relative to "the scope the
   * node lives in" (review fallback chain, S1 repair) use THIS, never
   * task.worktreePath directly — the latter is wrong inside wrappers (the
   * exact bug this RFC roots out).
   */
  scopeRoot: string
  /** RFC-248: 用仓库组启动时的组名快照（`tasks.repo_group_name`）；否则 null。
   *  只喂 `{{__repo_group__}}` 占位符用。 */
  repoGroupName: string | null
}

/**
 * Drive one task from "pending" to a terminal status. Caller decides whether
 * to await this (tests) or fire-and-forget (HTTP route).
 */

/** RFC-282 C1-2 — config binary fallbacks for the mint-time freeze. Read at
 *  freeze time (same read-current family as the old per-entry resolution),
 *  then immutable on the node_run row. */
function freezeBinaryConfig(
  configPath: string | undefined,
): { opencodePath?: string | null; claudeCodePath?: string | null } | undefined {
  if (configPath === undefined || configPath === '') return undefined
  try {
    const cfg = loadConfig(configPath)
    return { opencodePath: cfg.opencodePath ?? null, claudeCodePath: cfg.claudeCodePath ?? null }
  } catch {
    return undefined
  }
}

/** RFC-308: one immutable settings slice per commit/freeze operation. */
export function readCommitExcludePatterns(opts: RunTaskOptions): readonly string[] {
  if (opts.configPath !== undefined && opts.configPath !== '') {
    try {
      return [...loadConfig(opts.configPath).taskCommitExcludePatterns]
    } catch {
      // Launch-time snapshot is the safe fallback when a concurrent manual
      // edit leaves config temporarily unreadable.
    }
  }
  return [...(opts.commitPushExcludePatterns ?? [])]
}

export async function runTask(opts: RunTaskOptions): Promise<void> {
  // RFC-098 B1: the per-task write-lock registry entry is gc'd here and ONLY
  // here (taskWriteLocks.ts lifecycle — an HTTP-side gc would split-brain the
  // mutex against our cached SchedulerState.writeSem reference).
  // RFC-266: the fan-out sub-pool registry entry follows the SAME rule and the
  // same reasoning (a split pool would run a task at double its configured
  // shard concurrency), so it is reclaimed in this one place too.
  try {
    await runTaskInner(opts)
  } finally {
    gcTaskWriteSem(opts.taskId)
    gcTaskFanoutSem(opts.taskId)
  }
}

async function runTaskInner(opts: RunTaskOptions): Promise<void> {
  const log = opts.log ?? createLogger('scheduler')
  const { db, taskId } = opts

  // 1. Load task row.
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const task = taskRows[0]
  if (!task) {
    log.error('runTask: task not found', { taskId })
    return
  }

  // RFC-066 PR-B T9: load per-repo metadata once at the top so every runner
  // dispatch site can thread it through `templateMeta.repos` without an extra
  // round-trip. Single-repo tasks get a length-1 array mirroring the legacy
  // `tasks.*` columns (`worktreeDirName === ''` → `{{__repo_names__}}`
  // renders empty, byte-baseline). Defensive fallback handles the ultra-rare
  // case of a task row predating migration 0034's INSERT FROM backfill.
  const repoRows = await db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, taskId))
    .orderBy(asc(taskRepos.repoIndex))
  const repos: SchedulerState['repos'] =
    repoRows.length > 0
      ? repoRows.map((r) => ({
          repoIndex: r.repoIndex,
          repoPath: r.repoPath,
          worktreePath: r.worktreePath,
          worktreeDirName: r.worktreeDirName,
          // RFC-248: 真值来自 DB 列（migration 0131 已 backfill 存量行）。
          mountPath: r.mountPath,
          readonly: r.readonly,
          baseBranch: r.baseBranch,
          baseCommit: r.baseCommit,
        }))
      : [
          {
            repoIndex: 0,
            repoPath: task.repoPath,
            worktreePath: task.worktreePath,
            worktreeDirName: '',
            mountPath: '',
            readonly: false,
            baseBranch: task.baseBranch,
            baseCommit: task.baseCommit,
          },
        ]

  // RFC-308: resume/retry/recovery never trust a profile left by the prior
  // process or by an agent. Rebuild the exact per-worktree profile before any
  // runner can observe or mutate the workspace.
  if (
    repoRows.length > 0 &&
    (opts.ensureWorkspaceProfiles === true ||
      repoRows.some(
        (row) => row.workspaceProfileVersion !== 1 || row.workspaceProfileDigest === null,
      ))
  ) {
    try {
      const allMounts = repos.map((repo) => repo.mountPath)
      for (const repo of repos) {
        const receipt = await bindWorkspaceExcludeParticipant({
          worktreePath: repo.worktreePath,
          appHome: opts.appHome ?? Paths.root,
        }).ensure({ directChildMounts: exclusionPlanFor(repo.mountPath, allMounts) })
        await db
          .update(taskRepos)
          .set({
            workspaceProfileVersion: receipt.version,
            workspaceProfileDigest: receipt.digest,
          })
          .where(and(eq(taskRepos.taskId, taskId), eq(taskRepos.repoIndex, repo.repoIndex)))
      }
    } catch (error) {
      await failTask(
        db,
        taskId,
        'workspace-exclude-profile-failed',
        error instanceof Error ? error.message : String(error),
      )
      return
    }
  }

  // 2. Parse workflow snapshot.
  let definition: WorkflowDefinition
  try {
    const raw: unknown = JSON.parse(task.workflowSnapshot)
    definition = migrateWorkflowDefinitionToLatest(WorkflowDefinitionSchema.parse(raw))
  } catch (err) {
    await failTask(db, taskId, 'snapshot-invalid', (err as Error).message)
    return
  }

  // RFC-292: keep NULL, valid context and corrupt JSON distinct. Historical
  // flat RFC-269 rows are wrapped in memory by the shared decoder.
  const parsedTriggerContext = parseTriggerContextJson(task.triggerContextJson)
  const triggerIssue = triggerPreflightIssue({
    root: definition,
    closureJson: task.refClosureJson,
    source: parsedTriggerContext,
  })
  if (triggerIssue !== null) {
    await failTask(db, taskId, triggerIssue.code, triggerIssue.code)
    return
  }
  const triggerContext = parsedTriggerContext.kind === 'ok' ? parsedTriggerContext.value : null

  // 3. Mark running — CAS from 'pending' ONLY (RFC-097, audit S-8/S-14).
  // The unconditional write here used to revive canceled/done tasks and let a
  // second runTask take over a live one. CAS loss → another driver owns the
  // task (or it is terminal): log and step away without minting anything.
  const claimed = await trySetTaskStatus({
    db,
    taskId,
    to: 'running',
    allowedFrom: ['pending'],
    reason: 'runTask-start',
  })
  if (!claimed) {
    log.warn('runTask: task not claimable (not pending) — refusing to drive it', { taskId })
    return
  }
  await emitStatus(db, taskId)

  // 4. Validate node kinds. RFC-146: positive membership in the behavior
  // table — a kind the scheduler knows is exactly a kind with a behavior row.
  // (The historical negative enum listed 6 `!==` clauses and silently
  // admitted nothing new; now adding a NodeKind admits it here by
  // construction, and runOneNode's fall-through guard catches kinds the
  // dispatch switch doesn't actually handle yet.)
  for (const node of definition.nodes) {
    // Object.hasOwn (not `in`) — inherited keys must not pass the whitelist.
    if (!Object.hasOwn(NODE_KIND_BEHAVIORS, node.kind)) {
      await failTask(
        db,
        taskId,
        `scheduler does not yet support ${node.kind} nodes`,
        `node kind ${node.kind} unsupported`,
        node.id,
      )
      return
    }
  }

  // Defense in depth for legacy/imported snapshots that predate the validator
  // rule. Scheduler maps key by node id; allowing duplicates would silently
  // fold one node away and the later topological check would lie to the user
  // with an unrelated cycle error.
  const nodeIdCounts = new Map<string, number>()
  for (const node of definition.nodes) {
    nodeIdCounts.set(node.id, (nodeIdCounts.get(node.id) ?? 0) + 1)
  }
  const duplicateNode = [...nodeIdCounts].find(([, count]) => count > 1)
  if (duplicateNode !== undefined) {
    const [nodeId, count] = duplicateNode
    await failTask(
      db,
      taskId,
      'workflow-node-id-duplicate',
      `node id '${nodeId}' appears ${count} times; node ids must be unique`,
      nodeId,
    )
    return
  }

  // Wrapper containment is the coordinate system for recursive scheduling.
  // Launch validation normally guarantees a tree, but imported/historical
  // snapshots and direct DB callers can bypass it. Never execute against the
  // deterministic diagnostic fallback map when membership is ambiguous:
  // two wrappers could otherwise dispatch the same child concurrently.
  const scopeTree = analyzeWorkflowScopeTree(definition)
  const containmentIssue = scopeTree.issues[0]
  if (containmentIssue !== undefined) {
    const failedNodeId =
      containmentIssue.code === 'wrapper-containment-cycle'
        ? containmentIssue.cycle[0]
        : containmentIssue.code === 'wrapper-child-multiple-parents'
          ? containmentIssue.childId
          : containmentIssue.wrapperId
    await failTask(
      db,
      taskId,
      'wrapper-containment-invalid',
      `${containmentIssue.code}: ${JSON.stringify(containmentIssue)}`,
      failedNodeId,
    )
    return
  }

  // RFC-248 D9: 多仓 + wrapper-git 的禁令**已解除**。RFC-066 当年禁它是因为
  // 包裹器只会对单一 worktree 取快照；现在它逐仓快照、逐仓 diff，并把每个仓的
  // 路径用挂载路径前缀化后合并成一个 `list<path>`（见 runGitWrapperNode）。
  // 这里原本有一条 `multi-repo-wrapper-git-unsupported` 的纵深防御门，随禁令
  // 一并删除——留着它会让组任务永远跑不了平台的 Code → Audit → Fix 主链路。

  // 5. Direct child → wrapper map. Chained entries retain nested scope ancestry.
  const containerOf = scopeTree.parents
  const topLevelIds = new Set<string>()
  for (const n of definition.nodes) {
    if (!containerOf.has(n.id)) topLevelIds.add(n.id)
  }

  // 6. Pre-validate the same projected graph the runtime frontier will use.
  //    Raw-edge filtering misses cycles that cross a wrapper boundary.
  const topLevelNodes = definition.nodes.filter((n) => topLevelIds.has(n.id))
  const topLevelUpstreams = buildScopeUpstreams(definition, topLevelIds, null, containerOf)
  if (findScopeCycle(topLevelNodes, topLevelUpstreams) !== null) {
    await failTask(db, taskId, 'workflow has a cycle outside any loop wrapper', 'cycle detected')
    return
  }

  // 7. Inputs map from launcher form.
  const inputsMap: Record<string, string> = (() => {
    try {
      return JSON.parse(task.inputs) as Record<string, string>
    } catch {
      return {}
    }
  })()

  const state: SchedulerState = {
    db,
    task,
    taskId,
    definition,
    opts,
    // RFC-248: 组名**快照**（`tasks.repo_group_name`）——组被删除后仍能渲染，
    // 这正是 D8 存这一列的理由。
    repoGroupName: task.repoGroupName ?? null,
    log,
    inputsMap,
    triggerContext,
    // RFC-266: two independent daemon-wide pools (script nodes no longer queue
    // behind agent runs). Both come from the daemon-scoped registry, which
    // resizes the SAME instance when the setting changes — so a settings save
    // applies to this run, not just to the next launch.
    agentSem: getNodePoolSemaphore(db, 'agent', opts.maxConcurrentNodes ?? 4, 'seed-only'),
    scriptSem: getNodePoolSemaphore(db, 'script', opts.maxConcurrentScriptNodes ?? 4, 'seed-only'),
    // RFC-269: the third pool — one outbound HTTP request is a second-scale
    // step and holds no subprocess, so it gets its own (larger) budget.
    codeHostSem: getNodePoolSemaphore(
      db,
      'code-host',
      opts.maxConcurrentCodeHostCalls ?? 8,
      'seed-only',
    ),
    // RFC-098 B1 (audit S-9): the writer lock comes from the per-task
    // registry so HTTP rollback paths (clarify/review/cross-clarify) hold THE
    // SAME instance. gc happens in this function's finally only (see
    // taskWriteLocks.ts lifecycle doc).
    writeSem: getTaskWriteSem(taskId),
    // RFC-266: from the per-task registry (same lifecycle rule as writeSem) so
    // PUT /api/config can resize a RUNNING task's fan-out. Before RFC-266 this
    // was a local `new Semaphore(...)` fed by a value nothing ever threaded.
    subprocessSem: getTaskFanoutSem(taskId, opts.multiProcessSubprocessConcurrency ?? 4),
    containerOf,
    topLevelIds,
    // RFC-066: thread per-repo metadata through every inner dispatch.
    repos,
    // RFC-193 D9: top-level scope canonical = the task worktree container.
    scopeRoot: task.worktreePath,
  }

  // 8. Drive the top-level scope. Any thrown error must land the task in
  // `failed` rather than wedge it on `running`: runTask is fire-and-forget from
  // the HTTP/resume path, so an unhandled rejection (e.g. an illegal node_run
  // transition, or a DB error inside a sink/wrapper branch that — unlike the
  // agent path — has no local try/catch) would otherwise leave the task stuck
  // `running` and unresumable (resumeTask refuses `running`). See
  // scheduler-boundary-wrapper-resume-interrupted.test.ts.
  let result: ScopeResult
  try {
    // RFC-130 T3c2: recover any 'pending-merge' rows from a crash between
    // agent-success and merge-back BEFORE the scope runs (so the frontier only
    // sees merged rows). A no-op on a fresh run / non-isolated task.
    await replayPendingMerges(state, log)
    // RFC-130 §6.3 resume: complete any conflict-human node whose human resolved
    // its conflict in the preserved resolve-iso (flips 'merged' + releases
    // downstream; still-unresolved stays parked). No-op on a fresh run.
    await replayConflictHumanResolutions(state, log)
    // RFC-164: workgroup tasks are driven by the round engine, NEVER by the
    // DAG frontier (design §4). The host snapshot's nodes exist only as mint
    // anchors + clarify wiring; runScope/deriveFrontier must not see them.
    // RFC-167: dynamic_workflow workgroups are the exception — their dispatch
    // follows the dw phase. RFC-243 §1.2: the decision itself now lives in
    // the executor engine registry (resolveTaskEngine — same oracle, extracted
    // verbatim); this file keeps consuming it. RFC-217 T2: the phase lives in
    // workgroup_task_state (an unknown mode still routes to the turn engine,
    // which fails with its own precise config diagnostics).
    const { engine, wgDispatch } = resolveTaskEngine(
      task,
      isWorkgroupTask(task)
        ? ((await loadWorkgroupTaskState(db, taskId)).dwState?.phase ?? null)
        : null,
    )
    if (
      wgDispatch === 'dw-execute' &&
      definition.nodes.some((n) => n.id === DW_ORCHESTRATOR_NODE_ID)
    ) {
      // Fail-fast invariant (design §3): phase='executing' promises the
      // snapshot is the confirmed generated DAG. Running the generation host
      // snapshot through runScope would dispatch the orchestrator node as a
      // regular agent — refuse loudly instead.
      await failTask(
        db,
        taskId,
        'dw-phase-invariant',
        `task is phase='executing' but its snapshot still contains the generation host node`,
      )
      return
    }
    result =
      engine === 'dw-generate'
        ? await runDynamicWorkflowGenerate({
            db,
            taskId,
            log,
            ...(opts.signal ? { signal: opts.signal } : {}),
            hooks: buildWorkgroupHooks(state),
          })
        : engine === 'workgroup-turns'
          ? await runWorkgroupEngine({
              db,
              taskId,
              log,
              ...(opts.signal ? { signal: opts.signal } : {}),
              hooks: buildWorkgroupHooks(state),
            })
          : await runScope(state, {
              scopeId: null,
              scopeIds: topLevelIds,
              iteration: 0,
              log,
            })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('runTask: scope threw — failing task', { taskId, error: message })
    await failTask(db, taskId, 'scheduler error', message)
    return
  }

  // RFC-248 AC-19（实现门 P1）：只读成员的脏检查必须在**每一条终态路径**上都
  // 跑一次，而不是搭在自动提交推送里——`maybeRunCommitPush` 只在
  // `task.autoCommitPush` 开启且顶层节点成功后触发，于是默认配置的任务、以及
  // 失败 / 取消的任务，`readonly_dirty_count` 永远是 NULL、详情页永远没有提示。
  // 放在这里：跑完节点、分派终态之前，done / failed / canceled / awaiting_* 全覆盖。
  //
  // 包 try/catch：这只是一条给人看的通报，绝不能因为它把任务收尾搞垮。
  try {
    await inspectReadonlyRepos(state, log)
  } catch (err) {
    log.warn('[rfc248/readonly-dirty] inspection failed (ignored)', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  if (result.kind === 'failed' && result.detail) {
    await failTask(db, taskId, result.detail.summary, result.detail.message, result.detail.nodeId)
    return
  }
  if (result.kind === 'canceled') {
    await cancelTaskRow(db, taskId, result.detail?.nodeId, opts.signal?.reason)
    return
  }
  if (result.kind === 'awaiting_review') {
    // RFC-005: task pauses with status=awaiting_review until a decision lands
    // via REST. Decision handler will call resumeTask which re-enters here.
    // RFC-097: cancel wins — an abort that landed after runScope's last
    // signal check must not be overwritten by a park/terminal write.
    if (opts.signal?.aborted === true) {
      await cancelTaskRow(db, taskId, undefined, opts.signal.reason)
      return
    }
    if (
      await trySetTaskStatus({
        db,
        taskId,
        to: 'awaiting_review',
        allowedFrom: ['running'],
        reason: 'scope-awaiting-review',
      })
    ) {
      await emitStatus(db, taskId)
      log.info('task awaiting human review', { taskId })
    } else {
      log.warn('awaiting_review write lost to a concurrent transition — respecting winner', {
        taskId,
      })
    }
    return
  }
  if (result.kind === 'awaiting_human') {
    // RFC-023: an agent (or one or more agent-multi shard children) emitted a
    // <workflow-clarify> envelope. The clarify node_run is parked
    // awaiting_human; the source agent has no rerun row yet — that's
    // created when the user POSTs answers. Per design §7.3 awaiting_human
    // outranks awaiting_review on the task chip when both can fire at once.
    if (opts.signal?.aborted === true) {
      await cancelTaskRow(db, taskId, undefined, opts.signal.reason)
      return
    }
    if (
      await trySetTaskStatus({
        db,
        taskId,
        to: 'awaiting_human',
        allowedFrom: ['running'],
        reason: 'scope-awaiting-human',
      })
    ) {
      await emitStatus(db, taskId)
      log.info('task awaiting human clarification', { taskId })
    } else {
      log.warn('awaiting_human write lost to a concurrent transition — respecting winner', {
        taskId,
      })
    }
    return
  }

  // 9. Done. RFC-097: cancel wins — final aborted check before the terminal
  // CAS; a cancelTask fallback racing us resolves by whoever's CAS lands
  // (from-sets are disjoint winners: done from=running vs canceled CAS).
  if (opts.signal?.aborted === true) {
    await cancelTaskRow(db, taskId, undefined, opts.signal.reason)
    return
  }
  if (
    await trySetTaskStatus({
      db,
      taskId,
      to: 'done',
      allowedFrom: ['running'],
      extra: { finishedAt: Date.now() },
      reason: 'task-done',
    })
  ) {
    await emitStatus(db, taskId)
    log.info('task done', { taskId })
  } else {
    log.warn('done write lost to a concurrent transition — respecting winner', { taskId })
  }
}

// -----------------------------------------------------------------------------
// RFC-164 — workgroup engine integration. The engine (workgroupRunner.ts) owns
// orchestration; this hook owns the MECHANICS of one host-node run, copied
// from the fanout-shard dispatch path (iso worktree + frozen runtime +
// runNode + merge-back + clarify session). Kept here so workgroupRunner never
// imports scheduler.ts (module-cycle ban — binary-build incident memory).
// -----------------------------------------------------------------------------

export function buildWorkgroupHooks(state: SchedulerState): WorkgroupEngineHooks {
  const { db, taskId, task, opts, log, definition } = state
  async function runHostNode(req: WorkgroupHostRunRequest): Promise<WorkgroupHostRunResult> {
    const injection = await resolveInjection(db, req.agent, { appHome: opts.appHome, log })
    if (injection.kind === 'failed') {
      await setNodeRunStatus({
        db,
        nodeRunId: req.nodeRunId,
        to: 'failed',
        allowedFrom: ['pending'],
        reason: 'wg-injection-failed',
        extra: { finishedAt: Date.now(), errorMessage: injection.message },
      })
      broadcastNodeStatus(taskId, req.nodeRunId, req.nodeId, 'failed')
      return { status: 'failed', outputs: {}, errorMessage: injection.message }
    }

    let iso: IsoHandle
    // RFC-210 impl-gate A1-fix (review round 2): a merge/snapshot THROW keeps
    // the iso. The publish path hard-fails BEFORE the node tree is persisted,
    // so entry replay has nothing to work from and the iso can hold the sole
    // copy of the run's submodule work.
    // RFC-287 T6：本线改走骨架。它是五条里处置最全的一条——四种跳合并/覆写全用到。
    // 切法：spawn **把早退结局原样打包传出**（判别式返回），骨架只管相位与清理，
    // 从而不必重构 spawn 之后那段带多处早退的分支（clarify 停靠两种结局、canceled、
    // 非 done），逐字保住其语义。
    let keepHookIso = false
    let hookIso: IsoHandle | null = null
    type HostSpawn =
      | { kind: 'early'; out: WorkgroupHostRunResult }
      | { kind: 'ran'; result: RunResult; projected: Record<string, string> }
    return await runAssembly<Record<string, never>, HostSpawn, WorkgroupHostRunResult>(
      {},
      {
        // RFC-208：许可由骨架自己取自己放——外面先抢再传进来会留出「抢到许可 ~
        // 进 runAssembly」这段无人兜底的窗口。全五条线同一口径。
        pools: [state.agentSem],
        iso: {
          create: async () => {
            hookIso = await createIsoUnderLock({
              writeSem: state.writeSem,
              appHome: opts.appHome,
              taskId,
              db,
              isoKeyRunId: req.nodeRunId,
              canonRepos: state.repos,
              log,
            })
            iso = hookIso
            return hookIso
          },
          persistBase: 'in-setup',
          persist: async (h: IsoLike) => {
            if (!h.passthrough) await persistIsoBase(db, req.nodeRunId, task.repoCount, iso)
          },
        },
        onIsoSetupFailure: (err) => {
          const message = err instanceof Error ? err.message : String(err)
          log.warn('workgroup host-node iso setup failed', { nodeRunId: req.nodeRunId, message })
          return { status: 'failed', outputs: {}, errorMessage: `iso-setup-failed: ${message}` }
        },
        spawn: async (): Promise<HostSpawn> => {
          const frozen = await resolveFrozenRuntime(
            db,
            req.nodeRunId,
            req.agent.runtime,
            opts.defaultRuntime,
            null,
            freezeBinaryConfig(opts.configPath),
          )
          // Round-trip a human's answered clarify back to the workgroup LEADER.
          // When the leader host run is a `clarify-answer` rerun — it asked a human
          // via <workflow-clarify>, the human answered, and the STANDARD dispatch
          // minted this pending row (nodeId=__wg_leader__, cause='clarify-answer')
          // which workgroupRunner adopts as req.nodeRunId — buildClarifyQueueContext
          // returns the flat `## Clarify Q&A` block. renderUserPrompt emits it in
          // `sections`, independent of the workgroup protocol block that owns
          // `trailing`, and the 'delegated' directive (RFC-183) keeps the run out
          // of mandatory clarify-only mode. Without it the leader never sees the answers
          // it asked for and re-asks / proceeds on wrong assumptions (Codex review 1
          // P1 — the workgroup half of the RFC-023 round-trip was unwired).
          //
          // LEADER-ONLY (Codex review 2 P1): selectAgentQueue selects AND ages purely
          // by consumerNodeId with NO shardKey scoping (clarifyQueue.ts). The leader
          // is a singleton host node (shardKey=null), so its queue is unambiguous.
          // But EVERY member assignment shares the one __wg_member__ node (separated
          // only by node_runs.shard_key), so injecting there would cross-contaminate
          // — member B's run would receive member A's answered Q&A and B's output
          // would age A's queue. Member human-clarify round-trip therefore needs
          // shardKey-scoped queue selection (a change to the shared clarify
          // machinery) and stays deferred; a member's answers simply don't return
          // yet (no corruption, unlike the unscoped inject).
          // RFC-172 (route 2, R2-T7): round-trip the human's answered clarify back to ANY host node
          // (leader or member), SCOPED to this run's shard. On a clarify-answer rerun the dispatch minted
          // this pending row on the asking run's own shard (S0–S3); passing that shard to
          // buildClarifyQueueContext makes selectAgentQueue (R2-T3) isolate the queue per assignment.
          // A leader run is shardKey=null → pass `undefined` (node-scoped = exact pre-route-2 leader
          // behavior); a member run passes its assignment shard so concurrent members never inject each
          // other's Q&A. Fresh (non-answer) turns get an empty queue → no injection.
          const runRow = (
            await db
              .select({ shardKey: nodeRuns.shardKey, envelopeNonce: nodeRuns.envelopeNonce })
              .from(nodeRuns)
              .where(eq(nodeRuns.id, req.nodeRunId))
              .limit(1)
          )[0]
          const runShardKey = runRow?.shardKey ?? null
          const clarifyQueue = await buildClarifyQueueContext({
            db,
            definition,
            taskId,
            consumerNodeId: req.nodeId,
            dispatchedRunId: req.nodeRunId,
            shardKey: runShardKey === null ? undefined : runShardKey,
            iteration: 0,
            envelopeNonce: runRow?.envelopeNonce ?? '',
          })
          // RFC-184: workgroup host runs project the member agent's outputs to the
          // role's wg_* protocol ports and clear outputKinds, so runNode parses/
          // returns the wg ports and never validates the member's own business
          // output kinds (F42SE root cause). resolveInjection above already
          // ran on the ORIGINAL req.agent (skills/mcp/deps are unaffected by this
          // projection). Dynamic orchestrator runs leave hostOutputPorts unset →
          // no projection (design.md §2.2/§2.4).
          const hostAgent =
            req.hostOutputPorts !== undefined
              ? { ...req.agent, outputs: req.hostOutputPorts, outputKinds: undefined }
              : req.agent
          const result = await runNode({
            taskId,
            nodeRunId: req.nodeRunId,
            nodeId: req.nodeId,
            agent: hostAgent,
            triggerContext: null,
            // RFC-184 §2.4: host runs never persist their protocol ports into
            // node_run_outputs (they'd trip clarify-aging runIdsWithOutput).
            ...(req.hostOutputPorts !== undefined
              ? { persistDeclaredOutputs: false, warnMissingDeclaredPorts: false }
              : {}),
            runtime: frozen.protocol,
            runtimeBinary: frozen.binary,
            runtimeParams: frozen.params,
            runtimeConfigDir: frozen.configDir,
            inputs: {},
            worktreePath: iso.repos[0]?.isoWorktreePath ?? task.worktreePath,
            gitUserName: task.gitUserName,
            gitUserEmail: task.gitUserEmail,
            templateMeta: {
              repoPath: iso.repos[0]?.isoWorktreePath ?? task.repoPath,
              baseBranch: task.baseBranch,
              taskId,
              nodeId: req.nodeId,
              repos: iso.repos.map((r, i) => ({
                repoPath: r.repoPath,
                worktreePath: r.isoWorktreePath,
                worktreeDirName: r.worktreeDirName,
                // RFC-248: 同上——`{{__repo_names__}}` 要渲染挂载路径。
                mountPath: state.repos[i]?.mountPath ?? r.worktreeDirName,
                baseBranch: r.baseBranch,
              })),
            },
            promptTemplate: req.promptTemplate,
            // Workgroup turns and the dynamic-workflow orchestrator hand us a
            // COMPLETE framework-composed prompt. Its fenced goal/charter/messages
            // are data, not a second workflow template: preserving this boundary
            // keeps literal `{{token}}` text byte-for-byte.
            expandPromptTemplate: false,
            ...(req.workgroupProtocolBlock !== undefined
              ? { workgroupProtocolBlock: req.workgroupProtocolBlock }
              : {}),
            ...(opts.defaultPerNodeTimeoutMs !== undefined
              ? { timeoutMs: opts.defaultPerNodeTimeoutMs }
              : {}),
            // Voluntary ask-back: the channel is wired (host snapshot) but never
            // mandatory — workgroup members produce wg_result unless they choose
            // to ask a human (design §5). RFC-183: directive 'delegated' — BOTH
            // the invite (WG_CLARIFY_BLOCK inside the workgroup protocol block,
            // only when the group is not autonomous) and the acceptance verdict
            // live OUTSIDE the ADT, so the runner's directive-driven reject
            // (which now fires on 'suppressed') must not apply here.
            // RFC-181 C (impl-gate P1/P2): suppression is NOT a dispatch-frozen
            // directive — the per-task PATCH can flip `autonomous` mid-run in
            // EITHER direction, so runNode resolves the oracle below at ENVELOPE
            // time (live both ways) and closes a suppressed run as
            // failed:clarify-forbidden BEFORE terminal persistence.
            clarifyChannel: { kind: 'self', directive: 'delegated', injectStopNotice: false },
            ...(req.clarifyEnabled !== undefined
              ? {
                  clarifySuppressed: () =>
                    // RFC-207 §3.4a — dispatch-time floor. This turn's prompt carried no
                    // ask-back invite, so it must not be allowed to ask merely because the
                    // roster gained a human while it was running; the new human takes
                    // effect from the NEXT turn. The live read handles the other
                    // direction (a human leaving mid-flight must silence it at once).
                    req.clarifyEnabled === false
                      ? Promise.resolve(true)
                      : isTaskClarifySuppressed(db, taskId, req.nodeId, runShardKey),
                }
              : {}),
            ...(clarifyQueue !== undefined
              ? { clarifyContext: { flatBlock: clarifyQueue.block } }
              : {}),
            skills: injection.spec.skills,
            dependents: injection.spec.dependents,
            mcps: injection.spec.mcps,
            plugins: injection.spec.plugins,
            appHome: opts.appHome,
            ...(opts.binaryOverride ? { binaryOverride: opts.binaryOverride } : {}),
            db,
            log,
            ...(opts.signal ? { signal: opts.signal } : {}),
            ...(opts.subagentLiveCapture !== undefined
              ? { subagentLiveCapture: opts.subagentLiveCapture }
              : {}),
          })
          const early = await (async (): Promise<WorkgroupHostRunResult | null> => {
            if (result.processUnreaped === true) keepHookIso = true
            broadcastNodeStatus(taskId, req.nodeRunId, req.nodeId, result.status)
            if (result.status === 'canceled') {
              return {
                status: 'canceled',
                outputs: {},
                ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
                ...(result.processUnreaped === true ? { processUnreaped: true as const } : {}),
              }
            }
            if (result.clarify !== undefined) {
              // RFC-181 C — a clarify envelope survived runNode's envelope-time
              // oracle (resolver said "allowed" when it fired). The toggle can still
              // land BETWEEN that read and the session insert below (impl-gate
              // P1-③), so: (a) one fresh pre-create check narrows the window; (b)
              // the post-create compensation after the insert closes it — both
              // return the same suppressed failure the workgroup runner re-prompts
              // on. The row is already terminal `done` here (valid clarify keeps
              // status=done), hence the allowTerminal correction so the DB row, the
              // broadcast and the RFC-182 room card all tell the truth.
              const lateSuppress = async (): Promise<WorkgroupHostRunResult> => {
                const dropped = result.clarify?.questions.length ?? 0
                const suppressedMsg = `${CLARIFY_FORBIDDEN_PREFIX}: ask-back disabled mid-run (autonomous); dropped ${dropped} question(s)`
                await setNodeRunStatus({
                  db,
                  nodeRunId: req.nodeRunId,
                  to: 'failed',
                  allowedFrom: ['done'],
                  allowTerminal: true,
                  reason: 'wg-clarify-suppressed-late',
                  extra: {
                    finishedAt: Date.now(),
                    errorMessage: suppressedMsg,
                    failureCode: 'clarify-forbidden',
                  },
                })
                broadcastNodeStatus(taskId, req.nodeRunId, req.nodeId, 'failed')
                // failureCode mirrors the DB column so the engine's soft-reject branch
                // routes structurally (RFC-145: errorMessage is human breadcrumbs, never
                // a machine key) — without it this late path forced a startsWith match.
                return {
                  status: 'failed',
                  outputs: {},
                  errorMessage: suppressedMsg,
                  failureCode: 'clarify-forbidden',
                }
              }
              if (
                req.clarifyEnabled !== undefined &&
                (await isTaskClarifySuppressed(db, taskId, req.nodeId, runShardKey))
              ) {
                return await lateSuppress()
              }
              // RFC-172 (route 2, R2-T7): human ask-back is now enabled for EVERY workgroup host node
              // (leader AND members), no longer leader-only. The dispatch/mint pipeline (S0–S3) mints each
              // member's clarify-answer rerun on ITS OWN shard, and selectAgentQueue (R2-T3) + the run's
              // shardKey passed to buildClarifyQueueContext below scope the queue per assignment — so a
              // member's answer round-trips to its own run with no cross-contamination between concurrent
              // members and no dangling `processing` entry. (The interim reject that guarded the unwired
              // member path — a failed result with a not-supported error — is removed.)
              const clarifyNodeId = findClarifyNodeForAgent(definition, req.nodeId)
              if (clarifyNodeId === undefined) {
                return { status: 'failed', outputs: {}, errorMessage: 'clarify-no-channel' }
              }
              const currentRunRow = (
                await db.select().from(nodeRuns).where(eq(nodeRuns.id, req.nodeRunId)).limit(1)
              )[0]
              // RFC-172 (route 2, R2-T6): host clarify GENERATION — count this (node, iteration, shard)'s
              // prior DONE clarify generations (shardKey-aware; mirrors the normal-node path ~scheduler.ts
              // 3540) instead of the old hardcoded 0. A host run (leader OR member) asking a SECOND round
              // otherwise shares the first round's clarify node_run (findClarifyNodeRunForShard is
              // idempotent on iterationIndex → its questions overwrite the first's and selectAgentQueue's
              // per-origin resolve turns ambiguous). shardKey-scoped so concurrent members count only
              // their OWN prior generations.
              const askingGeneration = currentRunRow
                ? (
                    await priorDoneGenerationsForRun(db, {
                      taskId,
                      nodeId: req.nodeId,
                      iteration: currentRunRow.iteration,
                      shardKey: currentRunRow.shardKey ?? null,
                      id: currentRunRow.id,
                    })
                  ).length
                : 0
              await createClarifyRound({
                kind: 'self',
                db,
                taskId,
                askingNodeId: req.nodeId,
                askingNodeRunId: req.nodeRunId,
                askingShardKey: currentRunRow?.shardKey ?? null,
                intermediaryNodeId: clarifyNodeId,
                iteration: askingGeneration,
                questions: result.clarify.questions,
                ...(result.clarify.truncationWarnings.length > 0
                  ? { truncationWarnings: result.clarify.truncationWarnings }
                  : {}),
              })
              // RFC-181 C impl-gate P1-③ — close the check→insert TOCTOU: a toggle
              // that landed between the pre-create read and the insert above left a
              // session A2 never saw (the PATCH-side dismissal ran against an empty
              // set). Re-check AFTER the insert and compensate through the same A2
              // primitive — idempotent against a concurrent PATCH-side dismissal
              // (both CAS on awaiting_human, the loser no-ops).
              if (
                req.clarifyEnabled !== undefined &&
                (await isTaskClarifySuppressed(db, taskId, req.nodeId, runShardKey))
              ) {
                const dismissed = await dismissOpenClarifyParksForAutonomous(db, taskId)
                // 182 impl-gate P1 — only rewrite the asking run when the dismissal
                // actually took the session down. Zero dismissals means an answer
                // beat this re-check (session already answered / continuation
                // minted): flipping done→failed then would show「已回答并续跑」and
                //「反问已压制」on the SAME turn. The answer won — keep the normal
                // awaiting result (status quo ante for that race).
                if (dismissed.dismissedSessions > 0) return await lateSuppress()
              }
              return {
                status: 'awaiting',
                outputs: {},
                clarifyQuestionCount: result.clarify.questions.length,
              }
            }
            if (result.status !== 'done') {
              return {
                status: 'failed',
                outputs: {},
                errorMessage: result.errorMessage ?? `run-${result.status}`,
                // RFC-185 e2e hardening — carry the structured code so the workgroup
                // engine can route envelope-missing into its protocol-retry channel
                // (RFC-145 ratchet: never route on errorMessage text).
                ...(result.failureCode !== undefined ? { failureCode: result.failureCode } : {}),
                ...(result.processUnreaped === true ? { processUnreaped: true as const } : {}),
              }
            }
            return null
          })()
          // RFC-184 §2.3: a projected host run's declared-but-omitted wg_* ports come
          // back as '' (parseEnvelope materializes them). Drop those so the workgroup
          // runner's `outputs[port] !== undefined` required/optional checks see
          // "omitted" (undefined), not an empty string that would fail JSON.parse and
          // be mis-flagged a protocol violation. No-op when not a host run.
          const projectOutputs = (outputs: Record<string, string>): Record<string, string> =>
            req.hostOutputPorts !== undefined
              ? Object.fromEntries(Object.entries(outputs).filter(([, v]) => v !== ''))
              : outputs
          if (early !== null) return { kind: 'early', out: early }
          return { kind: 'ran', result, projected: projectOutputs(result.outputs) }
        },
        keepFromOutcome: (s) => s.kind === 'ran' && s.result.processUnreaped === true,
        mergePhase: (_c, s) => {
          if (s.kind === 'early') {
            // clarify 停靠 / canceled / 非 done：结局已在窗口内产出，keep 由 spawn
            // 里既有的 keepHookIso 赋值决定（processUnreaped 那一维经 keepFromOutcome）。
            return { skip: 'park', keep: keepHookIso, then: { produce: async () => s.out } }
          }
          if (!(iso as IsoHandle).passthrough && req.discardWrites === true) {
            // RFC-167 (Codex impl-gate P1): the orchestrator GENERATION run must
            // never mutate the canonical worktree — validation and the human
            // confirm gate happen AFTER this run, so even a syntactically perfect
            // (let alone malformed or later-rejected) attempt's worktree writes
            // are dropped wholesale. The iso row closes as 'abandoned' (this
            // generation's delta never reaches canonical — exactly the abandon
            // semantics), so runTask-entry replays can never materialize it;
            // discardNodeIso in the finally removes the worktree itself.
            return {
              skip: 'abandon',
              keep: false,
              then: {
                produce: async () => {
                  await tryTransitionMergeState({
                    db,
                    nodeRunId: req.nodeRunId,
                    event: { kind: 'abandon', reason: 'discard-writes' },
                  })
                  return { status: 'done' as const, outputs: s.projected }
                },
              },
            }
          }
          if ((iso as IsoHandle).passthrough) {
            return { skip: 'passthrough', keep: keepHookIso, then: 'settle' }
          }
          return 'merge'
        },
        mergeBack: {
          run: async () => {
            const merge = await (async (): Promise<MergeSettleOutcome> => {
              return await mergeBackAndSettle({
                db,
                writeSem: state.writeSem,
                handle: iso as IsoHandle,
                nodeRunId: req.nodeRunId,
                repoCount: task.repoCount,
                via: 'live',
                conflictResolver: (conflicts, containerPath) =>
                  resolveMergeConflicts(state, {
                    conflicts,
                    containerPath,
                    conflictNodeRunId: req.nodeRunId,
                    nodeId: req.nodeId,
                    iteration: 0,
                  }),
                log,
              })
              return merge
            })()
            return merge
          },
          disposition: {
            // RFC-187 T8：本线的 finally 无条件清理 iso，许不起「留着给人解」的承诺；
            // 留状态不留树会让下次 resume 去找已 GC 的提交并打挂整个任务。故 abandon。
            onConflictHuman: (detail) => ({
              keep: false,
              produce: async () => {
                await tryTransitionMergeState({
                  db,
                  nodeRunId: req.nodeRunId,
                  event: { kind: 'abandon', reason: 'wg-merge-conflict-unresolved' },
                })
                return {
                  status: 'failed',
                  outputs: {},
                  errorMessage: `merge-back-conflict (merge agent could not resolve): ${detail}`,
                }
              },
            }),
            // 刻意的 per-site 差异：抛出保留 iso 并**重抛**，merge_state 留在
            // pending-merge 交给 entry replay——与 DAG 各线的 markMergeFailed 相反。
            onThrow: () => ({ keep: true, then: 'rethrow' as const }),
          },
        },
        onUnhandledThrow: (err) => {
          const msg = err instanceof Error ? err.message : String(err)
          log.error('workgroup host-node run failed', { nodeRunId: req.nodeRunId, error: msg })
          return { status: 'failed', outputs: {}, errorMessage: msg }
        },
        discardIso: async (h: IsoLike) => {
          await discardNodeIso(h as IsoHandle, log, state.writeSem)
        },
        settle: async (_c, s) =>
          s.kind === 'ran'
            ? { status: 'done', outputs: s.projected }
            : { status: 'failed', outputs: {}, errorMessage: 'unreachable' },
        log,
      },
    )
  }

  return {
    runHostNode,
    broadcastNodeStatus: (nodeRunId, nodeId, status) =>
      broadcastNodeStatus(taskId, nodeRunId, nodeId, status as NodeStatus),
    // RFC-187 §4 — canonical delta for the zero-delta-done warn. Throws (engine
    // swallows) when there's no base commit to diff against.
    // RFC-187 §4 (Codex impl-gate P1) — sum the delta over EVERY canonical repo at its
    // own worktree/base. The old form diffed `task.worktreePath`, which for a multi-repo
    // task is a NON-git parent container: git threw, `warnIfZeroDeltaDone` swallowed it,
    // and the zero-delta warning silently never fired for multi-repo tasks at all.
    // Single-repo is unchanged (repos[0].worktreePath === task.worktreePath).
    getCanonicalFilesChanged: async () => {
      const diffable = state.repos.filter((r) => r.baseCommit !== null)
      if (diffable.length === 0) {
        throw new Error('no base commit on any repo — cannot compute canonical delta')
      }
      const perRepo = await Promise.all(
        diffable.map((r) => worktreeFilesChanged(r.worktreePath, r.baseCommit as string)),
      )
      return perRepo.reduce((sum, n) => sum + n, 0)
    },
  }
}

// -----------------------------------------------------------------------------
// scope execution
// -----------------------------------------------------------------------------

interface ScopeResult {
  kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  detail?: { summary: string; message: string; nodeId?: string }
  processUnreaped?: true
}

interface ScopeArgs {
  /** Wrapper node that owns this scope; null for the workflow root. */
  scopeId: string | null
  scopeIds: Set<string>
  iteration: number
  log: Logger
}

// RFC-096: `isFresherNodeRun` moved to freshness.ts (the row-ordering
// authority lives with the freshness primitives now; audit S-13 / WP-3).
// Re-exported here so the six existing test files importing it from the
// scheduler keep working unchanged.
export { isFresherNodeRun } from '@/services/freshness'

// -----------------------------------------------------------------------------
// RFC-042 — same-session envelope follow-up decision.
//
// When an attempt fails with a recognized envelope-format error (none / both /
// clarify-malformed) AND opencode itself exited cleanly AND we captured a
// session id AND the model emitted at least one text line, the next retry
// attempt should resume the SAME opencode session and send a short follow-up
// prompt (see shared `renderEnvelopeFollowupPrompt`) rather than rolling back
// to the pre-snapshot and starting from scratch. Any other failure shape —
// non-zero exit / crash / timeout / no session id captured / no text produced
// / non-envelope errorMessage — falls back to the legacy fresh-session retry
// path (rollback + new spawn).
//
// Pure function intentionally — easy to unit-test the 8-case truth table
// without standing up the whole scheduler.
// -----------------------------------------------------------------------------

export interface PreviousAttemptShape {
  status: 'done' | 'failed' | 'canceled' | null
  exitCode: number | null
  /**
   * RFC-145: the machine-readable failure taxonomy the runner declared at its
   * stamp point (persisted on `node_runs.failure_code`). Replaces the old
   * errorMessage-prefix parsing — errorMessage is human breadcrumbs only and
   * is deliberately NOT part of this shape anymore. NULL = no follow-up-able
   * failure (legacy rows were backfilled by migration 0077).
   */
  failureCode: FailureCode | null
  sessionId: string | null
  /** Count of `kind='text'` rows the runner persisted for the previous run. */
  agentTextCount: number
  /**
   * RFC-049: structured port-validation failures the previous attempt's
   * runner persisted to `node_runs.port_validation_failures_json`. Defaults
   * to undefined; callers that have the JSON-parsed array can thread it
   * through here so the scheduler can route per-kind repair text via
   * `composePerKindRepairBlocks`. When failureCode is 'port-validation-failed'
   * but this field is missing (e.g. legacy rows pre-RFC-049 / malformed JSON
   * degraded by parsePortValidationFailuresJson), the followup still fires but
   * `failures` in the decision is an empty array — degraded mode: prompt still
   * nudges the agent, just without per-port specifics.
   */
  portValidationFailures?: ReadonlyArray<{
    port: string
    kind: string
    subReason: string
    detail?: string
  }>
}

/**
 * RFC-042 的续跑判定结论。
 *
 * RFC-313 起它就是 shared 的 `EnvelopeFollowupOutcome` 本身，不再在这里重述一遍
 * 结构：`decideRetryShape`（形状判定）要消费同一个值，两处各写一份同形类型只会
 * 让它们悄悄漂移。渲染域 `reason` 与 `failures` 元素（`PortValidationFailure`）
 * 的单一事实源都在 shared/prompt.ts。
 */
export type EnvelopeFollowupDecision = EnvelopeFollowupOutcome

/**
 * RFC-145: table lookup replaces the old 7-branch order-sensitive
 * errorMessage-startsWith chain. The runner declares `failureCode` at the
 * same stamp that writes errorMessage; FOLLOWUP_POLICY (shared/prompt.ts)
 * projects the 7-value producer domain onto the 6-value render reason —
 * including the previously implicit clarify-forbidden → envelope-missing
 * downgrade, now an explicit table row. Order sensitivity is gone: the
 * runner distinguishes malformed-port vs port-validation at the source
 * (parse layer vs validation layer — mutually exclusive by construction).
 */
/**
 * RFC-313 实现门 P1-2 —— 框架自写的 `kind='text'` 审计事件的统一载荷前缀。
 *
 * 它们（`[rfc042/envelope-followup]` / `[rfc049/port-validation-followup]` /
 * `[rfc313/session-restart]`）与模型输出共用 `kind='text'`，因此「这一轮模型说过话吗」
 * 的计数必须把它们排除，否则判据恒真。三个 producer 与本前缀的一致性由
 * `packages/backend/tests/rfc313-source-locks.test.ts` 断言。
 */
export const FRAMEWORK_AUDIT_EVENT_PREFIX = '[rfc'

/**
 * RFC-313 实现门 P1-2 —— 「这一轮模型自己说过话吗」的计数。
 *
 * 抽成函数而不是内联查询，是为了让它**可直测**：内联在 `runOneNode` 闭包里的版本只能
 * 靠源码锁间接保护，而这条判据一旦失真，RFC-042 的续跑判据与 RFC-313 的形状判定会一起
 * 走偏（详见 {@link FRAMEWORK_AUDIT_EVENT_PREFIX}）。
 */
export async function countAgentTextEvents(db: DbClient, nodeRunId: string): Promise<number> {
  const row = await db
    .select({ c: sql<number>`count(*)` })
    .from(nodeRunEvents)
    .where(
      and(
        eq(nodeRunEvents.nodeRunId, nodeRunId),
        eq(nodeRunEvents.kind, 'text'),
        notLike(nodeRunEvents.payload, `${FRAMEWORK_AUDIT_EVENT_PREFIX}%`),
      ),
    )
  return Number(row[0]?.c ?? 0)
}

export function decideEnvelopeFollowup(prev: PreviousAttemptShape): EnvelopeFollowupDecision {
  if (prev.status !== 'failed') return { followup: false }
  if (prev.exitCode !== 0) return { followup: false }
  if (prev.sessionId === null || prev.sessionId === '') return { followup: false }
  if (prev.agentTextCount <= 0) return { followup: false }
  if (prev.failureCode === null) return { followup: false }
  const policy = followupPolicyForFailure(prev.failureCode)
  if (policy === undefined) return { followup: false }
  return {
    followup: true,
    reason: policy.reason,
    failures:
      prev.failureCode === 'port-validation-failed' ? (prev.portValidationFailures ?? []) : [],
  }
}

export function shouldRetryNodeFailure(
  failureCode: FailureCode | null | undefined,
  processUnreaped = false,
): boolean {
  // A fresh native session id does not conflict with the old id's lease. If
  // the old child may still be alive, retrying would therefore create two
  // writers in the same worktree even though both individual ids are leased.
  if (processUnreaped) return false
  // 2026-08-04 audit: a terminal error the RUNTIME reported about itself (auth
  // rejected, usage limit, gateway error) does not become true by replaying the
  // same inputs.
  if (failureCode === 'runtime-result-error') return false
  return true
}

async function runScope(state: SchedulerState, args: ScopeArgs): Promise<ScopeResult> {
  const { db, taskId, definition, opts } = state
  const { scopeId, scopeIds, iteration, log } = args

  // RFC-076 PR-B — completion-driven dispatch frontier (replaces the
  // snapshot-batch + Promise.all-barrier + rescan/recompute reconcile model).
  //
  // Each tick re-reads node_runs and re-derives the dispatchable frontier from
  // scratch (`deriveFrontier`); there is no mutable completed/remaining snapshot
  // to keep in sync, so the old `rescanScopeForNewPendingRows` (mid-execution
  // clarify answers) and `recomputeFreshnessAndDemote` (RFC-074 multi-hop
  // demotion) are subsumed — both effects fall out of re-deriving from the DB.
  //
  // Newly-ready nodes start IMMEDIATELY and we await the FIRST in-flight
  // completion (`Promise.race`), so a finished node's downstream dispatches the
  // instant its last upstream settles — no waiting on the slowest sibling in a
  // batch. RFC-130: every node runs in its OWN isolated worktree, so ALL nodes
  // run truly in parallel under the node pool (the `readonly` flag was removed —
  // there is no read/write distinction); `writeSem` only serializes the brief
  // per-node snapshot-at-dispatch (§段①) + merge-back (§段③), not the agent run.
  //
  // `scopeNodes` includes output sinks: each gets a virtual node_run mirroring
  // its upstream port content, so invariant T3 (task.done ⟹ every output node
  // has a done node_run) holds and the detail page reads outputs uniformly.
  const scopeNodes = definition.nodes.filter((n) => scopeIds.has(n.id))
  const upstreamsOf = buildScopeUpstreams(definition, scopeIds, scopeId, state.containerOf)
  const scopeNodeById = new Map(scopeNodes.map((n) => [n.id, n]))

  // Defensive cycle check for the dispatch graph. runTask topologically validates
  // the TOP scope at launch, but inner wrapper scopes (loop / git / fanout) were
  // never checked: a same-iteration data cycle between two inner nodes makes
  // areTransitiveUpstreamsCompleted false for both forever, so the scope goes
  // quiescent and fails with an opaque "scheduler stalled". Surface a clear cycle
  // error instead (channel/back edges are already dropped by buildScopeUpstreams,
  // so a cycle here is a genuine same-iteration data cycle). See
  // scheduler-boundary-intra-loop-cycle-stall.test.ts.
  const cycleNode = findScopeCycle(scopeNodes, upstreamsOf)
  if (cycleNode !== null) {
    return {
      kind: 'failed',
      detail: {
        summary: `cycle detected inside scope at node '${cycleNode}'`,
        message: 'scope-cycle',
        nodeId: cycleNode,
      },
    }
  }

  // In-flight node promises keyed by nodeId; `dispatchedThisInvocation` recovers
  // the per-invocation dedup the old `remaining.delete(n.id)` provided (N3): a
  // pure status read can't distinguish "failed row already (re-)dispatched this
  // call" from "failed row awaiting a fresh resume", so we remember what we
  // started. `parkedDetail` captures awaiting/failed summaries as they happen so
  // the terminal block can bubble the right message (a node parked in a PRIOR
  // invocation has no entry → falls back to '' / the generic detail, matching
  // the old `?? ''` wrapper bubbling).
  const inFlight = new Map<string, Promise<{ nodeId: string; result: OneNodeResult }>>()
  const dispatchedThisInvocation = new Set<string>()
  // One top-level node can complete more than once in the same scope iteration:
  // a fresh pending clarify/review rerun is deliberately redispatched below.
  // Commit synthetics therefore need a trigger generation in addition to
  // nodeId+iteration; otherwise Map.set overwrites the older live Promise and
  // cancel/normal drain can return while that worktree writer still runs.
  let nextCommitPushSequence = 0
  // RFC-092 (audit S-1): pending anchor rows already released this invocation.
  // A node in `dispatchedThisInvocation` re-dispatches when an out-of-band
  // rerun mints a FRESH pending row (mid-run clarify answer / review
  // decision); this set bounds that bypass to one release per row id.
  const dispatchedPendingRowIds = new Set<string>()
  const parkedDetail = new Map<string, { summary: string; message: string }>()
  let firstFailureDetail: { summary: string; message: string; nodeId?: string } | undefined

  // RFC-098 B1: in-flight auto commit&push promises are keyed
  // 'commitpush:<nodeId>:<iter>:<sequence>' — a unique NON-node key, so
  // repeated same-node reruns cannot overwrite a still-live commit Promise;
  // deriveFrontier's in-flight node set never matches a scope node, so dispatch is
  // not frozen while a commit session runs (the synchronous await here used
  // to freeze the whole dispatch loop, audit S-17 second half). Canceled
  // exits MUST drain them (their inner runNode holds the shared signal and
  // returns quickly) — abandoning a commit session past runTask's finally
  // would orphan a worktree-writing process AND let the write-lock registry
  // gc race it (adversarial-review revision #2).
  const drainCommitPush = async (): Promise<void> => {
    const pending = [...inFlight.entries()].filter(([k]) => k.startsWith('commitpush:'))
    for (const [k, p] of pending) {
      try {
        await p
      } catch {
        /* commit failures never break task execution */
      }
      inFlight.delete(k)
    }
  }

  while (true) {
    if (opts.signal?.aborted === true) {
      // Cancel is a hard short-circuit: the abort already fired, so every live
      // child receives SIGTERM through the shared signal. Return immediately
      // without draining in-flight NODE promises — but commit&push synthetics
      // must be drained (see drainCommitPush above).
      await drainCommitPush()
      return { kind: 'canceled', detail: { summary: 'task canceled', message: 'signal aborted' } }
    }

    // RFC-140 W2 — auto-redispatch the auto-split-DEFERRED task questions (marker set at batch
    // dispatch + still undispatched + still staged) BEFORE deriving the frontier. The tick re-
    // enters after EVERY node-run completion, so the home whose in-flight rerun just finished
    // redispatches its deferred cause batch on this very tick (the in-flight gate inside
    // dispatchTaskQuestions releases on done, incl. done-no-output — RFC-133/139). Retryable
    // conflicts keep the marker for the next tick; non-recoverable ones clear it (WARN, back to
    // the manual board). Runs OUTSIDE lock B (dispatch acquires it internally). A successful
    // redispatch mints pending rows that the deriveFrontier below picks up in the same tick.
    await autoDispatchDeferredQuestions(db, taskId)
    // RFC-311 (audit L2-4): the frontier consumes six scalar columns; the old
    // select() decoded every run's prompt_text + iso/inventory JSON on EVERY
    // scheduler tick (the tick re-enters after each node-run completion), so
    // long tasks made the scheduler itself the event-loop hog.
    const rows = await db
      .select({
        id: nodeRuns.id,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        iteration: nodeRuns.iteration,
        parentNodeRunId: nodeRuns.parentNodeRunId,
        mergeState: nodeRuns.mergeState,
        shardKey: nodeRuns.shardKey,
        consumedUpstreamRunsJson: nodeRuns.consumedUpstreamRunsJson,
        supersededByReview: nodeRuns.supersededByReview,
        wrapperProgressJson: nodeRuns.wrapperProgressJson,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
    const openClarify = await loadOpenClarify(db, taskId)
    // RFC-132 PR-B (universal deferred model): the park gate applies to ALL tasks now — a
    // sealed-undispatched entry (a designer waiting for its siblings — "park 等齐" — or a
    // self/questioner entry whose auto-dispatch was deferred by a recoverable conflict) parks its
    // home so the frontier never falsely completes the asking node on a clarify-only output
    // (RFC-076 T0). loadUndispatchedParkTargets returns EMPTY for a task with no sealed-undispatched
    // entries (every steady-state task the instant its answers dispatch), so this stays byte-for-byte
    // the old frontier for that case; the `deferredQuestionDispatch` flag is no longer read.
    // RFC-128 P5-BC (clean-path ③) + P5-D (Codex round-3 fix): the park set classifies designer +
    // self/questioner entries TOGETHER (loadUndispatchedParkTargets), NOT as the per-role UNION. The
    // union deadlocks a SAME-HOME node that holds an undispatched entry of one role AND an in-flight
    // rerun of another (the per-role designer source is blind to an in-flight questioner → parks the
    // node → stalls its pending rerun forever). The all-role partition is in-flight-aware across every
    // role, so such a node RUNS its in-flight rerun + re-parks next tick.
    const deferredHandlerNodeIds = await loadUndispatchedParkTargets(db, taskId)
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      iteration,
      upstreamsOf,
      new Set(inFlight.keys()),
      dispatchedThisInvocation,
      openClarify.clarifyNodeIds,
      openClarify.askingRunIds,
      dispatchedPendingRowIds,
      deferredHandlerNodeIds,
    )

    for (const nodeId of f.ready) {
      const node = scopeNodeById.get(nodeId)
      if (node === undefined) continue
      dispatchedThisInvocation.add(nodeId)
      const anchor = f.pendingAnchors.get(nodeId)
      if (anchor !== undefined) dispatchedPendingRowIds.add(anchor)
      inFlight.set(
        nodeId,
        runOneNode(state, { node, iteration, log }).then((result) => ({ nodeId, result })),
      )
    }

    if (inFlight.size === 0) {
      // Quiescent — nothing running and nothing newly ready. The priority
      // decision (awaiting_human > awaiting_review > firstFailure > exhausted
      // > done > stalled) lives in the pure decideScopeOutcome (RFC-095,
      // dispatchFrontier.ts) so it is table-testable; the stalled branch now
      // names the blocked nodes (audit S-12) instead of a bare message.
      const outcome = decideScopeOutcome(f, firstFailureDetail)
      if (outcome.kind === 'awaiting_human' || outcome.kind === 'awaiting_review') {
        return { kind: outcome.kind, detail: detailFor(outcome.nodeId, parkedDetail) }
      }
      return outcome
    }

    const { nodeId, result } = await Promise.race(inFlight.values())
    inFlight.delete(nodeId)

    if (result.processUnreaped === true) {
      // Do not derive another frontier while an old framework child can still
      // write the canonical worktree. Existing siblings were already admitted;
      // let them settle, but mint no replacement work in this invocation.
      await Promise.allSettled(inFlight.values())
      inFlight.clear()
      return {
        kind: 'failed',
        processUnreaped: true,
        detail: {
          summary: result.summary,
          message: result.message,
          nodeId,
        },
      }
    }

    if (result.kind === 'canceled') {
      // Hard short-circuit (user-tripped signal): no point draining the rest
      // of the NODE promises; commit&push synthetics are drained (revision #2).
      await drainCommitPush()
      return {
        kind: 'canceled',
        detail: { summary: result.summary, message: result.message, nodeId },
      }
    }
    if (result.kind === 'awaiting_review' || result.kind === 'awaiting_human') {
      // Park: record the detail and re-derive next tick. Other branches may
      // still be in flight; only when the scope goes quiescent does the
      // terminal block bubble this up (priority canceled > awaiting_human >
      // awaiting_review > failed). An un-answered clarify cannot be silently
      // lost just because a sibling failed.
      parkedDetail.set(nodeId, { summary: result.summary, message: result.message })
      continue
    }
    if (result.kind === 'failed') {
      // Record the first failure but do NOT short-circuit — sibling branches
      // may still surface awaiting_human / awaiting_review. The failed row is
      // in `dispatchedThisInvocation`, so deriveFrontier will NOT re-dispatch
      // it this call (it lands in the `failed` bucket); a fresh invocation
      // (resume/retry) re-mints it via isDispatchable (N1).
      if (firstFailureDetail === undefined) {
        firstFailureDetail = { summary: result.summary, message: result.message, nodeId }
      }
      continue
    }
    // ok — RFC-075 auto commit&push after a top-level node completes (opt-in;
    // a commit failure must NEVER break task execution). RFC-098 B1: runs as
    // a SYNTHETIC in-flight entry instead of a synchronous await — the
    // dispatch loop keeps racing node completions and dispatching ready
    // nodes while the commit session runs. The synthetic resolves kind 'ok'
    // unconditionally (failures are logged inside).
    if (
      state.task.autoCommitPush &&
      state.topLevelIds.has(nodeId) &&
      !nodeId.startsWith('commitpush:')
    ) {
      const node = scopeNodeById.get(nodeId)
      if (node !== undefined) {
        const syntheticKey = `commitpush:${nodeId}:${iteration}:${nextCommitPushSequence++}`
        inFlight.set(
          syntheticKey,
          maybeRunCommitPush(state, node, iteration, log)
            .catch((err) => {
              log.warn('auto commit&push trigger failed (ignored)', {
                nodeId,
                syntheticKey,
                error: err instanceof Error ? err.message : String(err),
              })
              return {} as { processUnreaped?: true }
            })
            .then((commitResult) => ({
              nodeId: syntheticKey,
              result: (commitResult.processUnreaped === true
                ? {
                    kind: 'failed',
                    summary: 'commit agent child could not be reaped',
                    message: 'commit-agent-child-unreaped',
                    processUnreaped: true,
                  }
                : {
                    kind: 'ok',
                    summary: 'commit&push settled',
                    message: '',
                  }) as OneNodeResult,
            })),
        )
      }
    }
  }
}

/**
 * RFC-076 PR-B — terminal detail for a parked / failed node when the scope goes
 * quiescent. A node parked THIS invocation has its summary/message captured in
 * `parked`; a node parked in a PRIOR invocation (e.g. a resume that never had to
 * re-run it) has no entry and falls back to '' — matching the old wrapper
 * bubbling (`subRes.detail?.summary ?? ''`) and the fact that the top-level
 * runTask ignores awaiting detail entirely (it only sets the task status chip).
 */
function detailFor(
  nodeId: string,
  parked: Map<string, { summary: string; message: string }>,
): { summary: string; message: string; nodeId: string } {
  const d = parked.get(nodeId)
  return { summary: d?.summary ?? '', message: d?.message ?? '', nodeId }
}

/**
 * RFC-076 PR-B — the open-clarify evidence `deriveFrontier` needs to honor a
 * clarify park while re-deriving the frontier purely from node_runs. Two sets,
 * both from UNANSWERED (`awaiting_human`) self / cross-clarify sessions:
 *
 *   - `clarifyNodeIds` (N6): clarify / cross-clarify NODE ids with an open
 *     session. Positive evidence that prevents settling a clarify leaf without a
 *     row during the "agent emitted <workflow-clarify>, createClarifyRound(kind='self')
 *     mid-write" window (the session row can land before the clarify node_run).
 *
 *   - `askingRunIds`: the node_run ids of the ASKING agent / questioner runs
 *     (`source_agent_node_run_id` / `source_questioner_node_run_id`). When an
 *     agent emits <workflow-clarify>, the runner marks the agent's OWN run
 *     `done` and runOneNode returns `awaiting_human`; the old batch model used
 *     that return value to keep the agent OUT of `completed` (so downstream
 *     stayed blocked until the answer minted a rerun). A DB-derived frontier
 *     sees only the `done` row, so without this set it would complete the asking
 *     agent and run its downstream against an empty/clarify-only output (S12:
 *     the diamond's sibling builder ran twice). An asking run id parks its node
 *     in awaitingHuman until submitClarifyAnswers mints the rerun.
 *
 * A task parked awaiting a clarify never advances its loop iteration, so no
 * iteration filter is needed (a stale awaiting session from a prior iteration
 * cannot coexist with active scheduling of a later one).
 */
async function loadOpenClarify(
  db: DbClient,
  taskId: string,
): Promise<{ clarifyNodeIds: Set<string>; askingRunIds: Set<string> }> {
  const clarifyNodeIds = new Set<string>()
  const askingRunIds = new Set<string>()
  const self = await db
    .select({
      nodeId: clarifyRounds.intermediaryNodeId,
      askingRunId: clarifyRounds.askingNodeRunId,
    })
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.kind, 'self'),
        eq(clarifyRounds.taskId, taskId),
        eq(clarifyRounds.status, 'awaiting_human'),
      ),
    )
  for (const r of self) {
    clarifyNodeIds.add(r.nodeId)
    if (r.askingRunId !== null && r.askingRunId !== '') askingRunIds.add(r.askingRunId)
  }
  const cross = await db
    .select({
      nodeId: clarifyRounds.intermediaryNodeId,
      askingRunId: clarifyRounds.askingNodeRunId,
    })
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.kind, 'cross'),
        eq(clarifyRounds.taskId, taskId),
        eq(clarifyRounds.status, 'awaiting_human'),
      ),
    )
  for (const r of cross) {
    clarifyNodeIds.add(r.nodeId)
    if (r.askingRunId !== null && r.askingRunId !== '') askingRunIds.add(r.askingRunId)
  }
  return { clarifyNodeIds, askingRunIds }
}

/**
 * RFC-248 AC-19 —— 只读成员的脏检查。
 *
 * 只读成员不快照、不进 diff、不自动提交推送（D11）。但框架**不在文件系统层面
 * 阻止写入**——agent 拿到的就是一个普通目录。改动被静默丢弃是本 RFC 里最难排查
 * 的一类问题：agent 报告「已修复 vendor/sdk」→ 工作树里确实改了 → 推上去空空
 * 如也。所以把「丢弃了几处」持久化，任务详情据此提示。
 *
 * **每条终态路径都要跑**（done / failed / canceled / awaiting_*）。早先版本把它
 * 搭在自动提交推送里，于是只有 `autoCommitPush=true` 且顶层节点成功的任务才会
 * 被检查——默认配置与失败任务全都漏了（Codex 实现门 P1）。
 *
 * 干净时写 0 而不是留 NULL：UI 要能区分「检查过且干净」与「从未检查」。
 *
 * **刻意不用 `lifecycle_alerts`**：那张表绑 `LifecycleAlertRule`，RFC-108 的
 * 自动修复循环会全局扫描并尝试**修复**每一条。这不是待修复的不变量违反，是
 * 给人看的事实通报，让修复循环去碰它只会误修。
 */
async function inspectReadonlyRepos(state: SchedulerState, log: Logger): Promise<void> {
  for (const repo of state.repos) {
    if (!repo.readonly) continue
    const status = await runGit(repo.worktreePath, ['status', '--porcelain'])
    const changed = status.stdout.trim() === '' ? [] : status.stdout.trim().split('\n')
    await state.db
      .update(taskRepos)
      .set({ readonlyDirtyCount: changed.length })
      .where(and(eq(taskRepos.taskId, state.task.id), eq(taskRepos.repoIndex, repo.repoIndex)))
    if (changed.length > 0) {
      log.warn('[rfc248/readonly-dirty] read-only repo was modified; NOT committed or pushed', {
        taskId: state.task.id,
        mountPath: repo.mountPath === '' ? '<root>' : repo.mountPath,
        changedCount: changed.length,
        changedSample: changed.slice(0, 20),
      })
    }
  }
}

/**
 * RFC-075: auto commit&push after a top-level node completed. Diff-driven —
 * for each repo whose worktree has changes since the last commit, the
 * framework stages + commits (LLM message) + pushes via `runCommitPush`, with
 * the commit message + push repair driven by an opencode session (the built-in
 * commit agent) captured under the synthesized commit node_run. Read-only
 * nodes and no-op writers leave a clean worktree and are skipped for free.
 *
 * Only ever invoked when `state.task.autoCommitPush === true` (the caller
 * gates it), so this is a pure addition for opt-in tasks. Each repo's commit
 * runs sequentially in the scope's result loop, so commits never interleave.
 */
async function maybeRunCommitPush(
  state: SchedulerState,
  node: WorkflowNode,
  iteration: number,
  log: Logger,
): Promise<{ processUnreaped?: true }> {
  const { db, task } = state
  // The triggering node's latest done run at this iteration → parent of the
  // commit row, so the detail page can group it under the agent.
  // RFC-096: freshest-by-id pick (was desc(startedAt) — a S-13 ordering fork;
  // attribution semantics unchanged, the rows are done-only).
  const parentRows = await db
    .select({ id: nodeRuns.id, parentNodeRunId: nodeRuns.parentNodeRunId, status: nodeRuns.status })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, task.id),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
        eq(nodeRuns.status, 'done'),
      ),
    )
  const parentNodeRunId = pickFreshestRun(parentRows, { topLevelOnly: true })?.id ?? null
  const agentLabel: string =
    node.kind === 'agent-single' && typeof node.agentName === 'string' ? node.agentName : node.id
  const branch = task.branch
  // RFC-117: resolve the commit agent's runtime once for this task (profile name →
  // defaultRuntime → deprecated commitPushModel fallback); frozen per session below.
  const rt = await resolveInternalAgentRuntime(db, {
    runtimeName: state.opts.commitPushRuntime,
    deprecatedModel: state.opts.commitPushModel,
    defaultRuntime: state.opts.defaultRuntime,
  })

  for (const repo of state.repos) {
    // RFC-098 B1: a cancel that lands mid-commit&push stops at the next repo
    // boundary (the in-repo opencode session already holds the shared signal).
    if (state.opts.signal?.aborted === true) return {}
    const status = await runGit(repo.worktreePath, ['status', '--porcelain'])
    // RFC-248 D11: 只读成员不参与自动提交推送。它被改动了不是「无事发生」——
    // 框架不在文件系统层面阻止写入，所以 agent 确实可能改了它。静默丢弃最难
    // 排查，故落一条任务级告警（不改任务状态：一个误建的临时文件不该搞垮整任务）。
    // RFC-248 D11: 只读成员不参与自动提交推送。脏检查本身**不在这里**做——
    // 它挂在任务终态收尾（`inspectReadonlyRepos`），否则默认关闭自动推送的
    // 任务永远不会被检查（实现门 P1）。
    if (repo.readonly) continue
    if (status.stdout.trim() === '') continue // nothing changed in this repo
    const repoSlug = repo.worktreeDirName
    const nodeId = commitPushNodeId(node.id, repoSlug || undefined)
    const baseRef = repo.baseBranch || task.baseBranch
    const repoName = repoSlug || repo.repoPath.split('/').pop() || 'repo'

    // Drive a commit-agent opencode session under the commit node_run id so the
    // detail-page "view session" button shows the message/repair conversation.
    const genViaOpencode = async (
      buildPrompt: (envelopeNonce: string) => string,
      ctx: { nodeRunId: string },
    ): Promise<{ message: string | null; sessionId: string | null }> => {
      // Each opencode session (message gen, each repair) runs on its OWN child
      // node_run so runNode's lifecycle state machine (pending→running→done)
      // owns it cleanly — reusing the commit container row would collide with
      // its mark-running transition. The child's parent is the container, so
      // the detail page groups the captured session(s) under the commit row.
      try {
        const sessionRunId = await mintNodeRun(db, {
          taskId: task.id,
          nodeId,
          status: 'pending',
          cause: 'commit-push-session',
          iteration,
          overrides: { parentNodeRunId: ctx.nodeRunId },
        })
        // RFC-117: freeze the resolved commit runtime onto the session row via
        // inheritFrom — its source is config.commitPushRuntime / deprecated model
        // (not an agent.runtime row), so we pre-resolved `rt` above and freeze it
        // here, getting the same node_runs snapshot the other 3 dispatch points do.
        const frozen = await resolveFrozenRuntime(
          db,
          sessionRunId,
          null,
          null,
          {
            protocol: rt.protocol,
            binary: rt.binaryPath,
            params: {
              model: rt.model,
              variant: rt.variant,
              temperature: rt.temperature,
              steps: rt.steps,
              maxSteps: rt.maxSteps,
              isSandbox: rt.isSandbox,
            },
            configDir: rt.configDir, // RFC-154: frozen with the rest of the snapshot
          },
          // Codex impl-gate P1-2: profile binaryPath NULL + config head set used
          // to reach this spawn via opts.opencodeCmd; fold it into the freeze.
          freezeBinaryConfig(state.opts.configPath),
        )
        const envelopeNonce = await loadRunEnvelopeNonce(db, sessionRunId)
        const commitAgent = buildCommitAgent()
        // RFC-282 B2 — the 6th/5th entries also go through the ONE resolver.
        // writeSem is held here: thread the scope signal (design §9-5).
        const commitInjection = await resolveInjection(db, commitAgent, {
          appHome: state.opts.appHome,
          log: log.child('commit'),
          ...(state.opts.signal ? { signal: state.opts.signal } : {}),
        })
        if (commitInjection.kind === 'failed') {
          throw new Error(`commit-push injection resolve failed: ${commitInjection.message}`)
        }
        const result = await runNode({
          taskId: task.id,
          nodeRunId: sessionRunId,
          nodeId,
          agent: commitAgent,
          triggerContext: null,
          expandPromptTemplate: false,
          runtime: frozen.protocol,
          runtimeBinary: frozen.binary,
          runtimeParams: frozen.params,
          runtimeConfigDir: frozen.configDir, // RFC-154: frozen config-dir profile
          inputs: {},
          worktreePath: repo.worktreePath,
          promptTemplate: buildPrompt(envelopeNonce),
          templateMeta: {
            repoPath: repo.repoPath,
            baseBranch: baseRef,
            taskId: task.id,
            nodeId,
            iteration,
            repos: state.repos,
            // RFC-248: `{{__repo_group__}}`；非组启动时不传 ⇒ 渲染空串。
            ...(state.repoGroupName !== null ? { repoGroupName: state.repoGroupName } : {}),
          },
          // RFC-282 B2 — resources derive from the synthetic agent's own
          // definition via the ONE resolver (was four hand-written empty
          // arrays: adding an MCP ref to the built-in agent silently did
          // nothing). Zero-resource today ⇒ identical spec; the regression
          // lock pins that resolveInjection stays ok for synthetic agents.
          skills: commitInjection.spec.skills,
          dependents: commitInjection.spec.dependents,
          mcps: commitInjection.spec.mcps,
          plugins: commitInjection.spec.plugins,
          appHome: state.opts.appHome,
          db,
          log: log.child('commit'),
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          ...(state.opts.binaryOverride ? { binaryOverride: state.opts.binaryOverride } : {}),
          ...(state.opts.signal ? { signal: state.opts.signal } : {}),
        })
        const msg = result.outputs[COMMIT_MESSAGE_PORT]
        return {
          message: msg !== undefined && msg.trim() !== '' ? msg : null,
          sessionId: result.sessionId ?? null,
          ...(result.processUnreaped === true ? { processUnreaped: true as const } : {}),
        }
      } catch (err) {
        log.warn('commit-agent opencode run failed; will fall back', {
          nodeId,
          error: err instanceof Error ? err.message : String(err),
        })
        return { message: null, sessionId: null }
      }
    }

    const commitResult = await runCommitPush(
      {
        taskId: task.id,
        agentNodeId: node.id,
        agentName: agentLabel,
        parentNodeRunId,
        worktreePath: repo.worktreePath,
        repoBranch: branch,
        baseRef,
        ...(repoSlug ? { repoSlug } : {}),
        ownerUserId: task.ownerUserId,
        gitUserName: task.gitUserName,
        gitUserEmail: task.gitUserEmail,
        maxRepairRetries:
          state.opts.commitPushMaxRepairRetries ?? DEFAULT_COMMIT_PUSH_MAX_REPAIR_RETRIES,
        diffMaxBytes: state.opts.commitPushDiffMaxBytes ?? DEFAULT_COMMIT_PUSH_DIFF_MAX_BYTES,
        excludePatterns: readCommitExcludePatterns(state.opts),
        // RFC-076 C4: capture the staged snapshot only when no writer node is
        // mid-write. Writers hold this same Semaphore(1) for their whole run, so
        // under the race loop this serializes the commit's `git add` against
        // them — restoring the worktree quiescence the old batch barrier gave.
        acquireWrite: () => state.writeSem.acquire(),
        generateMessage: (mctx) =>
          genViaOpencode(
            (envelopeNonce) =>
              buildCommitMessagePrompt(
                {
                  repoName,
                  branch,
                  baseRef,
                  stat: mctx.stat,
                  diffTruncated: mctx.diffTruncated,
                  // RFC-157: undefined ≡ en-US. Initial + repair share one language.
                  lang: state.opts.commitPushLang ?? 'en-US',
                },
                envelopeNonce,
              ),
            mctx,
          ),
        generateRepair: (rctx) =>
          genViaOpencode(
            (envelopeNonce) =>
              buildRepairPrompt(
                {
                  branch,
                  pushStderr: rctx.pushStderr,
                  currentMessage: rctx.currentMessage,
                  stat: rctx.stat,
                  priorAttempts: rctx.priorAttempts,
                  lang: state.opts.commitPushLang ?? 'en-US',
                },
                envelopeNonce,
              ),
            rctx,
          ),
      },
      {
        db,
        log: log.child('commit'),
        publicationTransport:
          state.opts.repositoryPublicationTransport ??
          resolveRepositoryPublicationTransportFromKeyFile({
            db,
            appHome: state.opts.appHome,
          }),
      },
    )
    if (commitResult.processUnreaped === true) return { processUnreaped: true }
  }
  return {}
}

// RFC-096: `buildFreshestSettledPerNode` moved to freshness.ts alongside the
// comparator (audit S-13 / WP-3).

// -----------------------------------------------------------------------------
// RFC-076 PR-B — deriveFrontier (the dispatch brain; PURE, and LIVE: runScope
// calls it every dispatch tick — the stale "currently UNWIRED / NOT yet called"
// claims removed by RFC-094, audit S-26).
// -----------------------------------------------------------------------------
//
// Re-derives the dispatchable frontier from node_runs each tick, replacing the
// batch model's mutable completed/remaining snapshot + rescan/recompute
// reconcile. Composes fix A's areTransitiveUpstreamsCompleted + PR-A's
// isDispatchable / wrapperHasFreshInnerWork, plus RFC-092's pending-anchor
// row-id release (mid-run clarify answer / review decision pickup, audit S-1).
// The row-ordering primitives (isFresherNodeRun / buildFreshestSettledPerNode)
// live in freshness.ts since RFC-096. Pure-function locks: derive-frontier.test.ts.

export interface Frontier {
  /** done∧fresh ∪ exhausted(loop-max terminal, HIGH-2) ∪ settles-without-row leaves. */
  completed: Set<string>
  /** transitive upstreams completed ∧ isDispatchable ∧ ∉ inFlight ∧ ∉ dispatchedThisInvocation. */
  ready: string[]
  /**
   * RFC-092 (audit S-1): for every `ready` node whose latest row is `pending`,
   * that row's id. The caller records these into its per-invocation
   * `dispatchedPendingRowIds` set so each pending anchor row is released AT
   * MOST ONCE — an out-of-band rerun mint (clarify answer / review decision)
   * carries a fresh ULID and re-releases the node; a leaked pending row that a
   * dispatch failed to consume degrades back to the stall semantics instead of
   * hot-looping.
   *
   * RFC-098 B3 (audit S-3): a ready WRAPPER whose latest row is awaiting_*
   * contributes its inner revival-EVIDENCE row id here instead (the inner
   * pending rerun / approved review row, wrapperRevivalEvidence) — same
   * one-shot release contract, keyed on the evidence rather than the wrapper
   * row itself.
   */
  pendingAnchors: Map<string, string>
  /** latest awaiting_review / awaiting_human, NOT going to ready (terminal bubbling). */
  awaitingReview: string[]
  awaitingHuman: string[]
  /** latest failed, NOT going to ready (a dispatchable failed row = pending resume, not terminal). */
  failed: string[]
  /** latest 'exhausted' (loop-max) — a terminal FAILURE, surfaced when the scope is quiescent. */
  exhausted: string[]
  /**
   * RFC-095 (audit S-12): nodes whose upstreams are complete and which are not
   * in flight, yet are neither dispatchable nor in any park bucket — the old
   * silent black holes (orphaned running rows, supersede-marker canceled rows,
   * consumed pending anchors, skipped, …). Surfaced in the stalled diagnostic;
   * `reason` is free-text payload, not an API contract.
   */
  blocked: Array<{ nodeId: string; status: string; reason: string }>
  /** every in-scope node is completed ⇒ scope may return done. */
  allSettled: boolean
}

// Graph-visit no-op kinds write NO node_run row (C1); they settle without one
// once upstreams are done and no session is open (N6). RFC-146: derived from
// the behavior table (today: clarify / clarify-cross-agent) instead of a
// hand-maintained literal twin.
const SETTLES_WITHOUT_ROW_KINDS = new Set<NodeKind>(
  NODE_KIND.filter((k) => NODE_KIND_BEHAVIORS[k].settlesWithoutRow),
)

function isLiveStatus(status: string): boolean {
  return (
    status === 'pending' ||
    status === 'running' ||
    status === 'awaiting_human' ||
    status === 'awaiting_review'
  )
}

/**
 * @param rows                     all node_runs for the task (filtered inside)
 * @param openClarifyNodeIds       clarify / clarify-cross-agent node ids with an
 *   UNANSWERED session (N6 positive evidence — caller queries clarify_sessions /
 *   cross_clarify_sessions). A no-row clarify leaf only settles when NOT here,
 *   closing the "agent done, createClarifyRound(kind='self') not yet written" window.
 * @param dispatchedThisInvocation nodes already dispatched this runScope call
 *   (N3 — recovers the old remaining.delete per-invocation dedup; pure status
 *   read can't tell "already-dispatched parked wrapper" from "fresh resume").
 * @param openClarifyNodeIds       clarify / cross-clarify NODE ids with an open
 *   session (N6 — see loadOpenClarify).
 * @param askingRunIds             node_run ids of asking agent / questioner runs
 *   with an open clarify session. Their `done` row is a clarify park, NOT a
 *   completion: excluded from `completed` and bucketed awaitingHuman until the
 *   answer mints a rerun (S12). See loadOpenClarify.
 * @param dispatchedPendingRowIds  pending row ids already released through the
 *   RFC-092 pending-anchor bypass this invocation (caller records
 *   `Frontier.pendingAnchors` of every dispatch). Bounds the bypass to one
 *   release per row — see Frontier.pendingAnchors.
 */
/**
 * RFC-306 (design-gate P1#7) — the upstream run that makes a stale skip stale.
 *
 * Returns the freshest settled run id among this node's structural upstreams
 * that the skip row did NOT consume. That id is the release key: it identifies
 * the generation of new evidence, so the release fires once per upstream re-run
 * rather than once per tick.
 */
function freshestUpstreamEvidenceId(
  skippedRow: NodeRunRow,
  upstreams: readonly string[],
  freshestSettled: Map<string, NodeRunRow>,
): string | undefined {
  const consumed = parseConsumedJson(skippedRow.consumedUpstreamRunsJson)
  let best: string | undefined
  for (const upstreamId of upstreams) {
    const current = freshestSettled.get(upstreamId)
    if (current === undefined) continue
    if (consumed[upstreamId] === current.id) continue // this leg is unchanged
    if (best === undefined || current.id > best) best = current.id
  }
  return best
}

/** RFC-311 — the frontier consumes the freshness column contract (see
 *  `NodeRunRow` in services/freshness.ts); the per-tick query projects exactly
 *  those columns instead of dragging prompt_text / iso JSON along. */
export type FrontierRunRow = NodeRunRow

export function deriveFrontier(
  rows: ReadonlyArray<FrontierRunRow>,
  definition: WorkflowDefinition,
  scopeNodes: WorkflowNode[],
  scopeIds: Set<string>,
  iteration: number,
  upstreamsOf: Map<string, string[]>,
  inFlight: ReadonlySet<string>,
  dispatchedThisInvocation: ReadonlySet<string>,
  openClarifyNodeIds: ReadonlySet<string>,
  askingRunIds: ReadonlySet<string> = new Set(),
  dispatchedPendingRowIds: ReadonlySet<string> = new Set(),
  // RFC-120 T9 (model A): effective handler nodes (override ?? designer) of a
  // deferred-dispatch task's undispatched designer task_questions. Each is kept
  // OUT of `completed` (its done draft is NOT a completion — downstream blocks)
  // and parked awaiting_human until batch-dispatch mints its rerun. Empty for
  // every non-deferred task → byte-for-byte today's frontier (golden-lock).
  deferredHandlerNodeIds: ReadonlySet<string> = new Set(),
): Frontier {
  const latestPerNode = new Map<string, FrontierRunRow>()
  for (const r of rows) {
    if (r.iteration !== iteration) continue
    if (!scopeIds.has(r.nodeId)) continue
    if (r.parentNodeRunId !== null) continue // skip fan-out child rows
    if (isFresherNodeRun(r, latestPerNode.get(r.nodeId))) latestPerNode.set(r.nodeId, r)
  }
  const freshestSettled = buildFreshestSettledPerNode(rows, scopeIds, iteration)

  // Pass 1 — done∧fresh (old seed口径) + exhausted (loop-max true terminal,
  // HIGH-2). An asking agent's `done` run with an OPEN clarify session is NOT a
  // completion (it is mid-conversation, parked awaiting the answer) — excluded
  // here, bucketed awaitingHuman below (S12: matches the old batch model keeping
  // the asking agent out of `completed` via runOneNode's awaiting_human return).
  const completed = new Set<string>()
  const exhausted: string[] = []
  for (const [nodeId, r] of latestPerNode) {
    if (askingRunIds.has(r.id)) continue
    // RFC-120 T9: a deferred designer handler's done draft is NOT a completion —
    // exclude it from `completed` so its downstream stays blocked until dispatch.
    if (deferredHandlerNodeIds.has(nodeId)) continue
    // RFC-130 D15: an ISOLATED done run counts as complete ONLY once its delta has
    // been merged back into the canonical worktree (merge_state='merged'). A row
    // still in 'pending-merge' / 'conflict-*' / 'isolating' / 'merge-failed' has a
    // 'done' status (the runner set it) but its output never reached canonical —
    // gating downstream on merge_state closes the crash window (runner-done →
    // daemon crash → merge-back never ran). Legacy / passthrough rows leave
    // merge_state NULL and pass this gate byte-for-byte (golden-lock).
    if (
      r.status === 'done' &&
      isNodeRunFresh(r, freshestSettled) &&
      // RFC-144: the settled set {NULL, merged} now derives from the shared
      // transition table (SETTLED_MERGE_STATES) — in-flight iso states
      // ('isolating' / 'pending-merge' / 'conflict-human' / 'merge-failed' /
      // 'abandoned') are gated out; null/'merged' pass (legacy golden-lock).
      isMergeStateSettled(r.mergeState)
    ) {
      completed.add(nodeId)
    }
    // RFC-306: a fresh `skipped` row completes its node. The node did not run —
    // by design — and holding the scope open for it would turn every closed
    // branch into `scheduler stalled` (the pre-RFC-306 outcome of a node that
    // could never become ready). No merge_state gate: a skipped node spawns no
    // process and therefore owns no isolated worktree to merge back.
    //
    // Downstream is NOT force-skipped from here. Each downstream node becomes
    // ready and makes its OWN judgment at dispatch (runOneNode), because with
    // `joinMode: 'any'` a node fed by one skipped and one live upstream must
    // still run. Propagation is the emergent result of that per-node judgment,
    // never a graph walk that assumes it.
    else if (r.status === 'skipped' && isNodeRunFresh(r, freshestSettled)) {
      completed.add(nodeId)
    }
    // 'exhausted' (loop hit maxIterations without exit) is a TERMINAL FAILURE,
    // not a completion. Marking it completed made a resume invocation see an
    // exhausted top-level loop as done → the task silently flipped failed→done
    // and downstream consumed empty output. Bucket it as a failure so the scope
    // fails consistently on the first run AND any resume. See
    // scheduler-boundary-loop-exhausted-resume.test.ts.
    else if (r.status === 'exhausted') exhausted.push(nodeId)
  }
  // Pass 2 — settles-without-row (C1/N6). clarify nodes have no structural
  // upstream (channel edges dropped) so are leaves; cross-clarify depends on its
  // questioner (settled in pass 1), so one pass over pass-1 `completed` suffices.
  for (const n of scopeNodes) {
    if (completed.has(n.id)) continue
    if (!SETTLES_WITHOUT_ROW_KINDS.has(n.kind)) continue
    const latest = latestPerNode.get(n.id)
    if (latest !== undefined && isLiveStatus(latest.status)) continue
    if (openClarifyNodeIds.has(n.id)) continue
    if (areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed)) completed.add(n.id)
  }

  // RFC-092 (audit S-1, design §1.2b): node ids whose ASKING run still has an
  // open (un-answered) clarify session. submitClarifyAnswers mints the rerun
  // row BEFORE writing the answers / flipping the session (clarify.ts, no real
  // transaction under bun:sqlite) — releasing that pending row inside the
  // window would start the rerun without its answers. Derived from the rows we
  // already hold; the set empties the tick after the session flips answered.
  const openAskingNodeIds = new Set<string>()
  if (askingRunIds.size > 0) {
    for (const r of rows) {
      if (askingRunIds.has(r.id)) openAskingNodeIds.add(r.nodeId)
    }
  }

  const awaitingReview: string[] = []
  const awaitingHuman: string[] = []
  const failed: string[] = []
  const blocked: Array<{ nodeId: string; status: string; reason: string }> = []
  const ready: string[] = []
  const pendingAnchors = new Map<string, string>()
  let remainingCount = 0
  for (const n of scopeNodes) {
    if (completed.has(n.id)) continue
    remainingCount += 1
    // RFC-120 T9 (model A): a deferred designer handler parks awaiting_human until
    // batch-dispatch mints its rerun (mirrors the askingRunIds park below). Its
    // done draft is not (re-)dispatchable here — dispatchTaskQuestions stamps
    // trigger_run_id + mints the pending rerun, which the next tick picks up once
    // this node leaves the deferred set.
    if (deferredHandlerNodeIds.has(n.id)) {
      awaitingHuman.push(n.id)
      continue
    }
    const latest = latestPerNode.get(n.id)
    // Asking agent parked on an open clarify: its `done` row is mid-conversation,
    // not a completion and not (re-)dispatchable — submitClarifyAnswers mints the
    // rerun. Park it in awaitingHuman so the scope bubbles awaiting_human (and so
    // a `done`-status latest doesn't fall through to no bucket → false stall).
    if (latest !== undefined && askingRunIds.has(latest.id)) {
      awaitingHuman.push(n.id)
      continue
    }
    // RFC-092 (audit S-1): a `pending` latest row is an explicit new-work
    // signal (out-of-band rerun mint by submitClarifyAnswers / review
    // iterate-reject, or a resume placeholder). The per-invocation node-level
    // dedup must NOT permanently mask it — that turned a mid-run clarify
    // answer into a false `scheduler stalled` failure. Release it once per
    // ROW (dispatchedPendingRowIds), and never while its asking session is
    // still open (answer-write race window — see openAskingNodeIds above).
    const pendingAnchorReleasable =
      latest !== undefined &&
      latest.status === 'pending' &&
      !dispatchedPendingRowIds.has(latest.id) &&
      !openAskingNodeIds.has(n.id)
    // RFC-098 B3 (audit S-3 + the RFC-092 documented limitation): a parked
    // WRAPPER row (awaiting_*) gets the same one-shot in-invocation release,
    // keyed on its inner REVIVAL EVIDENCE row (the pending rerun a mid-run
    // clarify answer minted, or the done∧fresh review row an approve flipped
    // — wrapperRevivalEvidence, dispatchFrontier.ts). Without this, a wrapper
    // already in `dispatchedThisInvocation` could never pick up the human
    // action and the task fell back to awaiting_* needing a manual resume.
    //
    // No-busy-loop argument (five layers, mirrors RFC-092 §1.3):
    //   ① the evidence ROW id is recorded into dispatchedPendingRowIds on
    //      dispatch (pendingAnchors below) — the same evidence releases the
    //      wrapper at most once per invocation;
    //   ② a dispatched wrapper enters `inFlight` — no re-dispatch same tick;
    //   ③ the wrapper resume immediately flips its row running — `latest`
    //      leaves awaiting_*, this predicate stops matching while it runs;
    //   ④ the inner runScope consumes a pending evidence row via its
    //      pendingExisting reuse (row flips running → terminal) — the
    //      evidence disappears; NEW evidence can only be minted by a new
    //      human action (fresh ULID re-arms exactly one more release);
    //   ④' while the evidence node's clarify session is still OPEN (answers
    //      mid-write), openAskingNodeIds blocks the release — the next tick
    //      after the session flips answered releases it;
    //   ⑤ pathological leak (inner exits without consuming the pending row —
    //      the known RFC-092 shape): the anchor is already recorded, so no
    //      further release — degrades to the bounded park/stalled semantics.
    const wrapperEvidence =
      latest !== undefined &&
      (latest.status === 'awaiting_human' || latest.status === 'awaiting_review') &&
      WRAPPER_KINDS.has(n.kind)
        ? wrapperRevivalEvidence(latest, rows, definition)
        : null
    const wrapperAnchorReleasable =
      wrapperEvidence !== null &&
      !dispatchedPendingRowIds.has(wrapperEvidence.rowId) &&
      !openAskingNodeIds.has(wrapperEvidence.nodeId)
    // RFC-306 (design-gate P1#7) — a STALE skip gets the same one-shot release.
    //
    // Without it: `N` is skipped early in an invocation; later in the SAME
    // invocation the deciding upstream re-runs (a review iterate released by a
    // pending anchor) and re-opens the branch. `N`'s skip is now stale, but `N`
    // is already in `dispatchedThisInvocation` and owns no pending row of its
    // own, so it can never go ready again — the scope quiesces and reports
    // `scheduler stalled`, i.e. a NORMAL branch flip surfaces as task failure.
    //
    // The release is keyed on the EVIDENCE — the upstream run that made the skip
    // stale — not on the skip row, so it is one-shot per new upstream generation
    // (layer ① of the RFC-092 no-busy-loop argument): the same upstream row can
    // release this node at most once per invocation, and a further release needs
    // a genuinely newer upstream run.
    const staleSkipEvidenceId =
      latest !== undefined &&
      latest.status === 'skipped' &&
      !isNodeRunFresh(latest, freshestSettled)
        ? (freshestUpstreamEvidenceId(latest, upstreamsOf.get(n.id) ?? [], freshestSettled) ?? null)
        : null
    const staleSkipReleasable =
      staleSkipEvidenceId !== null && !dispatchedPendingRowIds.has(staleSkipEvidenceId)
    const dispatchable =
      areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed) &&
      !inFlight.has(n.id) &&
      (pendingAnchorReleasable ||
        wrapperAnchorReleasable ||
        staleSkipReleasable ||
        !dispatchedThisInvocation.has(n.id)) &&
      isDispatchable(latest, n.kind, freshestSettled, rows, definition)
    if (dispatchable) {
      ready.push(n.id)
      if (latest !== undefined && latest.status === 'pending') {
        pendingAnchors.set(n.id, latest.id)
      } else if (staleSkipEvidenceId !== null) {
        // Record the evidence on EVERY ready pass (same reasoning as the wrapper
        // anchor below): a re-skip against the same upstream generation must not
        // release the node a second time.
        pendingAnchors.set(n.id, staleSkipEvidenceId)
      } else if (wrapperEvidence !== null) {
        // Record the wrapper's evidence row EVERY time it goes ready (also on
        // the plain !dispatchedThisInvocation release) so layer ① holds: a
        // re-park at the same window with the same done-review evidence stays
        // parked instead of hot-looping.
        pendingAnchors.set(n.id, wrapperEvidence.rowId)
      }
      continue
    }
    // RFC-095 (audit S-12): EXHAUSTIVE bucketing over the full NodeRunStatus
    // universe — a new status fails compilation here instead of silently
    // becoming an undiagnosable "scheduler stalled". The three park buckets
    // collect UNCONDITIONALLY (pre-RFC-095 semantics: an awaiting/failed row
    // parks regardless of upstream readiness — quiescent priority awaiting_* >
    // failed depends on it; derive-frontier.test.ts locks the failed case).
    // Only the `blocked` diagnostic branches gate on "upstreams complete ∧ not
    // in flight" — waiting-on-upstream / in-flight nodes are not stuck points.
    switch (latest?.status) {
      case 'awaiting_review':
        awaitingReview.push(n.id)
        break
      case 'awaiting_human':
        awaitingHuman.push(n.id)
        break
      case 'failed':
        failed.push(n.id)
        break
      case 'exhausted':
        break // already collected into the exhausted bucket in pass 1
      default: {
        if (!areTransitiveUpstreamsCompleted(n.id, upstreamsOf, completed)) break
        if (inFlight.has(n.id)) break
        const st = latest?.status
        switch (st) {
          case undefined:
            // clarify / cross-clarify graph-visit no-ops write no row; with an
            // open session pass 2 keeps them unsettled — a normal park, not a
            // dedup pathology. Anything else here was dispatched this
            // invocation and produced no row.
            blocked.push({
              nodeId: n.id,
              status: 'absent',
              reason: openClarifyNodeIds.has(n.id) ? 'open-clarify-window' : 'in-invocation-dedup',
            })
            break
          case 'pending':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: openAskingNodeIds.has(n.id)
                ? 'open-clarify-window'
                : 'pending-anchor-consumed',
            })
            break
          case 'running':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: 'orphaned-running-row (restart daemon to reap, audit S-12)',
            })
            break
          case 'canceled':
            // RFC-095: plain canceled rows are revival-dispatchable; only
            // review-supersede marker rows stay parked (see isDispatchable). A
            // plain canceled row lands here only via the per-invocation dedup.
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: isReviewSupersededRow(latest!)
                ? 'review-superseded'
                : 'canceled-in-invocation-dedup',
            })
            break
          case 'skipped':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: 'skipped-has-no-dispatch-semantics',
            })
            break
          case 'done': {
            // RFC-130 §6.3 / RFC-144: exhaustive over MergeStateOrNull — a done row
            // parked at 'conflict-human' bubbles awaiting_human (decideScopeOutcome);
            // 'merge-failed' is a hard merge failure → the scope fails; 'abandoned'
            // (superseded generation, RFC-144) joins the stale-done dedup bucket like
            // every other stale row; a NEW merge state added to the union without a
            // bucket here is a compile error.
            const ms = (latest?.mergeState ?? null) as MergeStateOrNull
            switch (ms) {
              case 'conflict-human':
                awaitingHuman.push(n.id)
                break
              case 'merge-failed':
                failed.push(n.id)
                break
              case null:
              case 'isolating':
              case 'pending-merge':
              case 'merged':
              case 'abandoned':
                blocked.push({
                  nodeId: n.id,
                  status: st,
                  reason: 'stale-done-in-invocation-dedup',
                })
                break
              default: {
                const _exhaustive: never = ms
                void _exhaustive
                // Runtime-unknown legacy value — same dedup bucket as before.
                blocked.push({
                  nodeId: n.id,
                  status: st,
                  reason: 'stale-done-in-invocation-dedup',
                })
              }
            }
            break
          }
          case 'interrupted':
            blocked.push({
              nodeId: n.id,
              status: st,
              reason: 'interrupted-in-invocation-dedup',
            })
            break
          default: {
            // awaiting_* / failed / exhausted were collected by the outer
            // switch — anything reaching here is a NEW NodeRunStatus value.
            const _exhaustive: never = st
            void _exhaustive
          }
        }
      }
    }
  }
  return {
    completed,
    ready,
    pendingAnchors,
    awaitingReview,
    awaitingHuman,
    failed,
    exhausted,
    blocked,
    allSettled: remainingCount === 0,
  }
}

// -----------------------------------------------------------------------------
// per-node execution
// -----------------------------------------------------------------------------

interface OneNodeResult {
  kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review' | 'awaiting_human'
  summary: string
  message: string
  processUnreaped?: true
}

interface OneNodeArgs {
  node: WorkflowNode
  iteration: number
  log: Logger
}

// RFC-188: persistIsoBase / persistIsoNodeTree moved to isolatedAgentRun.ts
// (shared by all five assembly sites + replay) — imported above.

function parseIsoJsonMap(s: string | null): Record<string, string> {
  if (s === null || s === '') return {}
  try {
    const o = JSON.parse(s) as unknown
    return o !== null && typeof o === 'object' ? (o as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** RFC-210 round 6 P2 — the run id that KEYS the physical iso (worktree path +
 *  ref namespaces), recovered from the persisted container path. A
 *  process-retry keeps the original row's iso (D17) while its DB row is the
 *  retry mint; falling back to the row id preserves pre-column-era rows. */
function isoKeyOf(isoWorktreePath: string | null, rowId: string): string {
  if (isoWorktreePath === null || isoWorktreePath === '') return rowId
  const base = basename(isoWorktreePath)
  return base === '' ? rowId : base
}

/**
 * RFC-210 — read a node_run's persisted submodule topology back for replay.
 *
 * Defensive parse: a row that fails the schema is treated as ABSENT rather than
 * half-trusted. Absence matters — `replaySubmodulesMissing` below turns it into a
 * refusal instead of letting merge-back run parent-only, which for a gitlink both
 * sides moved silently resolves as "take theirs" and discards the sibling node's
 * submodule commits.
 */
function parseIsoSubmodules(
  row: { isoSubmodulesJson: string | null; isoSubmodulesReposJson: string | null },
  repoCount: number,
): Record<
  string,
  {
    subBases: Record<string, string>
    poolDirs: Record<string, string>
    pendingSubResolves: string[]
  }
> {
  const raw = repoCount === 1 ? row.isoSubmodulesJson : row.isoSubmodulesReposJson
  if (raw === null || raw === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (repoCount === 1) {
      const one = IsoSubmodulesSchema.safeParse(parsed)
      // `pendingSubResolves` MUST be carried through. Dropping it here (it used
      // to be filtered out by this very projection) left the fail-closed gate in
      // completeHumanResolvedConflict reading a permanently empty list on the
      // only production path that reaches it — replayConflictHumanResolutions.
      return one.success
        ? {
            '': {
              subBases: one.data.subBases,
              poolDirs: one.data.poolDirs,
              pendingSubResolves: one.data.pendingSubResolves ?? [],
            },
          }
        : {}
    }
    if (parsed === null || typeof parsed !== 'object') return {}
    const out: Record<
      string,
      {
        subBases: Record<string, string>
        poolDirs: Record<string, string>
        pendingSubResolves: string[]
      }
    > = {}
    for (const [dir, v] of Object.entries(parsed as Record<string, unknown>)) {
      const one = IsoSubmodulesSchema.safeParse(v)
      if (one.success)
        out[dir] = {
          subBases: one.data.subBases,
          poolDirs: one.data.poolDirs,
          pendingSubResolves: one.data.pendingSubResolves ?? [],
        }
    }
    return out
  } catch {
    return {}
  }
}

/**
 * RFC-210 fail-closed gate for replay: does any repo carry submodules while the
 * persisted topology for it is missing?
 *
 * Mirrors the existing `node_tree missing` refusal a few lines below — replaying
 * without the per-submodule merge bases is not a degraded merge, it is a merge
 * that silently drops work.
 */
function replaySubmodulesMissing(
  repos: ReadonlyArray<{ worktreePath: string; worktreeDirName: string }>,
  persisted: Record<string, { subBases: Record<string, string> }>,
): string | null {
  for (const repo of repos) {
    if (!existsSync(pathJoin(repo.worktreePath, '.gitmodules'))) continue
    const entry = persisted[repo.worktreeDirName]
    if (entry === undefined || Object.keys(entry.subBases).length === 0) {
      return repo.worktreeDirName || 'repo'
    }
  }
  return null
}

/**
 * RFC-130 D15/T3c2: on resume, replay merge-back for any 'pending-merge' row. A
 * daemon crash between agent-success (runner wrote status='done') and merge-back
 * leaves a done row whose delta never reached the canonical worktree — deriveFrontier
 * gates it out of `completed` (D15), so without replay the scope would stall.
 *
 * Replays from the PINNED node_tree (iso_node_tree column), so the iso worktree may
 * be gone and the agent is NEVER re-run. Runs BEFORE the scope so the frontier only
 * ever sees merged/failed rows. A conflict or missing node_tree throws → the caller
 * fails the task loudly (PR-B upgrades the conflict path to the merge agent).
 */
async function replayPendingMerges(state: SchedulerState, log: Logger): Promise<void> {
  const { db, taskId, task } = state
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.mergeState, 'pending-merge' satisfies MergeState),
      ),
    )
  if (rows.length === 0) return
  const taskBaseHeads: Record<string, string> = {}
  for (const repo of state.repos) {
    const h = await runGit(repo.worktreePath, ['rev-parse', 'HEAD'])
    taskBaseHeads[repo.worktreeDirName] = h.stdout.trim()
  }
  for (const r of rows) {
    const baseSnapshots: Record<string, string> = {}
    const nodeTrees: Record<string, string> = {}
    if (task.repoCount === 1) {
      if (r.isoBaseSnapshot !== null) baseSnapshots[''] = r.isoBaseSnapshot
      if (r.isoNodeTree !== null) nodeTrees[''] = r.isoNodeTree
    } else {
      Object.assign(baseSnapshots, parseIsoJsonMap(r.isoBaseSnapshotReposJson))
      Object.assign(nodeTrees, parseIsoJsonMap(r.isoNodeTreeReposJson))
    }
    if (Object.keys(nodeTrees).length === 0) {
      throw new Error(`pending-merge replay: node_tree missing for run ${r.id}`)
    }
    const submodules = parseIsoSubmodules(r, task.repoCount)
    const missingSub = replaySubmodulesMissing(state.repos, submodules)
    if (missingSub !== null) {
      throw new Error(
        `pending-merge replay: submodule topology missing for repo '${missingSub}' of run ${r.id}`,
      )
    }
    const handle = rebuildIsoHandle({
      appHome: state.opts.appHome,
      taskId,
      // Round 6 P2: the PHYSICAL iso identity — a process-retry keeps the
      // worktree + ref namespace keyed by the ORIGINAL row id (D17) while
      // pending-merge lands on the retry row; rebuild from the persisted
      // path so discard/refs address what actually exists.
      nodeRunId: isoKeyOf(r.isoWorktreePath, r.id),
      canonRepos: state.repos,
      baseSnapshots,
      taskBaseHeads,
      submodules,
      // RFC-193 K1: the replay's merge-back re-snapshots canonical (ours) —
      // it must keep force-including the task's gitignored port files.
      forcedContainerPaths: await forcedPortPathsForTask(db, taskId),
    })
    // RFC-188: the ONE merge-back assembly — replay passes the PERSISTED node
    // trees (the iso worktree may be gone; the agent is never re-run) so the
    // snapshot phase is skipped. RFC-130 §6.2: a crash-recovered pending-merge
    // that now conflicts goes through the SAME merge agent as a live dispatch;
    // unresolved → conflict-human (resume replay #2 completes the human fix).
    const merge = await mergeBackAndSettle({
      db,
      writeSem: state.writeSem,
      handle,
      nodeRunId: r.id,
      repoCount: task.repoCount,
      nodeTrees,
      via: 'replay',
      conflictResolver: (conflicts, containerPath) =>
        resolveMergeConflicts(state, {
          conflicts,
          containerPath,
          conflictNodeRunId: r.id,
          nodeId: r.nodeId,
          iteration: r.iteration,
        }),
      log,
    })
    if (merge.kind === 'merged') {
      log.info('pending-merge replay merged', { nodeRunId: r.id })
      // RFC-210 (review round 5, P2): a replayed merge never passes a live
      // site's discard — without this the node-scoped pool refs leak forever
      // and a NEW path's worktree anchor is never handed over. Best-effort:
      // the iso worktree is usually already gone (that is why we replayed).
      await discardNodeIso(handle, log, state.writeSem)
    } else {
      log.warn('pending-merge replay conflict → conflict-human (merge agent could not resolve)', {
        nodeRunId: r.id,
        detail: merge.detail,
      })
    }
  }
}

/**
 * RFC-130 §6.3 resume — on task resume, complete any conflict-human node whose
 * human has resolved its conflict in the preserved resolve-iso worktree(s). A repo
 * that now merges cleanly → materialized + the row flips to 'merged' (the frontier
 * releases its downstream); a repo still unresolved keeps the row at
 * 'conflict-human' → the frontier re-parks the task at awaiting_human. Runs at the
 * resume entry (before the scope loop), right after replayPendingMerges.
 */
async function replayConflictHumanResolutions(state: SchedulerState, log: Logger): Promise<void> {
  const { db, taskId, task } = state
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.mergeState, 'conflict-human' satisfies MergeState),
      ),
    )
  if (rows.length === 0) return
  const taskBaseHeads: Record<string, string> = {}
  for (const repo of state.repos) {
    const h = await runGit(repo.worktreePath, ['rev-parse', 'HEAD'])
    taskBaseHeads[repo.worktreeDirName] = h.stdout.trim()
  }
  for (const r of rows) {
    const baseSnapshots: Record<string, string> = {}
    const nodeTrees: Record<string, string> = {}
    if (task.repoCount === 1) {
      if (r.isoBaseSnapshot !== null) baseSnapshots[''] = r.isoBaseSnapshot
      if (r.isoNodeTree !== null) nodeTrees[''] = r.isoNodeTree
    } else {
      Object.assign(baseSnapshots, parseIsoJsonMap(r.isoBaseSnapshotReposJson))
      Object.assign(nodeTrees, parseIsoJsonMap(r.isoNodeTreeReposJson))
    }
    const handle = rebuildIsoHandle({
      appHome: state.opts.appHome,
      taskId,
      // Round 6 P2 (same as replayPendingMerges): rebuild the PHYSICAL iso
      // identity from the persisted path — this is also what makes the
      // resolve-iso lookup inside completeHumanResolvedConflict hit the
      // container a process-retry actually used.
      nodeRunId: isoKeyOf(r.isoWorktreePath, r.id),
      canonRepos: state.repos,
      baseSnapshots,
      taskBaseHeads,
      forcedContainerPaths: await forcedPortPathsForTask(db, taskId),
      // RFC-210: the human-resolve completion re-merges, so it needs the same
      // per-submodule bases the original merge-back had.
      submodules: parseIsoSubmodules(r, task.repoCount),
    })
    const outcome = await state.writeSem.run(() =>
      completeHumanResolvedConflict(handle, nodeTrees, log),
    )
    if (outcome.allResolved) {
      await transitionMergeState({
        db,
        nodeRunId: r.id,
        event: { kind: 'complete-human-resolution' },
      })
      log.info('conflict-human resume: human resolution merged back', { nodeRunId: r.id })
      // RFC-210 (review round 5, P2): the park kept the iso for the human;
      // now that the resolution landed, close its lifecycle — anchor handoff
      // for NEW paths + node pool ref cleanup happen inside the discard.
      await discardNodeIso(handle, log, state.writeSem)
    } else {
      log.info('conflict-human resume: still unresolved — staying parked', {
        nodeRunId: r.id,
        repos: outcome.unresolvedRepos,
      })
    }
  }
}

/**
 * RFC-130 §6.2 — attempt to auto-resolve merge-back conflict(s) with the built-in
 * merge agent. For each conflicted repo, spins a resolve-iso from the conflicted
 * merged tree and dispatches the merge agent there (as a child node_run under the
 * conflicting run, `cause='merge-resolve'`). The dispatch is a DIRECT `runNode`
 * call — it deliberately does NOT acquire a node-pool slot, because the caller
 * holds `writeSem` across §6.2 and a pool wait here would close the writeSem↔pool
 * cycle (§7 deadlock analysis). Framework self-checks the resolution (D6); on
 * success the resolution is materialized into the canonical worktree and the
 * resolve-iso discarded, on failure the resolve-iso is preserved for awaiting_human.
 *
 * Runtime: `resolveInternalAgentRuntime(mergeAgentRuntime → mergeAgentModel →
 * defaultRuntime)`. Threading `mergeAgentRuntime`/`mergeAgentModel` from config →
 * RunTaskOptions is a follow-up (mirrors commit&push Settings wiring); until then
 * the merge agent runs on the task's `defaultRuntime`.
 */
async function resolveMergeConflicts(
  state: SchedulerState,
  opts: {
    conflicts: MergeBackConflict[]
    containerPath: string
    conflictNodeRunId: string
    nodeId: string
    iteration: number
  },
): Promise<{ allResolved: boolean; detail: string }> {
  const { db, task, log } = state
  const rt = await resolveInternalAgentRuntime(db, {
    runtimeName: state.opts.mergeAgentRuntime,
    deprecatedModel: state.opts.mergeAgentModel,
    defaultRuntime: state.opts.defaultRuntime,
  })
  const mergeNodeId = mergeResolveNodeId(opts.nodeId, opts.iteration)
  const runAgent = async (
    _legacyPrompt: string,
    cwd: string,
    manifest: MergeConflictManifest,
  ): Promise<void> => {
    const sessionRunId = await mintNodeRun(db, {
      taskId: task.id,
      nodeId: mergeNodeId,
      status: 'pending',
      cause: 'merge-resolve',
      iteration: opts.iteration,
      overrides: { parentNodeRunId: opts.conflictNodeRunId },
    })
    const frozen = await resolveFrozenRuntime(
      db,
      sessionRunId,
      null,
      null,
      {
        protocol: rt.protocol,
        binary: rt.binaryPath,
        params: {
          model: rt.model,
          variant: rt.variant,
          temperature: rt.temperature,
          steps: rt.steps,
          maxSteps: rt.maxSteps,
          isSandbox: rt.isSandbox,
        },
        configDir: rt.configDir, // RFC-154: frozen with the rest of the snapshot
      },
      // Codex impl-gate P1-2: same config-head fold as the commit-session site.
      freezeBinaryConfig(state.opts.configPath),
    )
    const envelopeNonce = await loadRunEnvelopeNonce(db, sessionRunId)
    const mergeAgent = buildMergeAgent()
    // RFC-282 B2 — single-resolver derivation (writeSem held: signal threaded).
    const mergeInjection = await resolveInjection(db, mergeAgent, {
      appHome: state.opts.appHome,
      log: log.child('merge'),
      ...(state.opts.signal ? { signal: state.opts.signal } : {}),
    })
    if (mergeInjection.kind === 'failed') {
      throw new Error(`merge injection resolve failed: ${mergeInjection.message}`)
    }
    // DIRECT runNode — bypasses the node pool on purpose (§7 deadlock avoidance).
    const mergeAgentResult = await runNode({
      taskId: task.id,
      nodeRunId: sessionRunId,
      nodeId: mergeNodeId,
      agent: mergeAgent,
      triggerContext: null,
      expandPromptTemplate: false,
      runtime: frozen.protocol,
      runtimeBinary: frozen.binary,
      runtimeParams: frozen.params,
      runtimeConfigDir: frozen.configDir, // RFC-154: frozen config-dir profile
      inputs: {},
      worktreePath: cwd,
      promptTemplate: buildMergeResolvePrompt({ manifest, envelopeNonce }),
      templateMeta: {
        repoPath: cwd,
        baseBranch: task.baseBranch,
        taskId: task.id,
        nodeId: mergeNodeId,
        iteration: opts.iteration,
        repos: state.repos,
        ...(state.repoGroupName !== null ? { repoGroupName: state.repoGroupName } : {}),
      },
      // RFC-282 B2 — same single-resolver derivation as commit-push above.
      skills: mergeInjection.spec.skills,
      dependents: mergeInjection.spec.dependents,
      mcps: mergeInjection.spec.mcps,
      plugins: mergeInjection.spec.plugins,
      appHome: state.opts.appHome,
      db,
      log: log.child('merge'),
      gitUserName: task.gitUserName,
      gitUserEmail: task.gitUserEmail,
      ...(state.opts.binaryOverride ? { binaryOverride: state.opts.binaryOverride } : {}),
      ...(state.opts.signal ? { signal: state.opts.signal } : {}),
      // RFC-208: this was the ONLY runNode call site without a timeout, and it
      // runs inside the per-task writeSem — so a merge agent that hangs blocks
      // every other writer for that task (review decisions, clarify dispatch)
      // with no SIGTERM→SIGKILL escalation ever armed. Same budget as every
      // other node.
      ...(state.opts.defaultPerNodeTimeoutMs !== undefined
        ? { timeoutMs: state.opts.defaultPerNodeTimeoutMs }
        : {}),
    })
    if (mergeAgentResult.processUnreaped === true) {
      throw new MergeAgentChildUnreapedError()
    }
  }
  let allResolved = true
  const parts: string[] = []
  for (const conflict of opts.conflicts) {
    const outcome = await resolveConflictWithAgent(conflict, {
      containerPath: opts.containerPath,
      runAgent,
      log,
    })
    if (!outcome.resolved) {
      allResolved = false
      // RFC-187 §4-2 — say what DID land: per-path salvage already
      // materialized the clean paths, so the park note must not read as
      // "the whole delta was dropped" (workgroup room note rides this).
      const salvageNote =
        conflict.salvagedPaths.length > 0
          ? ` (${conflict.salvagedPaths.length} clean path(s) already landed)`
          : ''
      parts.push(
        `${conflict.worktreeDirName || '(repo)'}: ${outcome.unresolved.map((e) => e.path).join(', ')}${salvageNote}`,
      )
    }
  }
  return { allResolved, detail: parts.join('; ') }
}

// =============================================================================
// RFC-243 §6.2 — call-workflow node: invoke another workflow as an independent
// child task running INSIDE this node's iso worktree. From the parent's
// perspective the node is agent-shaped: derive iso → run (the child task) →
// write outputs → merge back; conflict parking, merge_state gating, replay and
// GC all reuse the RFC-130 machinery. Recovery (daemon restart, reap) re-enters
// through the SAME function: the frontier redispatches the interrupted row and
// the adoption block decides attach / resume-child / finalize instead of
// re-launching (design §4.2 — minting here would abandonSupersededMergeStates
// the child's canonical iso generation, so adoption NEVER mints).
// =============================================================================

const CALL_CHILD_OBSERVE_MS = 5_000
/** Bounded wait proving a child's daemon-restart interrupt is this process going down. */
const SHUTDOWN_CONFIRM_MS = 2_000

interface CallLedger {
  callHumanWaitMs: number
  callHumanWaitSince: number | null
}

function parseCallLedger(json: string | null): CallLedger {
  if (json === null || json === '') return { callHumanWaitMs: 0, callHumanWaitSince: null }
  try {
    const o = JSON.parse(json) as { callHumanWaitMs?: unknown; callHumanWaitSince?: unknown }
    return {
      callHumanWaitMs:
        typeof o.callHumanWaitMs === 'number' && o.callHumanWaitMs >= 0 ? o.callHumanWaitMs : 0,
      callHumanWaitSince:
        typeof o.callHumanWaitSince === 'number' && o.callHumanWaitSince > 0
          ? o.callHumanWaitSince
          : null,
    }
  } catch {
    return { callHumanWaitMs: 0, callHumanWaitSince: null }
  }
}

async function runCallWorkflowNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, task, taskId, definition, opts, writeSem, log } = state
  const { node, iteration } = args
  const taskRow = task as unknown as {
    refClosureJson?: string | null
    /** RFC-271 T6e：v2 边键的 source —— 本任务正在跑的工作流 id。 */
    workflowId?: string | null
    invocationDepth?: number | null
    parentTaskId?: string | null
    ownerUserId?: string | null
  }

  const isWorkgroupCall = node.kind === 'call-workgroup'
  const selectorField = isWorkgroupCall ? 'workgroupName' : 'workflowName'
  const workflowName = pickString(node, selectorField) ?? undefined
  if (workflowName === undefined) {
    return {
      kind: 'failed',
      summary: `call node is missing its ${selectorField} selector`,
      message: 'workflow-call-ref-missing',
    }
  }
  // RFC-271 T6e：v2 闭包按边取（source = 本任务的工作流 id + 该 call 节点 id）；
  // v1 存量闭包由 accessor 内部回退到按名字取，**零迁移**。
  const callSource =
    typeof taskRow.workflowId === 'string' && taskRow.workflowId.length > 0
      ? { workflowId: taskRow.workflowId, nodeId: node.id }
      : undefined
  const frozen = isWorkgroupCall
    ? null
    : frozenWorkflowFromClosure(taskRow.refClosureJson ?? null, workflowName, callSource)
  const frozenGroup = isWorkgroupCall
    ? frozenWorkgroupFromClosure(taskRow.refClosureJson ?? null, workflowName, callSource)
    : null
  if ((isWorkgroupCall ? frozenGroup : frozen) === null) {
    return {
      kind: 'failed',
      summary: `${isWorkgroupCall ? 'workgroup' : 'workflow'} '${workflowName}' is missing from the frozen call closure`,
      message: 'workflow-call-ref-missing',
    }
  }

  const { inputs: upstreamInputs, consumed: consumedUpstream } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
    definition,
    state.containerOf,
  )
  const consumedUpstreamJson = JSON.stringify(consumedUpstream)

  // ---- locate the row: adopt an in-flight/interrupted call row, else reuse
  // pending, else mint (agent-path idiom; fanout shard rows never reach here —
  // the validator rejects call nodes inside wrapper-fanout in v1).
  const sameNodeIterRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  let adoptedChildTaskId: string | null = null
  let launchedChildId: string | null = null
  let liveIso: IsoHandle | null = null
  // RFC-287 T8：取行前奏收编，但**领养区不进收编**——它复用一条 running /
  // interrupted / canceled 的行并就地转 running，与「铸行」是两码事（下面的
  // RFC-243-LOCK 说明为什么这里绝不能 mint）。以 preResolve 回调短路：拿到
  // latestExisting 后本线自己判领养，命中即整段前奏不执行。
  const resolvedCallRow = await resolveSchedulerRunRow({
    db,
    taskId,
    nodeId: node.id,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastPending: (id) => broadcastNodeStatus(taskId, id, node.id, 'pending'),
    preResolve: async (latestExisting) => {
      // RFC-243-LOCK:adoption-no-mint-begin — this block re-attaches; minting
      // here would abandonSupersededMergeStates the child's canonical iso.
      // 实现门 P1-5：领养判据按「这一代是否已收尾」而不是单看 running/interrupted。
      // daemon shutdown 的收尾会把调用行落成 canceled（RFC-095 revival 语义下它
      // 仍是可复活行），只认 running/interrupted 会漏掉领养 → 重新 mint → 同一
      // 父任务下重复发起第二个子任务（rfc243-call-workflow 恢复矩阵实测）。
      // done/failed/exhausted 是已收尾代：retry 会 mint 新行，那条行 childTaskId
      // 为空，自然走下面的发起分支。
      const ADOPTABLE_CALL_ROW_STATUSES = new Set(['pending', 'running', 'interrupted', 'canceled'])
      if (
        latestExisting === undefined ||
        latestExisting.childTaskId === null ||
        latestExisting.childTaskId === undefined ||
        !ADOPTABLE_CALL_ROW_STATUSES.has(latestExisting.status)
      ) {
        return null
      }
      adoptedChildTaskId = latestExisting.childTaskId
      if (latestExisting.status !== 'running') {
        // Wrapper-revive escape hatch (RFC-053/095 precedent): the parked /
        // reaped / shutdown-canceled call row RESUMES in place — never a fresh
        // mint (see header).
        await setNodeRunStatus({
          db,
          nodeRunId: latestExisting.id,
          to: 'running',
          allowedFrom: ['pending', 'interrupted', 'canceled'],
          allowTerminal: true,
          reason: 'call-adoption',
        })
        broadcastNodeStatus(taskId, latestExisting.id, node.id, 'running')
      }
      log.info('call node adopted its in-flight child task', {
        nodeId: node.id,
        childTaskId: adoptedChildTaskId,
      })
      return { nodeRunId: latestExisting.id }
      // RFC-243-LOCK:adoption-no-mint-end
    },
  })
  const nodeRunId = resolvedCallRow.nodeRunId
  const latestExisting = resolvedCallRow.latestExisting
  if (!resolvedCallRow.adopted) {
    await transitionNodeRunStatus({ db, nodeRunId, event: { kind: 'mark-running' } })
    broadcastNodeStatus(taskId, nodeRunId, node.id, 'running')

    // ---- gates BEFORE side effects: depth, then the global child budget
    // (ancestor-exempt scan grants — §3.2; the wait holds NO locks).
    const maxDepth = currentMaxInvocationDepth(opts.maxInvocationDepth)
    const childDepth = (taskRow.invocationDepth ?? 0) + 1
    if (childDepth > maxDepth) {
      await failCallRow(
        db,
        taskId,
        nodeRunId,
        node.id,
        'invocation-depth-exceeded',
        `invocation depth ${childDepth} exceeds the configured ceiling ${maxDepth}`,
      )
      return {
        kind: 'failed',
        summary: `invocation depth ${childDepth} exceeds the configured ceiling ${maxDepth}`,
        message: 'invocation-depth-exceeded',
      }
    }
    const budget = await ensureChildTaskBudget(db, () => opts.maxActiveChildTasks ?? 8)
    const ancestors: string[] = [taskId]
    {
      let cursor = taskRow.parentTaskId ?? null
      while (cursor !== null && !ancestors.includes(cursor)) {
        ancestors.push(cursor)
        const row = await db
          .select({ parentTaskId: tasks.parentTaskId })
          .from(tasks)
          .where(eq(tasks.id, cursor))
          .get()
        cursor = row?.parentTaskId ?? null
      }
    }
    let hold: Awaited<ReturnType<typeof budget.acquire>>
    try {
      hold = await budget.acquire(ancestors, {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
    } catch {
      await failCallRow(
        db,
        taskId,
        nodeRunId,
        node.id,
        'canceled',
        'canceled while queued for a child-task slot',
        'canceled',
      )
      return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
    }

    // ---- D: derive the child's workspace from THIS node's iso (slot first,
    // snapshot second — the agent path's slot-then-iso ordering, so a
    // long budget queue cannot serve the child a stale base).
    try {
      liveIso = await createIsoUnderLock({
        writeSem,
        appHome: opts.appHome,
        taskId,
        db,
        isoKeyRunId: nodeRunId,
        canonRepos: state.repos,
        log,
      })
    } catch (err) {
      hold.release()
      const msg = err instanceof Error ? err.message : String(err)
      await failCallRow(
        db,
        taskId,
        nodeRunId,
        node.id,
        'iso-setup-failed',
        `isolated worktree setup failed: ${msg}`,
      )
      return {
        kind: 'failed',
        summary: 'isolated worktree setup failed',
        message: 'iso-setup-failed',
      }
    }
    if (!liveIso.passthrough) await persistIsoBase(db, nodeRunId, task.repoCount, liveIso)
    const childIso: IsoHandle = liveIso

    // ---- L: launch the child through the executor facade. The child task id
    // is pre-minted so the call row's childTaskId stamp lands BEFORE the
    // child INSERT — a crash between the two surfaces as `child-deleted`
    // (dangling stamp) instead of a duplicate child on redispatch.
    const childId = ulid()
    await db.update(nodeRuns).set({ childTaskId: childId }).where(eq(nodeRuns.id, nodeRunId))
    try {
      if (isWorkgroupCall) {
        await launchCallWorkgroupChild(state, {
          node,
          nodeRunId,
          childId,
          frozenGroup: frozenGroup!,
          workgroupName: workflowName,
          inputs: upstreamInputs,
          iso: childIso,
          childDepth,
          iteration,
          inheritedShardKey: latestExisting?.shardKey ?? null,
        })
      } else {
        await launchCallChild(state, {
          node,
          nodeRunId,
          childId,
          frozen: frozen!,
          workflowName,
          inputs: upstreamInputs,
          iso: childIso,
          childDepth,
        })
      }
      hold.bind(childId)
      registerKnownChildTask(childId)
      launchedChildId = childId
    } catch (err) {
      hold.release()
      await db.update(nodeRuns).set({ childTaskId: null }).where(eq(nodeRuns.id, nodeRunId))
      await discardNodeIso(liveIso, log, writeSem)
      const code =
        err instanceof ValidationError || err instanceof DomainError || err instanceof NotFoundError
          ? err.code
          : 'child-launch-failed'
      const msg = err instanceof Error ? err.message : String(err)
      await failCallRow(db, taskId, nodeRunId, node.id, code, `child launch failed: ${msg}`)
      return { kind: 'failed', summary: `child launch failed: ${msg}`, message: code }
    }
  }
  if (adoptedChildTaskId === null && launchedChildId === null) {
    // unreachable — both arms either set an id or returned; guard for TS + drift.
    return {
      kind: 'failed',
      summary: 'call node resolved no child task',
      message: 'child-launch-failed',
    }
  }
  const childTaskId: string = adoptedChildTaskId ?? (launchedChildId as string)

  // ---- W: await the child's terminal state, keeping the §4.5 human-wait
  // ledger current (observed at CALL_CHILD_OBSERVE_MS granularity) and
  // re-driving an interrupted child once per observation (design §4.2 ②).
  // 实现门 P2-1 — the human-wait ledger belongs to ONE invocation generation:
  // adopt the persisted account only when re-attaching the SAME row; a fresh
  // mint (retry supersession) starts at zero, otherwise the superseded
  // generation's wait would be deducted twice (callRowHumanWait sums ALL call
  // rows of the task).
  let ledger =
    adoptedChildTaskId !== null
      ? parseCallLedger(latestExisting?.wrapperProgressJson ?? null)
      : parseCallLedger(null)
  const persistLedger = async (): Promise<void> => {
    await db
      .update(nodeRuns)
      .set({ wrapperProgressJson: JSON.stringify(ledger) })
      .where(eq(nodeRuns.id, nodeRunId))
      .catch?.(() => {})
  }
  const observeChild = async (): Promise<void> => {
    const row = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, childTaskId))
      .get()
    const awaiting =
      row !== undefined && (row.status === 'awaiting_review' || row.status === 'awaiting_human')
    const now = Date.now()
    if (awaiting && ledger.callHumanWaitSince === null) {
      ledger = { ...ledger, callHumanWaitSince: now }
      await persistLedger()
    } else if (!awaiting && ledger.callHumanWaitSince !== null) {
      ledger = {
        callHumanWaitMs: ledger.callHumanWaitMs + Math.max(0, now - ledger.callHumanWaitSince),
        callHumanWaitSince: null,
      }
      await persistLedger()
    }
  }

  let resumeAttempted = false
  let outcomeStatus: string
  for (;;) {
    const obsTimer = setInterval(() => {
      void observeChild().catch(() => {})
    }, CALL_CHILD_OBSERVE_MS)
    let watched: Awaited<ReturnType<typeof watchTaskTerminal>>
    try {
      watched = await watchTaskTerminal(db, childTaskId, {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        pollMs: 20_000,
      })
    } finally {
      clearInterval(obsTimer)
      await observeChild().catch(() => {})
    }
    if (watched.kind === 'aborted') {
      const shutdown = isShutdownAbort(opts.signal)
      if (!shutdown) {
        // User cancel — cascade into the child (belt; cancelTask's own child
        // enumeration is the suspenders) and settle the row canceled.
        try {
          const { cancelTask } = await import('@/services/task')
          await cancelTask(db, childTaskId, { cascadeFromParent: true })
        } catch {
          // already terminal / racing — the durable marker decides later
        }
        await failCallRow(db, taskId, nodeRunId, node.id, 'canceled', 'task canceled', 'canceled')
        return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
      }
      // Daemon shutdown: leave the row running — boot reap flips it to
      // interrupted and adoption re-attaches on resume (child stays revivable).
      return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
    }
    if (watched.kind === 'missing') {
      await failCallRow(
        db,
        taskId,
        nodeRunId,
        node.id,
        'child-deleted',
        `child task '${childTaskId}' row disappeared before finalize`,
      )
      return {
        kind: 'failed',
        summary: `child task '${childTaskId}' was deleted before its result was consumed`,
        message: 'child-deleted',
      }
    }
    outcomeStatus = watched.status
    // 实现门 P1-5 实测缺陷：daemon 关停时子任务先落 `interrupted`，watch 因此
    // 以 terminal（而非 aborted）返回；若继续按终态映射，就会把「整机关停」
    // 误判成「子任务不可恢复」→ 调用行 failed → 父任务 failed（而非可恢复的
    // interrupted），resume 时该行已终态、不再被领养 → 重复发起第二个子任务、
    // 旧子任务沦为孤儿。关停期一律不收尾：保持行 running，交给 boot reap 翻
    // interrupted，由 resume 的 adoption 续上（design §4.2）。
    if (isShutdownAbort(opts.signal)) {
      return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
    }
    if (outcomeStatus === 'interrupted' && !resumeAttempted) {
      // §4.2 ② — parent-driven child recovery (independent of autoResumeOnBoot).
      resumeAttempted = true
      try {
        const { resumeTask } = await import('@/services/task')
        // RFC-285 B3 Q6（用户拍板）：resume 是既有子任务行的执行延续，
        // **豁免** owner-inactive 检查——D7 边界只拦「新任务创建」两臂。
        await resumeTask(db, childTaskId, buildChildDeps(state))
        continue
      } catch {
        const fresh = await db
          .select({ status: tasks.status, errorSummary: tasks.errorSummary })
          .from(tasks)
          .where(eq(tasks.id, childTaskId))
          .get()
        if (
          fresh !== undefined &&
          !(TERMINAL_TASK_STATUSES as readonly string[]).includes(fresh.status)
        ) {
          continue // someone else revived it — re-attach
        }
        // 实现门 P1-5 加固：`task-active` means ANOTHER in-process driver still
        // owns the child (a shutdown still draining, a concurrent resume). Its
        // row may read terminal for the moment, but the owner is the authority
        // — re-attach and let the watch settle instead of declaring failure.
        const { isTaskActive } = await import('@/services/task')
        if (isTaskActive(childTaskId)) {
          await Bun.sleep(200)
          resumeAttempted = false
          continue
        }
        // 实现门 P1-5 实测缺陷（时序无关判据）：a child interrupted by the
        // DAEMON RESTART is not "unrecoverable" — the process is going down and
        // the parent's own row is about to be reaped to interrupted too.
        // Writing a terminal failure here would (a) fail the parent instead of
        // leaving it resumable and (b) drop the call row out of the adoption
        // set, so the next resume launches a SECOND child and orphans the
        // first. `opts.signal` is NOT a reliable discriminator — the child's
        // abort can land before the parent controller fires.
        if (
          fresh?.errorSummary === DAEMON_RESTART_ERROR_SUMMARY &&
          (await awaitShutdownAbort(opts.signal, SHUTDOWN_CONFIRM_MS))
        ) {
          return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
        }
        await failCallRow(
          db,
          taskId,
          nodeRunId,
          node.id,
          'child-interrupted',
          `child task '${childTaskId}' is interrupted and could not be resumed`,
        )
        return {
          kind: 'failed',
          summary: `child task '${childTaskId}' is interrupted and could not be resumed`,
          message: 'child-interrupted',
        }
      }
    }
    break
  }

  // ---- terminal child → finalize. Non-done children map per design §6.2.
  const outcome = await getExecutionOutcome(db, childTaskId)
  if (outcome.status === 'canceled') {
    const cascade = outcome.error?.message === 'canceled-by-parent-cascade'
    if (cascade) {
      await failCallRow(
        db,
        taskId,
        nodeRunId,
        node.id,
        'canceled',
        'canceled with parent',
        'canceled',
      )
      return { kind: 'canceled', summary: 'task canceled', message: 'canceled-with-parent' }
    }
    await failCallRow(
      db,
      taskId,
      nodeRunId,
      node.id,
      'child-canceled',
      `child task '${childTaskId}' was canceled directly`,
    )
    return {
      kind: 'failed',
      summary: `child task '${childTaskId}' was canceled outside this parent`,
      message: 'child-canceled',
    }
  }
  if (outcome.status === 'interrupted') {
    // 实现门 P1-5（同一判据，终态映射侧）：daemon-restart 中断留给 boot reap
    // + adoption，绝不写成 call 行的终态失败。
    if (
      outcome.error?.summary === DAEMON_RESTART_ERROR_SUMMARY &&
      (await awaitShutdownAbort(opts.signal, SHUTDOWN_CONFIRM_MS))
    ) {
      return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
    }
    await failCallRow(
      db,
      taskId,
      nodeRunId,
      node.id,
      'child-interrupted',
      `child task '${childTaskId}' stayed interrupted`,
    )
    return {
      kind: 'failed',
      summary: `child task '${childTaskId}' is interrupted and could not be resumed`,
      message: 'child-interrupted',
    }
  }
  if (outcome.status !== 'done') {
    const summary = outcome.error?.summary ?? `child task '${childTaskId}' failed`
    await failCallRow(
      db,
      taskId,
      nodeRunId,
      node.id,
      'child-task-failed',
      `${summary}${outcome.error?.message ? ` (${outcome.error.message})` : ''}`,
    )
    return {
      kind: 'failed',
      summary: `child task failed: ${summary}`,
      message: 'child-task-failed',
    }
  }

  // ---- F: copy the child's projected outputs onto the call row (idempotent —
  // the merge_state-staged replay re-enters here). archiveJson rides along so
  // forcedPortPathsForTask keeps covering child-produced gitignored files.
  // 实现门 P1-3 — a call-workgroup node declares EXACTLY one output (`result`).
  // dw-mode children project raw workflow ports; collapse them into `result`
  // (lexicographic `## name` sections, design §6.3) so the declared port is
  // never silently empty.
  const projectedOutputs: typeof outcome.outputs = isWorkgroupCall
    ? Object.hasOwn(outcome.outputs, 'result')
      ? { result: outcome.outputs.result! }
      : {
          result: {
            content: Object.entries(outcome.outputs)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, v]) => `## ${name}\n${v.content}`)
              .join('\n\n'),
            kind: 'text',
          },
        }
    : outcome.outputs
  for (const [portName, v] of Object.entries(projectedOutputs)) {
    // RFC-306 D17: a branch closed INSIDE the child keeps propagating in the
    // parent graph — the child's inactive port projects onto an inactive parent
    // port, so a reusable "decider" workflow can be called as a sub-workflow.
    const active = v.active !== false
    await db
      .insert(nodeRunOutputs)
      .values({
        nodeRunId,
        portName,
        content: v.content,
        kind: v.kind,
        archiveJson: v.archiveJson ?? null,
        active,
      })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: v.content, kind: v.kind, archiveJson: v.archiveJson ?? null, active },
      })
  }
  // Row goes done BEFORE merge (runner precedent) — downstream still gates on
  // merge_state (deriveFrontier D15), so nothing dispatches early.
  const currentRow = await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get()
  if (currentRow !== undefined && currentRow.status !== 'done') {
    await setNodeRunStatus({
      db,
      nodeRunId,
      to: 'done',
      allowedFrom: ['running'],
      extra: { finishedAt: Date.now() },
      reason: 'call-child-done',
    })
    broadcastNodeStatus(taskId, nodeRunId, node.id, 'done')
  }

  // ---- M: merge the iso (the child's canonical) back into the parent
  // canonical, staged by merge_state (design §4.2 R):
  //   merged         → outputs re-written above; nothing to merge.
  //   conflict-human → still parked; resume replay owns completion.
  //   pending-merge  → the task-entry replayPendingMerges already merged (or
  //                    will on next resume) — treat like merged here if it
  //                    settled, else leave for replay.
  //   isolating/null → live merge (snapshots the iso final state itself).
  const mergeStateNow = currentRow?.mergeState ?? null
  if (mergeStateNow === 'conflict-human') {
    return {
      kind: 'awaiting_human',
      summary: 'merge conflict awaiting human resolution',
      message: 'merge-conflict',
    }
  }
  if (mergeStateNow === null && liveIso === null) {
    // Passthrough/mock harness adoption: nothing persisted to merge.
    return { kind: 'ok', summary: `child task ${childTaskId} done`, message: '' }
  }
  if (mergeStateNow !== 'merged') {
    let handle = liveIso
    if (handle === null) {
      // Adoption after restart — rebuild from persisted columns (replay idiom).
      const baseSnapshots: Record<string, string> = {}
      if (task.repoCount === 1) {
        if (currentRow?.isoBaseSnapshot != null) baseSnapshots[''] = currentRow.isoBaseSnapshot
      } else {
        Object.assign(baseSnapshots, parseIsoJsonMap(currentRow?.isoBaseSnapshotReposJson ?? null))
      }
      if (Object.keys(baseSnapshots).length === 0) {
        await markMergeFailed(db, nodeRunId, 'call adoption: iso base snapshot missing', log)
        return {
          kind: 'failed',
          summary: 'call adoption could not rebuild the iso handle (base snapshot missing)',
          message: 'merge-back-failed',
        }
      }
      const taskBaseHeads: Record<string, string> = {}
      for (const repo of state.repos) {
        const h = await runGit(repo.worktreePath, ['rev-parse', 'HEAD'])
        taskBaseHeads[repo.worktreeDirName] = h.stdout.trim()
      }
      const submodules =
        currentRow !== undefined ? parseIsoSubmodules(currentRow, task.repoCount) : {}
      handle = rebuildIsoHandle({
        appHome: state.opts.appHome,
        taskId,
        nodeRunId: isoKeyOf(currentRow?.isoWorktreePath ?? null, nodeRunId),
        canonRepos: state.repos,
        baseSnapshots,
        taskBaseHeads,
        submodules,
        forcedContainerPaths: await forcedPortPathsForTask(db, taskId),
      })
    }
    if (!handle.passthrough) {
      try {
        const merge = await mergeBackAndSettle({
          db,
          writeSem,
          handle,
          nodeRunId,
          repoCount: task.repoCount,
          via: 'live',
          conflictResolver: (conflicts, containerPath) =>
            resolveMergeConflicts(state, {
              conflicts,
              containerPath,
              conflictNodeRunId: nodeRunId,
              nodeId: node.id,
              iteration,
            }),
          log,
        })
        if (merge.kind === 'conflict-human') {
          log.warn('call merge-back conflict unresolved → awaiting_human', {
            nodeId: node.id,
            detail: merge.detail,
          })
          return {
            kind: 'awaiting_human',
            summary: `merge conflict unresolved: ${merge.detail}`,
            message: 'merge-conflict',
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('call merge-back failed', { nodeId: node.id, error: msg })
        await markMergeFailed(db, nodeRunId, msg, log)
        return {
          kind: 'failed',
          summary: `merge-back failed: ${msg}`,
          message: 'merge-back-failed',
        }
      }
    }
    await discardNodeIso(handle, log, writeSem)
  }
  return { kind: 'ok', summary: `child task ${childTaskId} done`, message: '' }
}

/** Settle a call row into a terminal status with its failure metadata. */
async function failCallRow(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
  nodeId: string,
  failureCode: string,
  errorMessage: string,
  to: 'failed' | 'canceled' = 'failed',
): Promise<void> {
  const ok = await setNodeRunStatus({
    db,
    nodeRunId,
    to,
    allowedFrom: ['pending', 'running'],
    extra: { finishedAt: Date.now(), errorMessage, failureCode },
    reason: 'call-settle',
  })
    .then(() => true)
    .catch(() => false)
  if (ok) broadcastNodeStatus(taskId, nodeRunId, nodeId, to)
}

function isShutdownAbort(signal: AbortSignal | undefined): boolean {
  if (signal === undefined || !signal.aborted) return false
  return signal.reason === DAEMON_SHUTDOWN_ABORT_REASON
}

/**
 * RFC-243 实现门 P1-5 — confirm that a child's `daemon-restart` interrupt is
 * THIS daemon going down, by waiting (bounded) for the parent's own shutdown
 * abort. The child's abort routinely lands first (abortAllActiveTasks iterates
 * one map), so an instantaneous `signal.aborted` check is not a discriminator.
 * Confirmed ⇒ the caller yields without writing a terminal row and the
 * parent's ordinary shutdown path (`cancelTaskRow`) records `interrupted`,
 * keeping the whole tree resumable. NOT confirmed (e.g. a stale interrupt
 * inherited from a previous crash that resume could not clear) ⇒ the caller
 * keeps its genuine `child-interrupted` failure.
 */
async function awaitShutdownAbort(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (signal === undefined) return false
  if (signal.aborted) return signal.reason === DAEMON_SHUTDOWN_ABORT_REASON
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(false)
    }, timeoutMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(signal.reason === DAEMON_SHUTDOWN_ABORT_REASON)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Child StartTaskDeps assembled from the parent scheduler's runtime options. */
function buildChildDeps(state: SchedulerState): StartTaskDeps {
  const { opts, db } = state
  return {
    db,
    // RFC-292: child/grandchild tasks inherit the root launch fact atomically
    // with their parent linkage; they never re-read a webhook delivery.
    ...(state.triggerContext === null ? {} : { triggerContext: state.triggerContext }),
    actorUserId:
      (state.task as unknown as { ownerUserId?: string | null }).ownerUserId ?? undefined,
    // RFC-284 T20：继承面整体透传（唯一登记 INHERITABLE_RUN_CONFIG_KEYS）。
    // 历史逐字段展开的三段关键注释（RFC-282 收尾门 configPath 漏斗第三段 /
    // RFC-266 两个 daemon-wide 池 resize-on-read 连坐 / RFC-269 code-host 池同理）
    // 已并入注册表与处置表测试——漏配从「人肉记得展开」变「编译期表态」。
    ...pickInheritableRunConfig(opts),
  } as StartTaskDeps
}

/** L — assemble and fire the child launch through the executor facade. */
async function launchCallChild(
  state: SchedulerState,
  args: {
    node: WorkflowNode
    nodeRunId: string
    childId: string
    frozen: { id: string; version: number; definition: unknown }
    workflowName: string
    inputs: Record<string, string>
    iso: IsoHandle
    childDepth: number
  },
): Promise<void> {
  const { db, task, taskId } = state
  const taskRow = task as unknown as {
    refClosureJson?: string | null
    ownerUserId?: string | null
  }
  const { node, nodeRunId, childId, frozen, workflowName, inputs, iso, childDepth } = args
  const frozenSnapshotJson = JSON.stringify(frozen.definition)

  // Child collaborators = the parent task's members (D11).
  const memberRows = await db
    .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.taskId, taskId))
  const collaboratorUserIds = [
    ...new Set(
      memberRows
        .filter((m) => m.role !== 'owner' && m.userId !== null)
        .map((m) => m.userId as string),
    ),
  ]

  const limits = ((): { maxDurationMs?: number; maxTotalTokens?: number } => {
    const raw = (node as unknown as Record<string, unknown>).limits
    if (typeof raw !== 'object' || raw === null) return {}
    const o = raw as { maxDurationMs?: unknown; maxTotalTokens?: unknown }
    return {
      ...(typeof o.maxDurationMs === 'number' ? { maxDurationMs: o.maxDurationMs } : {}),
      ...(typeof o.maxTotalTokens === 'number' ? { maxTotalTokens: o.maxTotalTokens } : {}),
    }
  })()

  const nodeTitle = pickString(node, 'title') ?? node.id
  const childName = `${task.name} › ${nodeTitle}`.slice(0, 255)

  // The synthesized 'inherited' space: the child's canonical IS this call
  // node's iso worktree(s); cleanup carries ZERO worktrees + no owned root
  // (borrowed semantics — the iso lifecycle stays with the parent).
  const primary = iso.repos[0]
  const space: MaterializedSpace = {
    kind: state.repos.length > 1 ? 'multi' : 'single',
    spaceKind: 'inherited',
    taskId: childId,
    worktreePath:
      state.repos.length > 1 ? iso.containerPath : (primary?.isoWorktreePath ?? task.worktreePath),
    branch: task.branch ?? `agent-workflow/${childId}`,
    baseCommit: primary?.baseSnapshot ?? null,
    earlyError: null,
    resolvedSources: [],
    nodePaths: [],
    cleanup: { taskId: childId, ownedRoot: null, worktrees: [], state: 'owned', report: null },
    repos: iso.repos.map((r, i) => ({
      repoIndex: i,
      repoPath: r.repoPath,
      repoUrl: null,
      cachedRepoId: null,
      baseBranch: r.baseBranch,
      branch: task.branch ?? `agent-workflow/${childId}`,
      baseCommit: r.baseSnapshot ?? null,
      worktreePath: r.isoWorktreePath,
      worktreeDirName: r.worktreeDirName,
      mountPath: r.worktreeDirName,
      subdir: '',
      readonly: false,
      submoduleInitOk: true,
      submoduleInitError: null,
      hasSubmodules: false,
    })),
  }

  const payload: StartTask = {
    workflowId: frozen.id,
    name: childName,
    inputs,
    ...(collaboratorUserIds.length > 0 ? { collaboratorUserIds } : {}),
    ...limits,
    // publication belongs to the parent (D12): no workingBranch, no auto push.
    autoCommitPush: false,
  } as StartTask

  const { startExecution } = await import('@/services/execution/executor')
  // RFC-285 B3（D7/E4）：显式 buildInheritedActor 取代 `as unknown as` 伪造幽灵。
  // owner 失活/缺行 → 子任务拒启（外层 catch 把 code 直通 failCallRow →
  // 节点以 call-owner-inactive 失败）；NULL owner legacy 行按 Q5 放行
  // （__system__ 幽灵，空权限，语义与历史伪造一致）。
  const actor = await buildInheritedActor(db, taskRow.ownerUserId ?? null, 'call-workflow')
  if (actor === null) {
    throw new ValidationError(
      'call-owner-inactive',
      `task owner '${taskRow.ownerUserId}' is not an active user; refusing to start call child`,
    )
  }
  await startExecution(
    db,
    actor,
    {
      kind: 'workflow',
      refId: frozen.id,
      invoker: {
        type: 'node',
        parentTaskId: taskId,
        parentNodeRunId: nodeRunId,
        invocationDepth: childDepth,
      },
      payload,
    },
    {
      ...buildChildDeps(state),
      materializedSpace: space,
      callLaunch: {
        parentTaskId: taskId,
        parentNodeRunId: nodeRunId,
        invocationDepth: childDepth,
        frozenSnapshotJson,
        refClosureJson: childClosureSubset(
          taskRow.refClosureJson ?? null,
          frozen.definition as Parameters<typeof childClosureSubset>[1],
          // RFC-271 T6e：子集裁剪要用**子工作流自己的 id** 当 source（v2 边键）。
          // 调用点本来就持有 frozen.id，此前只是没传进去。
          frozen.id,
        ),
      },
    },
  )
  void workflowName
}

/**
 * RFC-243 §6.3 — bare goalTemplate expansion. {{port}} tokens read the
 * resolved upstream inputs; repo-shaped builtin tokens describe the CHILD's
 * workspace (the call-node iso); identity tokens describe the CALLER context.
 * Unknown tokens render '' (validator §5 already nudges at edit time). The
 * rendered string is LITERAL for the child — the workgroup prompt layer's
 * literal-render protection (2026-07-27) keeps embedded `{{…}}` inert.
 */
function renderCallGoal(
  template: string,
  inputs: Record<string, string>,
  triggerContext: TriggerContext | null,
  meta: {
    taskId: string
    nodeId: string
    iteration: number
    shardKey: string | null
    repos: ReadonlyArray<{ isoWorktreePath: string; worktreeDirName: string; baseBranch: string }>
  },
): string {
  const primary = meta.repos[0]
  const builtins: Record<string, string> = {
    __repo_path__: primary?.isoWorktreePath ?? '',
    __base_branch__: primary?.baseBranch ?? '',
    __task_id__: meta.taskId,
    __node_id__: meta.nodeId,
    __iteration__: String(meta.iteration),
    __shard_key__: meta.shardKey ?? '',
    __repo_count__: String(meta.repos.length),
    __repo_names__: meta.repos.map((r) => r.worktreeDirName || '(root)').join(', '),
    __repos__: meta.repos
      .map((r) => `- ${r.worktreeDirName || '(root)'}: ${r.isoWorktreePath}`)
      .join('\n'),
  }
  const rendered = renderCallWorkgroupGoalTemplate({
    template,
    inputs,
    builtins,
    triggerContext,
  })
  if (!rendered.ok && rendered.code === 'trigger-context-missing') {
    throw new ValidationError(
      'trigger-context-missing',
      'workgroup goal requires webhook trigger context',
    )
  }
  if (!rendered.ok) {
    throw new ValidationError(
      'workflow-invalid',
      `workgroup goal contains an invalid template ref (${rendered.reason})`,
    )
  }
  return rendered.value
}

/** L (workgroup arm) — frozen-group launch through the RFC-243 frozen face. */
async function launchCallWorkgroupChild(
  state: SchedulerState,
  args: {
    node: WorkflowNode
    nodeRunId: string
    childId: string
    frozenGroup: FrozenWorkgroupRef
    workgroupName: string
    inputs: Record<string, string>
    iso: IsoHandle
    childDepth: number
    iteration: number
    inheritedShardKey: string | null
  },
): Promise<void> {
  const { db, task, taskId } = state
  const taskRow = task as unknown as {
    ownerUserId?: string | null
  }
  const { node, nodeRunId, childId, frozenGroup, inputs, iso, childDepth } = args

  const goalTemplate = pickString(node, 'goalTemplate') ?? ''
  const goal = renderCallGoal(goalTemplate, inputs, state.triggerContext, {
    taskId,
    nodeId: node.id,
    iteration: args.iteration,
    shardKey: args.inheritedShardKey,
    repos: iso.repos.map((r) => ({
      isoWorktreePath: r.isoWorktreePath,
      worktreeDirName: r.worktreeDirName,
      mountPath: r.worktreeDirName,
      subdir: '',
      readonly: false,
      baseBranch: r.baseBranch,
    })),
  })

  const memberRows = await db
    .select({ userId: taskCollaborators.userId, role: taskCollaborators.role })
    .from(taskCollaborators)
    .where(eq(taskCollaborators.taskId, taskId))
  const collaboratorUserIds = [
    ...new Set(
      memberRows
        .filter((m) => m.role !== 'owner' && m.userId !== null)
        .map((m) => m.userId as string),
    ),
  ]

  const limits = ((): { maxDurationMs?: number; maxTotalTokens?: number } => {
    const raw = (node as unknown as Record<string, unknown>).limits
    if (typeof raw !== 'object' || raw === null) return {}
    const o = raw as { maxDurationMs?: unknown; maxTotalTokens?: unknown }
    return {
      ...(typeof o.maxDurationMs === 'number' ? { maxDurationMs: o.maxDurationMs } : {}),
      ...(typeof o.maxTotalTokens === 'number' ? { maxTotalTokens: o.maxTotalTokens } : {}),
    }
  })()
  const nodeTitle = pickString(node, 'title') ?? node.id
  const childName = `${task.name} › ${nodeTitle}`.slice(0, 255)
  const primary = iso.repos[0]
  const space: MaterializedSpace = {
    kind: state.repos.length > 1 ? 'multi' : 'single',
    spaceKind: 'inherited',
    taskId: childId,
    worktreePath:
      state.repos.length > 1 ? iso.containerPath : (primary?.isoWorktreePath ?? task.worktreePath),
    branch: task.branch ?? `agent-workflow/${childId}`,
    baseCommit: primary?.baseSnapshot ?? null,
    earlyError: null,
    resolvedSources: [],
    nodePaths: [],
    cleanup: { taskId: childId, ownedRoot: null, worktrees: [], state: 'owned', report: null },
    repos: iso.repos.map((r, i) => ({
      repoIndex: i,
      repoPath: r.repoPath,
      repoUrl: null,
      cachedRepoId: null,
      baseBranch: r.baseBranch,
      branch: task.branch ?? `agent-workflow/${childId}`,
      baseCommit: r.baseSnapshot ?? null,
      worktreePath: r.isoWorktreePath,
      worktreeDirName: r.worktreeDirName,
      mountPath: r.worktreeDirName,
      subdir: '',
      readonly: false,
      submoduleInitOk: true,
      submoduleInitError: null,
      hasSubmodules: false,
    })),
  }

  const { startWorkgroupTaskFromFrozen } = await import('@/services/workgroup/launch')
  // RFC-285 B3（D7/E4）：本臂不构造 actor（冻结面内部装配），但同受 owner
  // 失活拒启约束——preflight 判定，失败经外层 catch 落 call-owner-inactive。
  if ((await buildInheritedActor(db, taskRow.ownerUserId ?? null, 'call-workgroup')) === null) {
    throw new ValidationError(
      'call-owner-inactive',
      `task owner '${taskRow.ownerUserId}' is not an active user; refusing to start call child`,
    )
  }
  await startWorkgroupTaskFromFrozen(
    db,
    {
      frozenGroup: frozenGroup.group as Parameters<
        typeof startWorkgroupTaskFromFrozen
      >[1]['frozenGroup'],
      workgroupId: frozenGroup.id,
      goal,
      name: childName,
      collaboratorUserIds,
      ...limits,
    },
    {
      ...buildChildDeps(state),
      materializedSpace: space,
      callLaunch: {
        parentTaskId: taskId,
        parentNodeRunId: nodeRunId,
        invocationDepth: childDepth,
        // The host snapshot is composed INSIDE the frozen launch face (it
        // needs the runtime config); the workgroupLaunch dep drives the
        // snapshot — this arm only carries the parent linkage + closure rules.
        frozenSnapshotJson: null,
        refClosureJson: null,
      },
    },
  )
}

// ---------------------------------------------------------------------------
// RFC-253 — script node dispatch.
//
// Structurally parallel to the agent branch below, but it cannot SHARE that
// code: the agent path's semaphore/iso/retry block sits after the
// `kind !== 'agent-single'` guard, so a script node never reaches it
// (design-gate F6). What IS shared are the primitives — the pool semaphore
// (RFC-266: the script one), the RFC-130
// isolation helpers, mintNodeRun, setNodeRunStatus, the envelope parser — which
// is where the invariants actually live.
// ---------------------------------------------------------------------------

/**
 * RFC-269 — one outbound code-host API call.
 *
 * Deliberately much shorter than `runScriptNode`: there is no iso worktree (it
 * writes no files), no subprocess (the daemon issues the request itself), and
 * **no node-level retry
 * loop**. That last one is a decision, not an omission: the executor already
 * retries at the HTTP layer where it can tell a safe retry from an unsafe one
 * (D18 — 429 always, 5xx/network only for idempotent methods). Re-running the
 * whole node on top of that would re-POST comments that may well have landed.
 * A human can still retry the node by hand; that is a judgement call, not an
 * automatic one.
 */
async function runCodeHostCallNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, task, taskId, definition, opts, log, codeHostSem } = state
  const { node, iteration } = args

  const provider = pickString(node, 'provider')
  const action = pickString(node, 'action')
  if (provider !== 'gitlab' && provider !== 'github') {
    return {
      kind: 'failed',
      summary: `code-host node ${node.id} has no valid provider`,
      message: 'code-host-param-invalid',
    }
  }
  if (action === null) {
    return {
      kind: 'failed',
      summary: `code-host node ${node.id} has no action`,
      message: 'code-host-param-invalid',
    }
  }

  const { inputs: upstreamInputs, consumed } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
    definition,
    state.containerOf,
  )

  // Row selection mirrors the script/agent branches exactly: adopt the pending
  // row if one exists (that is what `retryNode` mints for a user-requested
  // retry and what the cascade mints downstream), otherwise take the next
  // retry index. Minting unconditionally would leave the placeholder pending
  // forever and make `isFresherNodeRun` pick between two rows for the same
  // attempt.
  const consumedUpstreamJson = JSON.stringify(consumed)
  const sameNodeIterRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  // RFC-287 T8：取行前奏收编。本线两处与其余三线不同，**都不能统一掉**：
  //   · 不追 retryIndex —— 代码平台调用没有节点级重试（只有 HTTP 幂等重试）；
  //   · 不广播 pending —— 它铸完立刻转 running（下方），多播一条 WS 事件会让
  //     前台看到一个根本不存在的 pending 态。
  const { nodeRunId } = await resolveSchedulerRunRow({
    db,
    taskId,
    nodeId: node.id,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: false,
    clearAgentOverride: false,
    trackRetryIndex: false,
    broadcastPending: null,
  })
  await setNodeRunStatus({
    db,
    nodeRunId,
    to: 'running',
    allowedFrom: ['pending'],
    reason: 'code-host-call-start',
    extra: {},
  })
  broadcastNodeStatus(taskId, nodeRunId, node.id, 'running')

  const settle = async (
    to: 'done' | 'failed',
    reason: string,
    extra: Record<string, unknown>,
  ): Promise<void> => {
    await setNodeRunStatus({
      db,
      nodeRunId,
      to,
      allowedFrom: ['running'],
      reason,
      extra: { finishedAt: Date.now(), ...extra },
    })
    broadcastNodeStatus(taskId, nodeRunId, node.id, to)
  }

  // 注入优先（测试注 stub）；生产没人注入，落到密钥文件懒解析——见
  // `resolveCodeHostConnectionsFromKeyFile` 的注释：这条接线曾经整条断开。
  const connections =
    opts.codeHostConnections ?? resolveCodeHostConnectionsFromKeyFile(db, Paths.secretKeyFile)
  const connection = connections?.resolve(provider) ?? null
  if (connection === null) {
    await settle('failed', 'code-host-not-configured', {
      errorMessage: `no ${provider} connection is configured; set its base URL and token in Settings`,
      failureCode: 'code-host-not-configured',
    })
    return {
      kind: 'failed',
      summary: `${provider} is not configured`,
      message: 'code-host-not-configured',
    }
  }

  const params: Record<string, string> = {}
  const rawParams = (node as unknown as { params?: unknown }).params
  if (rawParams !== null && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
    for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
      if (typeof value === 'string') params[key] = value
    }
  }
  const rawRequest = (node as unknown as { request?: unknown }).request
  const timeoutMs =
    typeof (node as unknown as { timeoutMs?: unknown }).timeoutMs === 'number'
      ? (node as unknown as { timeoutMs: number }).timeoutMs
      : opts.codeHostRequestTimeoutMs

  const release = await codeHostSem.acquire()
  let outcome: Awaited<ReturnType<typeof executeCodeHostCall>>
  try {
    outcome = await executeCodeHostCall(
      {
        provider,
        action,
        params,
        ...(rawRequest !== undefined ? { request: rawRequest as never } : {}),
        allowDestructive:
          (node as unknown as { allowDestructive?: unknown }).allowDestructive === true,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      {
        connection,
        ctx: { ports: upstreamInputs, triggerContext: state.triggerContext },
        projectFallback: resolveProjectFallback({
          provider,
          baseUrl: connection.baseUrl,
          repositoryUrlPrefixes: connection.repositoryUrlPrefixes,
          repoUrl: task.repoUrl,
          repoCount: task.repoCount,
        }),
        ...(opts.codeHostFetch !== undefined ? { fetchImpl: opts.codeHostFetch } : {}),
        ...(opts.codeHostResponseMaxBytes !== undefined
          ? { maxResponseBytes: opts.codeHostResponseMaxBytes }
          : {}),
      },
    )
  } finally {
    release()
  }

  if (!outcome.ok) {
    await settle('failed', outcome.code, {
      errorMessage: outcome.message,
      failureCode: outcome.code,
    })
    return { kind: 'failed', summary: outcome.summary, message: outcome.code }
  }

  await db.insert(nodeRunOutputs).values([
    { nodeRunId, portName: 'response', content: outcome.body },
    { nodeRunId, portName: 'status', content: String(outcome.status) },
  ])
  await settle('done', 'code-host-call-done', {})
  return {
    kind: 'ok',
    summary: `${outcome.method} ${outcome.pathname} → ${outcome.status}`,
    message: '',
  }
}

async function runScriptNode(state: SchedulerState, args: OneNodeArgs): Promise<OneNodeResult> {
  // RFC-266: the SCRIPT pool, not the agent pool — a second-scale script must
  // not queue behind multi-minute agent runs (and cannot starve them either).
  const { db, task, taskId, definition, opts, log, scriptSem, writeSem } = state
  const { node, iteration } = args

  const language = readScriptLanguage(node)
  if (language === undefined) {
    return { kind: 'failed', summary: `script node ${node.id} has no language`, message: 'invalid' }
  }
  const isReadonly = resolveScriptReadonly(node)

  const { inputs: upstreamInputs, consumed: consumedUpstream } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
    definition,
    state.containerOf,
  )
  const consumedUpstreamJson = JSON.stringify(consumedUpstream)

  // Row selection mirrors the agent branch: adopt a pending row if one exists,
  // otherwise mint the next retry index.
  const sameNodeIterRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  // RFC-287 T8：取行前奏收编（脚本线不继承 reviewIteration、不写 agentOverrideName
  // ——它没有评审轮次也没有代理借用；其余四维与 agent 线同）。
  const resolvedRow = await resolveSchedulerRunRow({
    db,
    taskId,
    nodeId: node.id,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: false,
    clearAgentOverride: false,
    trackRetryIndex: true,
    broadcastPending: (id) => broadcastNodeStatus(taskId, id, node.id, 'pending'),
  })
  let nodeRunId = resolvedRow.nodeRunId
  const retryIndex = resolvedRow.retryIndex

  const interpreter = await resolveScriptInterpreter(language, opts.scriptInterpreters ?? {})
  if (interpreter === null) {
    await setNodeRunStatus({
      db,
      nodeRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'script-interpreter-missing',
      extra: {
        finishedAt: Date.now(),
        // 带上解析链的逐环结果，而不是只报结论——四环（which / 推导 / 存在 / 探测）
        // 失败时长得一模一样，光看结论排不了障（RFC-253 T41 的 Windows 首红实证）。
        errorMessage:
          `no ${language} interpreter available on this host: ` +
          describeInterpreterResolution(language, opts.scriptInterpreters ?? {}),
        failureCode: 'script-interpreter-missing',
      },
    })
    broadcastNodeStatus(taskId, nodeRunId, node.id, 'failed')
    return {
      kind: 'failed',
      summary: `script node ${node.id}: ${language} interpreter not found`,
      message: 'script-interpreter-missing',
    }
  }

  const maxRetries = opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET

  // RFC-287 T5c：本线改走 `runAssembly` 骨架的**模式 B**（跨 attempt 窗口）。
  // 一次 scriptSem 许可 + 一棵 iso 的窗口内由 retryPolicy 驱动多次 attempt；
  // 与 agent 线相反，脚本线**每次重试都换新树**（D24：否则上一次的文件写入会与
  // 这一次叠加）。四处逐 attempt 语义逐字保住：信号取消早退、永久失败中断、
  // 逐次铸行+广播+落基线、succeeded 驱动合并。
  let isoHandle: IsoHandle | null = null
  const isoKeyRunId = nodeRunId
  let succeeded = false
  let lastFailure: { code: string; message: string } | null = null
  let canceledMsg: string | null = null

  const createScriptIso = async (): Promise<IsoHandle> => {
    isoHandle = await createIsoUnderLock({
      writeSem,
      appHome: opts.appHome,
      taskId,
      db,
      isoKeyRunId,
      canonRepos: state.repos,
      log,
    })
    return isoHandle
  }

  return await runAssembly<Record<string, never>, ScriptAttemptOutcome, OneNodeResult>(
    {},
    {
      pools: [scriptSem],
      iso: {
        create: createScriptIso,
        // 落基线在许可保护的主 try 内（与 agent 线同档；抛出经 finally 释放后继续
        // 传播——design §10.10 的按线声明）。
        persistBase: 'in-window',
        persist: async () => {
          if (isoHandle !== null) await persistIsoBase(db, nodeRunId, task.repoCount, isoHandle)
        },
      },
      onIsoSetupFailure: (err) => {
        log.warn('script iso worktree setup failed', {
          nodeId: node.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return {
          kind: 'failed',
          // 文案与 failure code 逐字保持迁移前——它是**对外**的失败分类，改名等于
          // 让既有按 `iso-setup-failed` 归类的消费方静默失配（T14 实现门抓到的漂移）。
          summary: 'isolated worktree setup failed',
          message: 'iso-setup-failed',
        }
      },
      spawn: async (_c, attempt) => {
        // **只有 attempt 0** 在这里短路。理由是它与迁移前逐字同位：那时循环顶的
        // 取消检查发生在铸行**之前**，所以直接返回不会遗留任何未终结的行。
        //
        // attempt ≥ 1 绝不能在这里短路（二轮实现门 A-1）：那时 `onNextAttempt` 已经
        // 铸出一条 pending 行并把它标成 isolating。迁移前的代码在换树/铸行之后是
        // **无条件**进入 `runOneScriptAttempt` 的，由它把新行终结为 canceled；在这里
        // 提前返回会跳过那一步，于是留下永不运行也永不终结的孤儿行——正是 preAttempt
        // 想消灭的形态，只是触发点从「取消发生在轮顶之前」挪到了「取消发生在
        // discardIso / iso.create / onNextAttempt 的某个 await 里」。preAttempt 只能
        // 覆盖轮顶那一瞬，覆盖不了这段异步窗口，所以两者缺一不可。
        if (attempt === 0 && opts.signal?.aborted === true) {
          canceledMsg = 'signal aborted'
          return { kind: 'canceled' as const, summary: 'task canceled', message: 'signal aborted' }
        }
        const outcome = await runOneScriptAttempt(state, {
          node,
          nodeRunId,
          iteration,
          retryIndex: retryIndex + attempt,
          inputs: upstreamInputs,
          interpreter,
          isoHandle,
          isReadonly,
          language,
        })
        if (outcome.kind === 'done') succeeded = true
        else if (outcome.kind === 'canceled') canceledMsg = outcome.message
        else lastFailure = { code: outcome.message, message: outcome.summary }
        return outcome
      },
      retryPolicy: {
        shouldRetry: (outcome, attempt) => {
          if (outcome.kind === 'done' || outcome.kind === 'canceled') return false
          // Permanent failures gain nothing from another attempt.
          if ((SCRIPT_PERMANENT_FAILURE_CODES as readonly string[]).includes(outcome.message)) {
            return false
          }
          return attempt < maxRetries
        },
        // 换树 / 铸行 / 落基线之前先看取消——迁移前这一检查在循环最顶上，落进
        // 骨架时只剩 spawn 入口一处，于是取消若落在换树窗口里会留下一条永不运行
        // 的孤儿 pending 行（T14 实现门抓到的回归，见骨架 preAttempt 的注释）。
        preAttempt: () => {
          if (opts.signal?.aborted !== true) return null
          canceledMsg = 'signal aborted'
          return { kind: 'canceled' as const, summary: 'task canceled', message: 'signal aborted' }
        },
        // D24：每次重试换新树——这正是让重跑一个写文件的脚本变安全的原因。
        isoOnRetry: 'always-recreate',
        onIsoRecreateFailure: (err) => {
          lastFailure = {
            code: 'iso-recreate-failed',
            message: err instanceof Error ? err.message : String(err),
          }
          return {
            kind: 'failed',
            summary: lastFailure.message,
            message: lastFailure.code,
          }
        },
        onNextAttempt: async (attempt) => {
          nodeRunId = await mintNodeRun(db, {
            taskId,
            nodeId: node.id,
            status: 'pending',
            cause: 'process-retry',
            retryIndex: retryIndex + attempt,
            iteration,
            overrides: { consumedUpstreamRunsJson: consumedUpstreamJson },
          })
          broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
          if (isoHandle !== null) await persistIsoBase(db, nodeRunId, task.repoCount, isoHandle)
        },
      },
      mergePhase: (_c, outcome) => {
        if (outcome.kind === 'canceled') {
          return {
            skip: 'not-done',
            keep: false,
            then: {
              produce: async () => ({
                kind: 'canceled' as const,
                summary: 'task canceled',
                message: canceledMsg ?? 'signal aborted',
              }),
            },
          }
        }
        // readonly 的产物永不合回主干（一次性副本），且 settle 先于 done 写。
        if (!succeeded || isReadonly) return { skip: 'not-done', keep: false, then: 'settle' }
        if (isoHandle === null || isoHandle.passthrough) {
          return { skip: 'passthrough', keep: false, then: 'settle' }
        }
        return 'merge'
      },
      mergeBack: {
        run: async () => {
          const iso = isoHandle as IsoHandle
          const merge = await mergeBackAndSettle({
            db,
            writeSem,
            handle: iso,
            nodeRunId,
            repoCount: task.repoCount,
            via: 'live',
            conflictResolver: (conflicts, containerPath) =>
              resolveMergeConflicts(state, {
                conflicts,
                containerPath,
                conflictNodeRunId: nodeRunId,
                nodeId: node.id,
                iteration,
              }),
            log,
          })
          return merge
        },
        disposition: {
          onConflictHuman: (detail) => ({
            // 显式保留（T5a 起不再依赖 finally 谓词碰巧为假）。
            keep: true,
            produce: async () => ({
              kind: 'awaiting_human' as const,
              summary: `merge conflict unresolved: ${detail}`,
              message: 'merge-conflict',
            }),
          }),
          onThrow: (err) => ({
            keep: true,
            then: {
              produce: async () => {
                const msg = err instanceof Error ? err.message : String(err)
                await markMergeFailed(db, nodeRunId, msg, log)
                return {
                  kind: 'failed' as const,
                  summary: `script node ${node.id} merge failed`,
                  message: `merge-back-failed: ${msg}`,
                }
              },
            },
          }),
        },
      },
      // 不要在这里 `.catch(() => {})`：骨架自己会 catch 并 `log.warn('iso discard
      // failed')`，本地先吞掉等于把那条约定好的告警变成永不可达，残留工作树 / ref
      // 的清理失败就彻底没了痕迹（T14 实现门）。
      discardIso: async (h: IsoLike) => {
        await discardNodeIso(h as IsoHandle, log, writeSem)
      },
      settle: async () => {
        if (succeeded) return { kind: 'ok', summary: '', message: '' }
        return {
          kind: 'failed',
          summary: lastFailure?.message ?? `script node ${node.id} failed`,
          message: lastFailure?.code ?? 'script-nonzero-exit',
        }
      },
      log,
    },
  )
}

interface ScriptAttemptArgs {
  node: WorkflowNode
  nodeRunId: string
  iteration: number
  retryIndex: number
  inputs: Record<string, string>
  interpreter: Awaited<ReturnType<typeof resolveScriptInterpreter>> & object
  isoHandle: IsoHandle | null
  isReadonly: boolean
  language: ScriptLanguage
}

type ScriptAttemptOutcome =
  | { kind: 'done' }
  | { kind: 'failed'; summary: string; message: string }
  | { kind: 'canceled'; message: string }

/** One attempt: dependencies → spawn → ports → terminal row. */
async function runOneScriptAttempt(
  state: SchedulerState,
  a: ScriptAttemptArgs,
): Promise<ScriptAttemptOutcome> {
  const { db, task, taskId, opts, log } = state
  const runDir = runRootFor(taskId, a.nodeRunId)
  mkdirSync(runDir, { recursive: true })

  // The iso handle is created before every attempt, including readonly. The
  // scope-root fallback exists only for defensive compatibility with a
  // passthrough handle implementation.
  const worktreePath = a.isoHandle?.repos[0]?.isoWorktreePath ?? state.scopeRoot
  // Every repo this attempt may touch — the boundary must match the paths
  // `AW_REPOS_JSON` hands the script, not just the primary one.
  //
  // `name` is the RFC-248 canonical repo key (the mount path), not the legacy
  // `worktreeDirName` — the latter loses the nesting for a repo-group member
  // mounted at `a/b`.
  const repoProjection =
    a.isoHandle === null
      ? state.repos.map((r) => ({ name: r.mountPath, path: r.worktreePath }))
      : a.isoHandle.repos.map((r, i) => ({
          name: state.repos[i]?.mountPath ?? r.worktreeDirName,
          path: r.isoWorktreePath,
        }))
  // Dependencies are deterministic and prebuilt-only, but otherwise run with
  // the daemon's natural toolchain and network access.
  let depsEnv: ScriptDepsEnv | null = null
  const specs = readScriptDependencies(a.node)
  if (specs.length > 0) {
    try {
      depsEnv = await ensureScriptDepsEnv({
        appHome: opts.appHome,
        language: a.language,
        interpreterPath: a.interpreter.path,
        interpreterVersion: a.interpreter.version,
        specs,
        timeoutMs: opts.scriptDepsInstallTimeoutMs ?? 10 * 60 * 1000,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        onLine: async (stream: 'stdout' | 'stderr', line: string) => {
          await db.insert(nodeRunEvents).values({
            nodeRunId: a.nodeRunId,
            ts: Date.now(),
            kind: stream === 'stderr' ? 'stderr' : 'text',
            payload: JSON.stringify({ phase: 'deps-install', line }),
          })
        },
        log,
      })
    } catch (err) {
      const detail = err instanceof ScriptDepsInstallError ? err.detail : String(err)
      const message = err instanceof Error ? err.message : String(err)
      await setNodeRunStatus({
        db,
        nodeRunId: a.nodeRunId,
        to: 'failed',
        allowedFrom: ['pending', 'running'],
        reason: 'script-deps-install-failed',
        extra: {
          finishedAt: Date.now(),
          errorMessage: `${message}\n${detail}`.slice(0, 4000),
          failureCode: 'script-deps-install-failed',
        },
      })
      broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'failed')
      return { kind: 'failed', summary: message, message: 'script-deps-install-failed' }
    }
  }

  const envelopeNonce = await loadRunEnvelopeNonce(db, a.nodeRunId)

  // RFC-253 T28 — resolved once and shared by every diagnostic sink below, so
  // no sink can drift into persisting what another one masks.
  const scriptEnv = readScriptEnv(a.node)

  // DB first, then broadcast — a client must never observe `running` for a row
  // the database still calls `pending`.
  await setNodeRunStatus({
    db,
    nodeRunId: a.nodeRunId,
    to: 'running',
    allowedFrom: ['pending'],
    reason: 'script-dispatch',
    extra: { startedAt: Date.now() },
  })
  broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'running')

  const outcome = await runScriptProcess({
    node: a.node,
    inputs: a.inputs,
    runDir,
    worktreePath,
    // 2026-08-04 audit: hand the script the paths it is actually allowed to
    // touch. This used to be the CANONICAL worktree while a non-readonly node
    // runs in its iso copy — so a script that followed the documented
    // `AW_REPOS_JSON` contract wrote outside its isolation: EPERM on macOS,
    // and on Linux a silent write into the appHome tmpfs that evaporated at
    // exit. The agent path next door already resolves iso paths for the same
    // reason (`{{__repos__}}` below).
    repos: repoProjection.map((r) => ({ name: r.name, path: r.path })),
    taskId,
    nodeId: a.node.id,
    nodeRunId: a.nodeRunId,
    iteration: a.iteration,
    retryIndex: a.retryIndex,
    shardKey: null,
    envelopeNonce,
    interpreter: a.interpreter,
    depsEnv,
    ...(opts.defaultPerNodeTimeoutMs === undefined
      ? {}
      : { timeoutMs: opts.defaultPerNodeTimeoutMs }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    gitUserName: task.gitUserName,
    gitUserEmail: task.gitUserEmail,
    onSpawned: async ({ pid, spawnBinaryPath }) => {
      // Persist before reading a single byte of output: a daemon crash after
      // this point leaves the boot reaper something to match (design-gate P0-3).
      await db
        .update(nodeRuns)
        .set({
          pid,
          spawnBinaryPath,
          runtimeParamsJson: JSON.stringify({
            script: {
              interpreter: a.interpreter.path,
              interpreterVersion: a.interpreter.version,
              depsHash: depsEnv?.hash ?? null,
            },
          }),
        })
        .where(eq(nodeRuns.id, a.nodeRunId))
    },
    onStdoutLine: async (line) => {
      // NOT masked, deliberately: stdout is the DATA channel. Its bytes become
      // the port value verbatim (AC-27), so masking this mirror would show the
      // operator something the downstream node never sees. A script that prints
      // its own credential to stdout has published it as data.
      await db.insert(nodeRunEvents).values({
        nodeRunId: a.nodeRunId,
        ts: Date.now(),
        kind: 'text',
        payload: JSON.stringify({ line }),
      })
    },
    onStderrLine: async (line) => {
      // RFC-253 T28 — stderr is the DIAGNOSTIC channel and these rows are a
      // read surface (node-run events route, /session reconstruction, WS
      // replay). Masking only the failure detail below was not enough: that
      // value is `stderrTail`, a strict SUFFIX of the very bytes this sink
      // stores, so the same secret stayed in the clear one table over.
      await db.insert(nodeRunEvents).values({
        nodeRunId: a.nodeRunId,
        ts: Date.now(),
        kind: 'stderr',
        payload: JSON.stringify({ line: maskScriptEnvValues(line, scriptEnv) }),
      })
    },
    log,
  })

  if (outcome.result.outcome === 'aborted') {
    const daemonShutdown = opts.signal?.reason === DAEMON_SHUTDOWN_ABORT_REASON
    await setNodeRunStatus({
      db,
      nodeRunId: a.nodeRunId,
      to: daemonShutdown ? 'interrupted' : 'canceled',
      allowedFrom: ['running'],
      reason: 'script-aborted',
      extra: { finishedAt: Date.now(), exitCode: outcome.result.exitCode },
    })
    broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, daemonShutdown ? 'interrupted' : 'canceled')
    return { kind: 'canceled', message: daemonShutdown ? 'daemon-shutdown' : 'canceled' }
  }

  if (outcome.result.truncated.stdout) {
    await db.insert(nodeRunEvents).values({
      nodeRunId: a.nodeRunId,
      ts: Date.now(),
      kind: 'error',
      payload: JSON.stringify({ truncated: 'stdout' }),
    })
  }

  let failureCode = outcome.failureCode
  // impl-gate M5: single-port mode promises the port value IS stdout, byte for
  // byte. The rolling tail keeps the END and discards the HEAD, so a truncated
  // capture would hand downstream a value silently missing its beginning — a
  // JSON or CSV payload turned into an illegal fragment — while the node
  // reported success. Envelope mode already fails closed here (no opening tag
  // ⇒ `script-envelope-missing`); single-port mode needs the same treatment
  // rather than being the one place this product corrupts data quietly.
  if (
    failureCode === null &&
    outcome.result.truncated.stdout &&
    scriptOutputMode(a.node) === 'single'
  ) {
    failureCode = 'script-output-truncated'
  }
  // 2026-08-04 audit: `spawnError` had NO reader anywhere in the repo, and a
  // spawn that never started has an empty stderr tail — so "the script process
  // could not start" reached the user with a blank detail and nothing to act
  // on. Prefer the spawn reason (already translated by `explainSpawnEnoent`,
  // so a missing cwd is not reported as a missing bwrap) and fall back to the
  // stderr tail for processes that did start.
  let errorMessage: string | null =
    failureCode === null
      ? null
      : (outcome.result.spawnError ?? outcome.result.stderrTail.slice(-2000))
  const ports: Record<string, string> = {}
  /** RFC-306: ports this script closed with `active="false"`. */
  const inactivePorts = new Set<string>()

  if (failureCode === null) {
    const extraction = extractScriptPorts({
      node: a.node,
      rawStdout: outcome.result.rawStdout,
      nonce: envelopeNonce,
    })
    if (extraction.kind === 'ok') {
      Object.assign(ports, extraction.ports)
      for (const p of extraction.inactivePorts) inactivePorts.add(p)
    } else {
      failureCode = extraction.code
      errorMessage = extraction.detail
    }
  }

  // RFC-253 T28 — the persisted failure detail is a read surface: stderr tails
  // and envelope excerpts must not re-leak env values the workflow read path
  // masks. Port values stay byte-exact; only diagnostics are masked.
  if (errorMessage !== null) {
    errorMessage = maskScriptEnvValues(errorMessage, scriptEnv)
  }

  if (failureCode !== null) {
    await setNodeRunStatus({
      db,
      nodeRunId: a.nodeRunId,
      to: 'failed',
      allowedFrom: ['running'],
      reason: failureCode,
      extra: {
        finishedAt: Date.now(),
        exitCode: outcome.result.exitCode,
        errorMessage,
        failureCode,
      },
    })
    broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'failed')
    return {
      kind: 'failed',
      summary: errorMessage ?? `script exited ${String(outcome.result.exitCode)}`,
      message: failureCode,
    }
  }

  for (const [portName, content] of Object.entries(ports)) {
    // RFC-306: a script closes a branch the same way an agent does; the flag has
    // to reach the row or the marker is decoration.
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: a.nodeRunId, portName, content, active: !inactivePorts.has(portName) })
  }
  // RFC-276 regression fix: a readonly script's iso is discarded without a
  // merge-back, but its 'isolating' stamp must still SETTLE — deriveFrontier's
  // D15 gate only completes done rows whose merge_state is settled, so a
  // done+isolating row wedges the scope forever ("scheduler stalled / no ready
  // nodes in scope"; pre-RFC-276 readonly scripts ran in place and stayed NULL).
  // Settled BEFORE the done write so no done+unsettled state is ever observable.
  if (a.isReadonly && a.isoHandle !== null && !a.isoHandle.passthrough) {
    await transitionMergeState({
      db,
      nodeRunId: a.nodeRunId,
      event: { kind: 'discard-readonly' },
    })
  }
  await setNodeRunStatus({
    db,
    nodeRunId: a.nodeRunId,
    to: 'done',
    allowedFrom: ['running'],
    reason: 'script-done',
    extra: { finishedAt: Date.now(), exitCode: outcome.result.exitCode },
  })
  broadcastNodeStatus(taskId, a.nodeRunId, a.node.id, 'done')
  return { kind: 'done' }
}

// -----------------------------------------------------------------------------
// RFC-306 — branch judgment + skip row (design §6.2)
// -----------------------------------------------------------------------------

/**
 * Decide whether `node` runs this iteration. Returns `null` to proceed with the
 * ordinary dispatch, or a settled OneNodeResult when the node was skipped.
 *
 * Three details are load-bearing:
 *
 *  1. **Provenance.** The skipped row stores the same `consumed_upstream_runs_json`
 *     an executed row would. That is what lets `isNodeRunFresh` mark the skip
 *     stale once an upstream re-runs, so retrying the deciding node re-opens the
 *     branch (D10 / AC-10). Without it the frontier would re-dispatch the node on
 *     every tick forever — the skip would look like it is "flapping".
 *
 *  2. **Mint pending → mark-skipped**, not a direct `skipped` mint: `skipped` is
 *     not in MintableNodeRunStatus, and the lifecycle table already owns the
 *     `pending → skipped` edge. A crash between the two writes leaves a pending
 *     row, which the orphan reaper flips to `interrupted` and the next pass
 *     re-judges — self-healing, no wedged state.
 *
 *  3. **`force_activated` is read from the LATEST row at this (node, iteration)**
 *     — retryNode stamps it on the placeholder it mints, and this is the read
 *     that turns "run anyway" into an actual run (§10).
 */
async function judgeBranchActivation(
  state: SchedulerState,
  node: WorkflowNode,
  iteration: number,
): Promise<OneNodeResult | null> {
  const { db, taskId, definition, log } = state
  // Fast path: a node with NO inbound dependency at all can never be branched
  // away (graph roots included), so a workflow that uses no branch ports pays
  // zero extra queries per dispatch — "existing behavior is unchanged" has to
  // hold for cost as well as for outcome.
  //
  // The implicit refs are part of this test, not just of the judgment below:
  // review and output nodes carry their dependency in `inputSource` /
  // `ports[].bind` and often have no edge at all, so an edges-only fast path
  // would return early for exactly the two kinds design-gate P1#2 is about.
  const hasInbound =
    collectDataflowInboundEdges(definition.edges, node.id, nodeKindIndex(definition)).length > 0 ||
    collectImplicitInboundRefs(node as { kind: string; inputSource?: unknown; ports?: unknown })
      .length > 0
  if (!hasInbound) return null
  const existing = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
  const latest = pickFreshestRun(existing, { topLevelOnly: true })
  const forceActivated = latest?.forceActivated === true

  const decision = await resolveNodeActivationForDispatch({
    db,
    taskId,
    definition,
    node,
    iteration,
    parents: state.containerOf,
    ...(forceActivated ? { forceActivated: true } : {}),
  })
  if (decision.activation.kind === 'active') return null

  const consumedJson = JSON.stringify(decision.consumed)
  // Design-gate P1#8 — a skip must SETTLE the node's current anchor, not park a
  // terminal sibling next to it. Two anchors matter:
  //
  //   pending      — minted out of band by a clarify answer / review iterate.
  //                  Leaving it behind means the row resolver later reuses it and
  //                  runs the node against the very branch decision that closed
  //                  it, and (because that row is OLDER than the skip row) the
  //                  skip stays "latest" and the scope can stall. Reuse it.
  //   awaiting_*   — a parked human gate. Leaving it behind keeps an actionable
  //                  item in the review inbox for a branch nobody will run.
  //                  Supersede it, then record the skip.
  //
  // Anything else (done / failed / interrupted / canceled / absent) is a settled
  // generation; the skip is a NEW generation on top of it, so it mints normally.
  let nodeRunId: string
  if (latest?.status === 'pending') {
    nodeRunId = latest.id
    await db
      .update(nodeRuns)
      .set({ consumedUpstreamRunsJson: consumedJson })
      .where(eq(nodeRuns.id, nodeRunId))
    await transitionNodeRunStatus({
      db,
      nodeRunId,
      event: { kind: 'mark-skipped', reason: decision.activation.reason },
      extra: { finishedAt: Date.now() },
    })
  } else {
    if (latest?.status === 'awaiting_review' || latest?.status === 'awaiting_human') {
      await transitionNodeRunStatus({
        db,
        nodeRunId: latest.id,
        event: { kind: 'cancel-by-supersede', reason: 'branch-skipped' },
        extra: { finishedAt: Date.now() },
      })
      broadcastNodeStatus(taskId, latest.id, node.id, 'canceled')
    }
    nodeRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'branch-skip',
      iteration,
      overrides: { consumedUpstreamRunsJson: consumedJson },
    })
    await transitionNodeRunStatus({
      db,
      nodeRunId,
      event: { kind: 'mark-skipped', reason: decision.activation.reason },
      extra: { finishedAt: Date.now() },
    })
  }
  broadcastNodeStatus(taskId, nodeRunId, node.id, 'skipped')
  log.info('node skipped — inbound branch inactive', {
    nodeId: node.id,
    iteration,
    reason: decision.activation.reason,
    inactiveFrom: decision.edges
      .filter((e) => e.activation.kind === 'inactive')
      .map((e) => `${e.sourceNodeId}.${e.sourcePortName}`),
  })
  return { kind: 'ok', summary: '', message: 'branch-skipped' }
}

async function runOneNode(state: SchedulerState, args: OneNodeArgs): Promise<OneNodeResult> {
  const { db, task, taskId, definition, opts, inputsMap, agentSem, writeSem, log } = state
  const { node, iteration } = args

  if (opts.signal?.aborted === true) {
    return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
  }

  // ---------------------------------------------------------------------------
  // RFC-306 — branch judgment. FIRST thing after the abort check, so it applies
  // uniformly to every dispatchable kind (agent / script / wrapper / call /
  // review / output). Placing it per-kind would guarantee the next new kind
  // silently runs on a closed branch.
  //
  // NOT applied to the settles-without-row family (clarify / cross-clarify):
  // deriveFrontier settles those by derivation and they own no row, so minting
  // one here would break the C1/N6 contract. Their visual "greyed out" state
  // comes from the trace query, which derives it the same way.
  // ---------------------------------------------------------------------------
  if (!SETTLES_WITHOUT_ROW_KINDS.has(node.kind)) {
    const branch = await judgeBranchActivation(state, node, iteration)
    if (branch !== null) return branch
  }

  if (node.kind === 'output') {
    // Output nodes are display-only sinks: no subprocess, no envelope. The
    // node's declared `ports[]` bindings resolve to upstream (nodeId, portName)
    // pairs (the canonical form, mirroring wrapper-loop's outputBindings; see
    // workflow.validator.ts §output binding validation). We mint a virtual
    // `done` node_run and snapshot each bound port's content into
    // node_run_outputs so the detail page reads outputs uniformly and
    // lifecycle invariant T3 (task done ⟹ every output node has a done run)
    // is satisfied.
    const bindings = readBindings(node, 'ports')
    const projected: Array<{
      binding: Binding
      row: Awaited<ReturnType<typeof readPortRowAtIteration>>
    }> = []
    const consumed: Record<string, string> = {}
    for (const b of bindings) {
      const resolved = resolveWorkflowSourceRef(definition, b.bind, node.id, state.containerOf)
      if (!resolved.ok) {
        return {
          kind: 'failed',
          summary: `output node ${node.id}: source '${b.bind.nodeId}.${b.bind.portName}' is not exposed by wrapper '${resolved.wrapperId}'`,
          message: 'wrapper-output-boundary-missing',
        }
      }
      // RFC-193 D16: copy kind + archive reference with the content — an
      // output node is pure projection, its row must stay artifact-readable.
      const row = await readPortRowAtIteration(
        db,
        taskId,
        resolved.source.nodeId,
        resolved.source.portName,
        iteration,
      )
      if (row.runId !== null) consumed[resolved.source.nodeId] = row.runId
      projected.push({ binding: b, row })
    }
    const nrId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'done',
      cause: 'io-virtual',
      iteration,
      overrides: { consumedUpstreamRunsJson: JSON.stringify(consumed) },
    })
    for (const { binding, row } of projected) {
      await db.insert(nodeRunOutputs).values({
        nodeRunId: nrId,
        portName: binding.name,
        content: row.content,
        kind: row.kind,
        archiveJson: row.archiveJson,
        // RFC-306: an output node is pure projection, and that includes the
        // branch state. With joinMode 'any' the node itself can be active while
        // ONE of its bound sources sits on a closed branch — that port then
        // renders as "not produced" instead of as a genuine empty result.
        active: row.active,
      })
    }
    broadcastNodeStatus(taskId, nrId, node.id, 'done')
    return { kind: 'ok', summary: '', message: '' }
  }

  if (node.kind === 'wrapper-git') {
    return runWrapperNode(state, args, runGitWrapperNode)
  }
  if (node.kind === 'wrapper-loop') {
    return runWrapperNode(state, args, runLoopWrapperNode)
  }
  if (node.kind === 'wrapper-fanout') {
    return runWrapperNode(state, args, runFanoutWrapperNode)
  }

  if (node.kind === 'review') {
    // RFC-005: review node dispatch. Reads upstream port, archives current
    // version to doc_versions (file + DB row), parks the node in
    // status=awaiting_review. The review service module owns the lifecycle;
    // scheduler only routes here so dispatch stays per-kind.
    return dispatchReviewNode({
      db,
      taskId,
      appHome: opts.appHome,
      definition,
      node,
      iteration,
      // RFC-193 D9: the review's fallback read root is THIS scope's canonical
      // (wrapper-canonical inside git/loop) — task.worktreePath was the
      // wrapper-review deadlock.
      scopeRoot: state.scopeRoot,
      repoDirName: state.repos[0]?.worktreeDirName ?? '',
    })
  }

  if (node.kind === 'clarify') {
    // RFC-023: clarify nodes are not actively scheduled — they're activated
    // by the runner when the asking agent emits <workflow-clarify>. If the
    // scheduler reaches a clarify node directly (as part of its dataflow
    // graph), it is a no-op pass: ready signals from upstream agents are
    // routed through createClarifyRound(kind='self') instead. Mark this graph-level
    // visit done so downstream nodes (typically the answers→agent edge
    // marking the clarify node "complete" in the canvas) can proceed once a
    // session is closed.
    return { kind: 'ok', summary: '', message: '' }
  }

  if (node.kind === 'clarify-cross-agent') {
    // RFC-056: cross-clarify nodes are activated by the questioner emitting
    // <workflow-clarify> — the runner forwards into createClarifyRound(kind='cross')
    // which mints a fresh node_run row and parks it at 'awaiting_human'. The
    // scheduler should NOT eagerly insert a pending row on every scan; doing
    // so accumulates orphan pending rows (one per scheduler tick, the user
    // saw 21 pile up on a parked task) because nothing consumes them — the
    // runner path always inserts its OWN row via createClarifyRound(kind='cross')
    // rather than upgrading whatever the scheduler pre-baked.
    //
    // Two legitimate scheduler responsibilities remain:
    //   1. Persistent-stop short-circuit: if this node has a prior
    //      directive='stop' session, mark a fresh done row so cascade
    //      reruns of the cross-clarify branch can advance past it without
    //      parking awaiting_human.
    //   2. Missing-questioner runtime defense: validator should catch
    //      this earlier, but if the workflow snapshot has no questioner
    //      wired, fail explicitly.
    //
    // For the common case (no stop, has questioner), do NOTHING — the
    // runner will create the node_run when the questioner emits clarify.
    // If a live row already exists (pending or awaiting_human) from a
    // prior runner-side creation, also do nothing — idempotency guard.
    const liveRows = await db
      .select({ status: nodeRuns.status })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, node.id),
          eq(nodeRuns.iteration, iteration),
        ),
      )
    const hasLive = liveRows.some((r) => r.status === 'pending' || r.status === 'awaiting_human')
    if (hasLive) {
      return { kind: 'ok', summary: '', message: 'cross-clarify-live-row-exists' }
    }
    // Validator runtime defense: a node without a questioner means the
    // workflow is malformed — fail and let the user see it in the UI.
    if (findQuestionerNodeForCrossClarify(definition, node.id) === undefined) {
      const failId = await mintNodeRun(db, {
        taskId,
        nodeId: node.id,
        status: 'pending',
        cause: 'cross-clarify-guard',
        iteration,
      })
      await setNodeRunStatus({
        db,
        nodeRunId: failId,
        to: 'failed',
        allowedFrom: ['pending'],
        reason: 'cross-clarify-input-source-missing-at-runtime',
        extra: { finishedAt: Date.now() },
      })
      return {
        kind: 'failed',
        summary: `cross-clarify node ${node.id} has no questioner input`,
        message: 'cross-clarify-input-source-missing-at-runtime',
      }
    }
    // Persistent-stop check: if the questioner node's node-level clarify directive is
    // 'stop', mint a done row immediately so the workflow advances past this point
    // without parking awaiting_human.
    // RFC-132 T7: the questioner node's directive (task_node_clarify_directives) is the
    // single source of truth (answer-stop + canvas toggle both write it; node
    // last-write-wins subsumes the RFC-123 recency gate). The questioner is guaranteed
    // to exist here (the missing-questioner guard above already failed the node), so the
    // fallback is defensive only.
    const reenableQuestionerNodeId = findQuestionerNodeForCrossClarify(definition, node.id)
    const stopped = reenableQuestionerNodeId
      ? await resolveCrossNodeStopped(db, taskId, reenableQuestionerNodeId)
      : false
    if (stopped) {
      const stopRunId = await mintNodeRun(db, {
        taskId,
        nodeId: node.id,
        status: 'pending',
        cause: 'cross-clarify-guard',
        iteration,
      })
      // RFC-217 T9: the pending→done short-circuit transition (+ its reason
      // string) is owned by the clarify service — single dispatch policy.
      const dispatched = await dispatchCrossClarifyNode({
        db,
        taskId,
        crossClarifyNodeId: node.id,
        nodeRunId: stopRunId,
        definition,
      })
      // Codex impl-gate P2-3: honor the helper's verdict. A user flipping the
      // questioner's directive stop→continue between the outer read and the
      // helper's re-read leaves the fresh row PENDING ('awaiting') — reporting
      // completion then would let clients disagree with persisted state and
      // strand the pending row. Retire the speculative mint and fall through
      // to the common awaiting path (the runner mints its own row on emit).
      if (dispatched.kind !== 'short-circuit-stop') {
        await setNodeRunStatus({
          db,
          nodeRunId: stopRunId,
          to: 'canceled',
          allowedFrom: ['pending'],
          reason: 'cross-clarify-stop-race',
          extra: { finishedAt: Date.now() },
        })
        return { kind: 'ok', summary: '', message: 'cross-clarify-stop-race' }
      }
      broadcastNodeStatus(taskId, stopRunId, node.id, 'done')
      return { kind: 'ok', summary: '', message: 'cross-clarify-persistent-stop' }
    }
    // Common path: no live row, no persistent stop, questioner valid. Don't
    // pre-create — the runner's createClarifyRound(kind='cross') will create a row
    // when the questioner emits <workflow-clarify>. Return ok so the
    // dispatcher marks this node "scheduled for this pass"; the lifecycle
    // hand-off to awaiting_human happens later via the runner path.
    return { kind: 'ok', summary: '', message: '' }
  }

  if (node.kind === 'input') {
    const inputKey = pickString(node, 'inputKey')
    if (inputKey === null) {
      return {
        kind: 'failed',
        summary: `input node ${node.id} missing inputKey`,
        message: 'invalid',
      }
    }
    const value = inputsMap[inputKey] ?? ''
    const nrId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'done',
      cause: 'io-virtual',
      iteration,
    })
    // RFC-004: an input node's single output port is named after its inputKey,
    // so edges authored on the canvas (whose source.portName defaults to the
    // visible handle label = inputKey) actually resolve. Previously hardcoded
    // to 'out', which mismatched every workflow created through the editor.
    await db.insert(nodeRunOutputs).values({ nodeRunId: nrId, portName: inputKey, content: value })
    broadcastNodeStatus(taskId, nrId, node.id, 'done')
    return { kind: 'ok', summary: '', message: '' }
  }

  // RFC-146: exhaustiveness guard. Every kind above returned inside its own
  // branch; only agent-single may fall through into the agent dispatch path
  // below. A NodeKind admitted by the behavior table but not yet given a
  // runOneNode branch fails loud here instead of being silently driven as an
  // agent. (Dispatch stays an if-chain by design — the handlers close over
  // SchedulerState; see RFC-146 design D2.)
  // RFC-243: call nodes — an independent child task behind an agent-shaped
  // node. Deliberately BEFORE the agent fall-through guard; never acquires
  // a node-pool slot (design §6.1 — the child's own nodes compete for it).
  if (node.kind === 'call-workflow' || node.kind === 'call-workgroup') {
    return await runCallWorkflowNode(state, args)
  }
  // RFC-253 — script node: a real subprocess, no model. Deliberately BEFORE the
  // agent fall-through guard, same as the call kinds.
  if (node.kind === 'script') {
    return await runScriptNode(state, args)
  }
  // RFC-269 — code-host call: one outbound HTTP request, no model, no
  // subprocess. Same position as the script/call kinds: before the agent
  // fall-through guard.
  if (node.kind === 'code-host-call') {
    return await runCodeHostCallNode(state, args)
  }
  // RFC-310 PR-10 T104 — code-round 执行链已删除。历史 interrupted round 任务
  // 在 daemon 重启 resume 时走到这里：typed failed（可在任务页看到原因），
  // 不 crash 调度器。
  if (node.kind === 'code-round') {
    return {
      kind: 'failed',
      summary: 'code-round execution was retired by RFC-310; use development missions',
      message: 'code-round-retired',
    }
  }
  if (node.kind !== 'agent-single') {
    return {
      kind: 'failed',
      summary: `runOneNode has no dispatch branch for node kind ${node.kind}`,
      message: 'unhandled-node-kind',
    }
  }

  // RFC-271 T6d：解析走统一 resolver（services/ref/runtimeRef.ts），但**两个错误码
  // 与归属逐字不变**——主派发是节点级失败，与 fanout hydration 的静默跳过不同。
  const agentIdRef = pickString(node, 'agentId')
  const agentName = pickString(node, 'agentName') ?? agentIdRef ?? node.id
  const resolvedAgent = await resolveNodeAgentRef(db, node, DISPATCH_CALL_POLICY)
  if (!resolvedAgent.ok && resolvedAgent.reason === 'missing') {
    return {
      kind: 'failed',
      summary: `node ${node.id} missing canonical agentId`,
      message: 'agent-identity-missing',
    }
  }
  if (!resolvedAgent.ok) {
    return { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
  }
  // RFC-223 (T15): persisted workflow identity is the frozen id. A name-only
  // node is corrupt/quarantined data and was rejected above.
  const nodeAgent = resolvedAgent.value
  // RFC-132 ③ (借壳收官): the borrow ledgers are move-semantics (RFC-131 T4) and the immediate
  // ledger is deleted, so resolveBorrowForNode never returns an agent anymore — its remaining
  // job is the multi-ledger duplicate-execution REJECT (designer + dispatched self/q both open
  // on this home). Keep the call for that reject; the node always runs its OWN agent.
  // ConflictError surfaces as a node-level failure (don't reject the scope tick — runTask would
  // fail the WHOLE task).
  try {
    await resolveBorrowForNode(db, taskId, node.id, iteration, definition)
  } catch (err) {
    if (err instanceof ConflictError) {
      return { kind: 'failed', summary: err.message, message: err.code }
    }
    throw err
  }
  const agent = nodeAgent

  // RFC-060 PR-E: agent-multi NodeKind was removed in favor of wrapper-fanout.
  // The agent-single path below is now the sole agent dispatch path.
  // RFC-074: resolveUpstreamInputs now also returns the provenance map of which
  // upstream run each input was read from; recorded on every row this dispatch
  // mints/reuses so read-time freshness can later tell if an upstream advanced.
  const { inputs: upstreamInputs, consumed: consumedUpstream } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
    definition,
    state.containerOf,
  )
  const consumedUpstreamJson = JSON.stringify(consumedUpstream)
  // RFC-022: expand the agent.dependsOn closure before resolving skills so
  // closure-member skills get unioned into the same OPENCODE_CONFIG_DIR
  // staging dir. A cycle / missing-dep here is fatal — the agent.ts save
  // guard normally prevents it; hitting one at runtime implies an external
  // SQL edit or a race against another writer. Fail loudly instead of
  // silently spawning with a broken closure.
  const injection = await resolveInjection(db, agent, { appHome: opts.appHome, log })
  if (injection.kind === 'failed') return injection
  const { dependents, skills: resolvedSkills, mcps, plugins } = injection.spec
  const promptTemplate = pickString(node, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = opts.defaultPerNodeTimeoutMs
  // RFC-042: retries default to 3 so recoverable failure modes (in particular
  // the model forgetting to emit a `<workflow-output>` / `<workflow-clarify>`
  // envelope after a long tool-using session) get a chance to recover via
  // same-session follow-up before the task is failed. RFC-115: the per-node
  // `retries` override is removed — the budget is the global
  // config.defaultNodeRetries (shared default only for mock/unwired callers).
  //
  // RFC-313: 预算从一个数变成两个维度——`followupBudget` 是「同一个会话内还能追问
  // 几次」，`restartBudget` 是「这个会话被判定为无可救药后还能整体换几次干净会话」。
  // `maxRetries` 由二者的乘积公式导出，且是 attempt 数量的**唯一权威**：两个预算
  // 决定的是每次重试长什么形状（见 decideFollowupForRetry），不是还能不能再来一次。
  // restartBudget=0 时 retryAttemptCap 退化成 1+followupBudget，逐字等于 RFC-313 前。
  const followupBudget = opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
  const restartBudget = opts.sessionRestartBudget ?? DEFAULT_SESSION_RESTART_BUDGET
  const maxRetries = retryAttemptCap(followupBudget, restartBudget) - 1

  // RFC-005: when this node is being re-run because a downstream review node
  // was rejected/iterated, surface the rendered comments / rejection reason
  // through the {{__review_comments__}} / {{__review_rejection__}} tokens.
  // Returns undefined for first runs and for runs whose latest downstream
  // decision is approve/pending — see buildReviewPromptContext.
  const reviewContext = await buildReviewPromptContext(db, opts.appHome, node.id, taskId, iteration)
  // RFC-023: when this node has a clarify channel wired AND a clarify_iteration
  // > 0, surface the last-round Q&A through {{__clarify_*}} tokens / auto-
  // appended sections. The protocol block is appended by the runner when
  // hasClarifyChannel is true, regardless of whether there's prior context
  // (the agent needs to know it MAY ask back even on the first round).
  const hasClarifyChannel = agentHasClarifyChannel(definition, node.id)
  // RFC-056: the questioner's __clarify__ port may be wired into a
  // clarify-cross-agent node instead of (or as well as) a RFC-023 clarify
  // node. When at least one cross-clarify target exists we instruct the
  // runner to disable the 5-question cap on the envelope parser.
  // RFC-165: renamed from `clarifyMode` — that name now belongs to the clarify
  // NODE field ('optional'); this local is the channel wiring FAMILY.
  const channelKind: 'self' | 'cross' =
    findCrossClarifyNodeForQuestioner(definition, node.id) !== undefined ? 'cross' : 'self'
  // RFC-132 (PR-C): the designer's External Feedback is no longer a separate context — its questions
  // ride the unified flat clarify queue (buildClarifyQueueContext), which selects by effective target
  // regardless of the `__external_feedback__` topology, so the scheduler needs no external-feedback
  // topology gate here anymore.

  // Pick up an existing pending node_run at this iteration; otherwise create
  // a fresh run with retry_index = max-existing-in-iter + 1 (or 0).
  const sameNodeIterRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
    .orderBy(asc(nodeRuns.startedAt))
  // RFC-287 T8：取行前奏收编到 `resolveSchedulerRunRow`（四线单一实现）。
  // RFC-074 PR-C: no clarifyIteration inheritance — freshness is pure id-order
  // and the clarify generation is derived from prior-done id-order at dispatch
  // time. A process retry's External Feedback / Prior Output / questioner Q&A
  // context all key off id-order / the RFC-070 consumed-by stamps, so nothing
  // needs to be carried forward on the row.
  const resolvedRow = await resolveSchedulerRunRow({
    db,
    taskId,
    nodeId: node.id,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastPending: (id) => broadcastNodeStatus(taskId, id, node.id, 'pending'),
  })
  let nodeRunId = resolvedRow.nodeRunId
  const retryIndex = resolvedRow.retryIndex
  const latestExisting = resolvedRow.latestExisting
  const inheritedReviewIteration = latestExisting?.reviewIteration ?? 0
  const inheritedShardKey = latestExisting?.shardKey ?? null
  const inheritedParentNodeRunId = latestExisting?.parentNodeRunId ?? null
  let envelopeNonce = await loadRunEnvelopeNonce(db, nodeRunId)

  // Lock order: writeSem ≺ (agentSem | scriptSem) ≺ subprocessSem (no cycles —
  // RFC-098 survey §wp5-4). RFC-266 split the old single `globalSem` into two
  // independent pools; an executor takes exactly ONE of them and never both, so
  // the split adds no new ordering edge. RFC-130 §7 SUPERSEDED the RFC-098 B1
  // "writer acquires writeSem before its global slot" model (which existed to
  // stop queued writers starving readers): there is no whole-run write lock now
  // — each node runs in its OWN isolated worktree, so writeSem is held only for
  // the brief snapshot-at-dispatch (§段①) + merge-back (§段③), never across the
  // multi-minute agent run. The pool slot is the real DAG-parallelism cap now
  // (writeSem + pool are never held together — §7.2 deadlock analysis; the merge
  // agent bypasses the pool to avoid a cycle).
  // §段①: snapshot canonical worktree(s) + branch an isolated worktree under a
  // brief writeSem window. On failure release the slot and fail the node (the
  // canonical worktree is never touched, so nothing to roll back).
  // The iso path + refs are keyed by the ORIGINAL nodeRunId (`isoKeyRunId`) — it
  // stays stable across the internal retry loop (which mints fresh node_run rows),
  // so a same-session follow-up keeps the exact same iso worktree (D17).
  const isoKeyRunId = nodeRunId
  let isoHandle: IsoHandle

  let lastResult: RunResult | null = null
  let lastError: string | null = null
  // RFC-122 (same-session follow-up fix): the PRIOR attempt's
  // effectiveHasClarifyChannel. A same-session envelope follow-up re-anchors the
  // agent on "the format previously specified in this session"; that is only
  // valid when this attempt runs in the SAME mode (clarify vs output) as the
  // prior one. A per-attempt STOP-toggle flip can switch the mode mid-loop (e.g.
  // attempt 0 clarify-only → attempt 1 output), and the prior session never
  // emitted the now-needed protocol. When the mode flips we bypass the follow-up
  // and rebuild the FULL renderUserPrompt instead. Seeded false (attempt 0 never
  // follows up). Within a retry loop only nodeStopOverride varies per attempt, so
  // a flip ⟺ a toggle change ⇒ golden-lock: no toggle ⇒ never flips.
  let priorAttemptClarifyActive = false

  // RFC-287 T7：本线迁入装配骨架（**模式 B**——一次许可 + 一棵 iso 贯穿全部 attempt，
  // 窗口内由 retryPolicy 驱动多次 spawn；D17 要求同会话续跑必须落在同一棵树上）。
  //
  // **拆分手术**：窗口只到「合并相位收束」为止，clarify 落库那段收尾**留在窗口外**。
  // 现状顺序是「先释放许可 + 按 keep 清理 iso，再建 clarify 轮次」；把收尾挪进窗口
  // 会让 daemon 级 agent 许可多握住一段 DB 写——那是行为变更，不是重构。故 TResult
  // 取判别式：窗口内已定局的直接回传，需要窗口外收尾的回 `{ kind: 'ran' }`。
  type AgentWindowOut =
    | { kind: 'settled'; out: OneNodeResult }
    | { kind: 'ran'; result: RunResult | null }
  // keepIf 里算出的 RFC-042 续跑决策 memo。骨架保证每轮重试的调用序是
  // keepIf →〔换树〕→ onNextAttempt → spawn（rfc287-t2 骨架单测钉死），所以
  // onNextAttempt / spawn 读到的一定是本轮的决策。
  let followupDecision: EnvelopeFollowupDecision = { followup: false }
  let followupResumeSessionId: string | undefined
  // RFC-313: 重试形状的跨 attempt 状态（只在本次 dispatch 的闭包内有意义，不持久化
  // ——daemon 重启 / 人工 retryNode 都会重新进入执行器并从零开始，与既有 attempt
  // 计数语义一致）。`pendingRestartReason` 只有 `decideFollowupForRetry` 一个写者
  // （每轮先复位再按形状赋值），spawn 侧只读——于是「上一轮的告知漏进这一轮」这个
  // 窗口从结构上就不存在。
  let retryShapeState: RetryShapeState = { followupChainLen: 0, restartsUsed: 0 }
  let pendingRestartReason: EnvelopeFollowupReason | undefined
  // RFC-313 实现门 P1-1：上一次 attempt 观察到的 STOP 开关值（undefined = 还没有过
  // attempt）。用它在 keepIf 里判断「本轮有没有待处理的模式翻转」——依据是紧邻上面
  // 那条既有不变量：**retry 循环内只有 nodeStopOverride 逐 attempt 变化，所以
  // 「翻转」⟺「开关变了」**。因此这里不是把 effectiveHasClarifyChannel 再导一遍
  // （那会是第二处导出、必然漂移），而是复用同一个 `getNodeClarifyDirectiveRow` 源。
  let priorAttemptStopOverride: boolean | undefined

  /**
   * 每次重试前奏：算 RFC-042 续跑决策。它同时**就是**「要不要留用同一棵树」的判据
   * ——续跑必须在同一棵树上恢复（D17），换新会话则丢弃重建。
   */
  const decideFollowupForRetry = async (prev: RunResult | null): Promise<boolean> => {
    followupDecision = { followup: false }
    followupResumeSessionId = undefined
    // 本函数是 pendingRestartReason 的唯一写者：每轮先复位，再按形状赋值，
    // 这样 spawn 侧只读不清，也就不存在「上一轮的告知漏进这一轮」的窗口。
    pendingRestartReason = undefined
    if (prev !== null) {
      // RFC-313 实现门 P1-2：**框架自写的审计事件也是 kind='text'**（rfc042 续跑、
      // rfc049 端口校验、rfc313 会话升级三处，都写在**新铸的那一行**上），所以不过滤
      // 的话第 1 次之后每一次 attempt 的计数恒 ≥1 —— RFC-042 那条「模型必须说过话」
      // 的判据在第 2 次起就失效了（这是 RFC-042 就有的缺陷，RFC-313 只是多加了一个
      // producer；按用户拍板在本 RFC 内一并修，因为整条形状判定正架在这个判据上）。
      // 排除判据是载荷前缀：框架审计载荷一律以 `[rfc` 开头，由 rfc313-source-locks
      // 的断言钉死。误伤面是保守的——万一模型的正文真以 `[rfc` 开头，结果只是这一轮
      // 退回 fresh（换会话重来），不会错误地续跑一个没说过话的会话。
      const agentTextCount = await countAgentTextEvents(db, nodeRunId)
      // RFC-049: read the structured port-validation failures the prior
      // attempt's runner persisted (NULL → undefined; malformed JSON →
      // null via parsePortValidationFailuresJson, then coerced to
      // undefined for the decision input). decideEnvelopeFollowup uses
      // the failures array to populate the per-port repair prompt; absent
      // / empty arrays degrade gracefully (followup still fires on the
      // outer prefix, but the prompt skips per-kind specifics).
      const priorRunRow = (
        await db
          .select({ pvf: nodeRuns.portValidationFailuresJson })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, nodeRunId))
          .limit(1)
      )[0]
      const priorFailures = parsePortValidationFailuresJson(priorRunRow?.pvf ?? null)
      followupDecision = decideEnvelopeFollowup({
        status: prev.status,
        exitCode: prev.exitCode,
        failureCode: prev.failureCode ?? null,
        sessionId: prev.sessionId ?? null,
        agentTextCount,
        ...(priorFailures !== null ? { portValidationFailures: priorFailures } : {}),
      })
      // RFC-313: RFC-042 的五条判据（上一行）只回答「这次失败可不可以在同一个会话里
      // 改」；能改**不代表还应该继续在这个会话里改**——上下文已经打满 / 模型陷在
      // 循环里时，追问是零收益甚至负收益的自旋（每条纠错提示还在加剧根因）。形状由
      // 共享纯函数在判据之上再判一层：链未触顶 → 接续；触顶且有升级预算 → 主动换
      // 一个干净会话重来；判据落空 → 维持既有的全新会话重试（不吃升级预算）。
      // RFC-313 实现门 P1-1：升级会丢树 + 扣预算，而一次待处理的 STOP 翻转按 RFC-122
      // 应当「保树 + 走完整 prompt」。keepIf 跑在 spawn 之前，若不在这里看一眼开关，
      // 链顶恰逢翻转时升级会抢先生效，把用户的正常翻转执行成升级（AC-8 违反 + 未合并
      // 成果丢失）。只读这一个值、只在挂了 clarify 通道时读。
      const stopOverrideNow = hasClarifyChannel
        ? (await getNodeClarifyDirectiveRow(db, taskId, node.id))?.directive === 'stop'
        : false
      const clarifyFlipPending =
        priorAttemptStopOverride !== undefined && stopOverrideNow !== priorAttemptStopOverride
      const { shape, next } = decideRetryShape({
        followup: followupDecision,
        state: retryShapeState,
        followupBudget,
        restartBudget,
        ...(clarifyFlipPending ? { suppressRestart: true } : {}),
      })
      retryShapeState = next
      if (shape.kind === 'followup') {
        followupResumeSessionId = prev.sessionId ?? undefined
      } else {
        // 升级 / 全新会话都不发短提示：把 RFC-042 的决策收回，后续所有「followup
        // 才做」的动作（抄 envelopeNonce、带 resumeSessionId、跳过记忆注入与清单）
        // 因此自动不做——这正是本 RFC 改动面极小的原因。
        followupDecision = { followup: false }
        pendingRestartReason = shape.kind === 'restart' ? shape.reason : undefined
      }
    }
    // 续跑 ⇒ 留用同一棵树（D17）；换新会话（升级或崩溃后重来）⇒ 骨架负责丢弃 + 重建。
    return followupDecision.followup
  }

  /**
   * 每次重试的副作用（骨架在「iso 处置之后、spawn 之前」调用）：铸新行、把 iso 列
   * 抄到新行、广播、写审计事件。`attempt` 是绝对序号（retryIndex + 骨架轮次）。
   */
  const prepareRetryAttempt = async (attempt: number): Promise<void> => {
    {
      {
        // RFC-074 PR-C: a process-retry within the same clarify round surfaces
        // the answered Q&A via id-order generation derivation + the RFC-070
        // consumed-by stamps, not a carried clarifyIteration. shardKey /
        // parentNodeRunId still belong to this run-of-the-node and persist.
        nodeRunId = await mintNodeRun(db, {
          taskId,
          nodeId: node.id,
          status: 'pending',
          cause: 'process-retry',
          retryIndex: attempt,
          iteration,
          overrides: {
            reviewIteration: inheritedReviewIteration,
            shardKey: inheritedShardKey,
            parentNodeRunId: inheritedParentNodeRunId,
            consumedUpstreamRunsJson: consumedUpstreamJson,
            ...(followupDecision.followup && envelopeNonce.length > 0 ? { envelopeNonce } : {}),
          },
        })
        envelopeNonce = await loadRunEnvelopeNonce(db, nodeRunId)
        broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')
        // RFC-130: carry the iso columns onto the freshly-minted retry row so a
        // crash mid-retry can still find the iso worktree (the physical iso is
        // keyed by isoKeyRunId and shared across the invocation's attempts).
        await persistIsoBase(db, nodeRunId, task.repoCount, isoHandle)

        // RFC-042 / RFC-049: surface the follow-up decision as an audit
        // event so operators can replay how a green run recovered from a
        // failed prior attempt. Written on the FRESH row (so it sits in the
        // events list for the attempt that's about to run, not the failed
        // prior attempt). reason='port-validation' uses its own tag /
        // payload shape (RFC-049 §A6) so log aggregators can filter the
        // two failure classes apart.
        if (followupDecision.followup) {
          if (followupDecision.reason === 'port-validation') {
            // One audit row per failing port — keeps the payload symmetric
            // with how runner.ts persists multiple failures in the JSON
            // column (today fail-fast → always length 1, but the schema is
            // ready for the future batch-validate path).
            const failures =
              followupDecision.failures.length > 0
                ? followupDecision.failures
                : [{ port: '', kind: '', subReason: '' }]
            for (const f of failures) {
              await db.insert(nodeRunEvents).values({
                nodeRunId,
                ts: Date.now(),
                kind: 'text',
                payload: `[rfc049/port-validation-followup] ${JSON.stringify({
                  rfc: 'RFC-049',
                  port: f.port,
                  kind: f.kind,
                  subReason: f.subReason,
                  retryAttempt: attempt,
                })}`,
              })
            }
          } else {
            await db.insert(nodeRunEvents).values({
              nodeRunId,
              ts: Date.now(),
              kind: 'text',
              payload: `[rfc042/envelope-followup] ${JSON.stringify({
                rfc: 'RFC-042',
                reason: followupDecision.reason,
                retryAttempt: attempt,
              })}`,
            })
          }
        }

        // RFC-313: 主动会话升级的审计行。写在**新铸的那一行**上（与 rfc042 的续跑
        // 事件同址同形），于是任务详情页的事件流里，「接续」与「换脑重来」是两条可
        // 区分的痕迹——用户拍板不新增 rerun cause，事件流就是唯一的区分面。
        // 与上面的 followup 分支互斥：升级时 followupDecision 已被收回成 false。
        if (pendingRestartReason !== undefined) {
          await db.insert(nodeRunEvents).values({
            nodeRunId,
            ts: Date.now(),
            kind: 'text',
            payload: `[rfc313/session-restart] ${JSON.stringify({
              rfc: 'RFC-313',
              reason: pendingRestartReason,
              // 升级的触发条件**就是**链长追平预算，所以这里的 followupBudget 即
              // 放弃那个会话时的实际链长（判定后 retryShapeState.followupChainLen
              // 已被归零，事后读不到）。字段名按「它记录的事实」取。
              abandonedAfterFollowups: followupBudget,
              restartsUsed: retryShapeState.restartsUsed,
              retryAttempt: attempt,
            })}`,
          })
        }
      }
    }
  }

  /**
   * 一次 attempt 的完整机身（骨架每轮调一次）。`k` 是骨架轮次（0 起），绝对 attempt
   * 序号 = retryIndex + k —— 与迁移前 `for (attempt = retryIndex; …)` 的取值逐一对应。
   * 返回本次的 RunResult；跨 attempt 的携带量（lastResult / lastError / nodeRunId /
   * isoHandle / envelopeNonce / priorAttemptClarifyActive）仍是闭包上的 let，语义不变。
   */
  const runOneAttempt = async (): Promise<RunResult | null> => {
    // RFC-130: the RFC-092/098 pre-snapshot (git stash create → pre_snapshot
    // columns) is GONE — the iso model never writes the canonical worktree, so
    // there is nothing to roll back. Retry re-branches a fresh iso from the
    // current canonical state (see the fresh-session block above). The
    // pre_snapshot columns + rollbackNodeRunWorktrees stay in the schema as
    // defense-in-depth (design.md D10) but are no longer written here.

    try {
      // RFC-023: read this row so the prompt context surfaces the prior
      // round's Q&A. The row may have been minted at any of three sites
      // (pendingExisting, retry-mint, clarify-rerun mint from clarify
      // service); reading off the DB guarantees we see whatever each path set.
      const currentRunRow = (
        await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
      )[0]
      const currentShardKey = currentRunRow?.shardKey ?? null

      // RFC-074 PR-C: the clarify "generation" is derived from id-order, NOT
      // the retired `clarifyIteration` counter. The prior top-level `done`
      // rows for this node at the same (iteration, shardKey), minted before
      // this run (id < current), each represent an earlier completed clarify
      // generation; their count is the generation index the counter used to
      // hold. `done` (not canceled) so review-iterate supersede markers don't
      // inflate it, and parentNodeRunId === null so fan-out shard children
      // don't either.
      const priorDoneGenerations = currentRunRow
        ? await priorDoneGenerationsForRun(db, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentShardKey,
            id: currentRunRow.id,
          })
        : []
      const clarifyGeneration = priorDoneGenerations.length

      // RFC-026: resolve sessionMode from the clarify node attached to this
      // agent (if any). `inline` only takes effect when the current run IS
      // a clarify-driven rerun.
      // RFC-098 WP-10 (audit S-25): "is a clarify-driven rerun" is read off
      // the row itself now — the mint factory records WHY every row exists
      // (node_runs.rerun_cause, migration 0044) and gate-2 switches on it
      // instead of the old `clarifyGeneration > 0 && retryIndex === 0`
      // proxy:
      //   - 'clarify-answer' / 'cross-clarify-questioner-rerun' → TRUE
      //     (the same logical round continues after a human answered);
      //   - 'process-retry' → FALSE (design.md §7 forbids inline resume on
      //     technical retries — deterministic retry behavior);
      //   - fresh scheduler mints ('initial' / 'stale-redispatch' /
      //     'revival') → FALSE (no prior session of the same round);
      //   - NULL (pre-0044 row dispatched across a daemon upgrade) → FALSE
      //     (documented boundary degradation — see isClarifyRerunCause).
      // The (consumerKind × cause) truth table is pinned by
      // rfc098-rerun-cause-gates.test.ts.
      const clarifyNodeForGate = hasClarifyChannel
        ? findClarifyNodeForAgent(definition, node.id)
        : undefined
      const clarifyNodeObjForGate = clarifyNodeForGate
        ? (findClarifyNode(definition, clarifyNodeForGate) as ClarifyNode | undefined)
        : undefined
      // RFC-056 A16: a cross-clarify questioner rerun honors the cross-clarify
      // node's `sessionModeForQuestioner`. The self-clarify findClarifyNode
      // lookup above returns undefined for the cross node (it is not a
      // `clarify` kind), so without this the questioner would silently stay
      // isolated even when the user picked inline in the editor. Resolve the
      // cross node via the SAME helper `channelKind` itself uses
      // (findCrossClarifyNodeForQuestioner) rather than reusing
      // clarifyNodeForGate: a questioner can wire BOTH a self-clarify and a
      // cross-clarify `__clarify__` edge, and findClarifyNodeForAgent returns
      // whichever edge is first — if the self edge wins, clarifyNodeForGate
      // points at the self clarify node and the cross node's
      // sessionModeForQuestioner would be silently ignored. (Codex review #3.)
      const crossQuestionerNodeId =
        channelKind === 'cross' ? findCrossClarifyNodeForQuestioner(definition, node.id) : undefined
      const crossQuestionerNode = crossQuestionerNodeId
        ? (definition.nodes.find(
            (n) => n.id === crossQuestionerNodeId && n.kind === 'clarify-cross-agent',
          ) as ClarifyCrossAgentNode | undefined)
        : undefined
      const sessionMode = crossQuestionerNode
        ? resolveCrossClarifySessionMode(crossQuestionerNode)
        : clarifyNodeObjForGate
          ? resolveClarifySessionMode(clarifyNodeObjForGate)
          : 'isolated'
      const isClarifyRerun = isClarifyRerunCause(currentRunRow?.rerunCause)
      const priorSessionId =
        isClarifyRerun && currentRunRow
          ? await readPriorAgentSessionId(db, {
              taskId,
              agentNodeId: node.id,
              shardKey: currentShardKey,
              iteration: currentRunRow.iteration,
              beforeId: currentRunRow.id,
            })
          : null
      // RFC-026 fallback reasons recorded via `recordClarifyInlineEvent`
      // below:
      //   - 'missing-session-id'           — decideResumeSessionId, pre-spawn
      //   - 'session-not-found'            — stderr inspection, post-spawn
      //   - 'session-resume-unsupported'   — reserved for an explicit
      //                                      behavior/capability probe (not
      //                                      inferred from a version string)
      const resumeDecision = decideResumeSessionId({
        sessionMode: isClarifyRerun ? sessionMode : 'isolated',
        sourceSessionId: priorSessionId,
      })
      if (resumeDecision.fallbackReason !== undefined) {
        await recordClarifyInlineEvent(db, nodeRunId, {
          level: 'warning',
          reason: resumeDecision.fallbackReason,
          extra: { clarifyGeneration },
        })
      }

      // RFC-132 (PR-C): the designer's §6 update-mode prior output is no longer fetched here (the
      // cross-clarify-specific designer working-draft fetch + its dedicated prior-output block are
      // gone). A designer responding to feedback now surfaces its working draft through the SAME
      // generalized RFC-119 prior-output path every other rerun uses (`freshestPriorRunWithOutput`
      // below). RFC-141 removed the RFC-120 §18 pure-override handoff suppression that used to
      // gate it — an override target now sees its own draft too.

      // RFC-132 (PR-C): the standing continue/stop directive is read SOLELY from the per-(task,
      // asking-node) clarify state (design §7) — the per-round directive concept is gone. The flat
      // injector (buildClarifyQueueContext) carries no directive; the scheduler drives
      // effectiveHasClarifyChannel / clarifyStopped / clarifyStopNotice from nodeDirective /
      // nodeStopOverride below. So the former per-role SELECT fork + the per-round directive-override
      // plumbing (which only fed the round-grouped injectors) are gone — selectAgentQueue queries
      // every role in one shot.
      //
      // RFC-122 (H1 fix): read the node directive AT DISPATCH (parallel to RFC-056 resolveCrossNodeStopped)
      // INSIDE the retry loop so EVERY attempt's freshly-minted process-retry row reads the LATEST
      // toggle (a flip while attempt N runs is honored by attempt N+1). Gated on hasClarifyChannel
      // (self-clarify AND cross-questioner both wire the same `__clarify__` source port); every
      // other node skips the read ⇒ undefined ⇒ nodeStopOverride=false.
      // RFC-123 (B1): read the FULL directive (not just === 'stop') so an explicit 'continue' toggle
      // can re-open a stopped channel (nodeStopOverride flips false → resolveEffectiveClarifyChannel
      // re-opens). No row ⇒ undefined ⇒ byte-for-byte unchanged.
      const nodeDirectiveRow = hasClarifyChannel
        ? await getNodeClarifyDirectiveRow(db, taskId, node.id)
        : undefined
      const nodeDirective = nodeDirectiveRow?.directive
      const nodeStopOverride = nodeDirective === 'stop'
      // RFC-132 (PR-C): the SINGLE unified deferred injector. selectAgentQueue pulls this node's
      // whole agent queue — self / questioner / designer / manual — in ONE query (design §2
      // "consumerKind 消失"), binds it to this rerun (承接 marker), and renders one flat
      // `## Clarify Q&A` block (§5). It replaces the former split self/questioner + designer
      // injectors: a designer's questions now ride the SAME block (§5 ②b), so there is no separate
      // designer External-Feedback context / `## External Feedback` section. Called for EVERY agent
      // node — an override / borrow target can hold a
      // reassigned question yet wire no clarify channel of its own (this mirrors the pre-PR-C
      // UNCONDITIONAL per-node-queue designer call). An empty queue ⇒ undefined ⇒ no injection.
      const clarifyQueue = await buildClarifyQueueContext({
        db,
        definition,
        taskId,
        consumerNodeId: node.id,
        dispatchedRunId: nodeRunId,
        iteration,
        envelopeNonce,
        // RFC-026: an inline resume is an incremental message. Entries
        // bound to earlier clarify runs already live in that OpenCode
        // transcript; inject only the unbound/current-run delta. Isolated
        // and fallback runs still receive the complete un-aged queue.
        currentRunOnly: resumeDecision.inlineMode,
      })
      // RFC-141: the RFC-120 §18 pure-override handoff suppression (`suppressPriorOutput`) is
      // GONE by user ruling — the reassigned Q&A rides the flat block below, and the prior-output
      // sections render alongside it as the node's own background.
      const clarifyContext =
        clarifyQueue === undefined
          ? undefined
          : {
              // renderUserPrompt emits this verbatim + skips the legacy round-grouped sections.
              flatBlock: clarifyQueue.block,
              iteration: String(clarifyGeneration),
              remaining: computeRemaining(definition, node.id, clarifyGeneration),
              // Inline session resume suppresses input re-injection, swaps the trailing
              // reminder, and carries only the queue delta not already in the transcript.
              ...(resumeDecision.inlineMode ? { mode: 'inline' as const } : {}),
            }
      // effectiveHasClarifyChannel is the "mandatory ask-back is ACTIVE" signal
      // threaded to the runner + renderUserPrompt (RFC-100). It is TRUE only
      // when the agent is in a genuine clarify round and must ask back:
      //   - hasClarifyChannel: the agent wired a clarify channel, AND
      //   - directive !== 'stop' (RFC-023): the user has not clicked
      //     "Stop clarifying" — a stop round finalizes with <workflow-output>;
      //     the answersBlock already carries the STOP CLARIFYING sentence. The
      //     next round walks back through scheduleAgentNode and re-derives the
      //     flag, so 'stop' naturally scopes to one rerun, AND
      //   - (reviewContext === undefined || isClarifyRerun) (RFC-100 + Codex
      //     review #1 fix): a review reject/iterate RE-PRODUCTION run is NOT a
      //     clarify round — it must produce <workflow-output> to address the
      //     reviewer's comments, so reviewContext disables mandatory ask-back for
      //     it (without this a clarify-channel designer could never satisfy a
      //     review iterate; its v2 output would be rejected as clarify-required).
      //     BUT a clarify-answer rerun that happens DURING a review-iterate cycle
      //     (the designer asked back, the user answered) IS a clarify round and
      //     must honor its directive — so isClarifyRerun re-enables the gate
      //     there. Otherwise a "Keep clarifying" answer mid-review would be
      //     bypassed and the agent could finalize before the user clicks Stop.
      //     RFC-183: on a pure iterate/reject re-production the runner now
      //     REJECTS a voluntary <workflow-clarify> (directive 'suppressed'
      //     ⇒ disposition 'reject') — output is the only accepted reply.
      //
      // RFC-122: extracted to the pure `resolveEffectiveClarifyChannel` oracle
      // and extended with the per-(task, asking-node) `nodeStopOverride` term —
      // the on-canvas "停止反问" toggle forces ask-back off here for BOTH self and
      // cross. `nodeStopOverride=false` reproduces the exact pre-RFC-122 boolean
      // (golden-lock).
      //
      // RFC-183 (Codex design-gate P2#1/P2#4): the oracle's isClarifyRerun
      // input is LINEAGE-aware, not current-cause-only. A clarify-answer /
      // cross-questioner round that dies technically continues as
      // cause='process-retry' (attempt loop) or — across a daemon restart —
      // cause='revival'; both sit outside isClarifyRerunCause BY DESIGN
      // (RFC-098 修订 #11: that gate owns inline-resume / Q&A derivation).
      // Feeding the raw cause here made those continuation rounds degrade
      // to 'suppressed' — zero clarify bytes, and post-RFC-183 a hard
      // reject — against the user's "Keep clarifying". The persisted cause
      // chain decides instead; the inline-resume gate above deliberately
      // keeps the raw `isClarifyRerun` (technical retries never resume).
      const lineageCauses = currentRunRow
        ? await lineageCausesNewestFirst(db, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentShardKey,
            id: currentRunRow.id,
          })
        : []
      const clarifyLineageContinues = continuesClarifyLineage(lineageCauses)
      const effectiveHasClarifyChannel = resolveEffectiveClarifyChannel({
        hasClarifyChannel,
        // RFC-132 (PR-C): the standing directive is the node clarify state (design §7); the flat
        // context carries none. nodeStopOverride already covers `=== 'stop'`, so this is redundant
        // with it but kept explicit for the oracle's contract (golden-lock).
        contextDirective: nodeDirective,
        nodeStopOverride,
        reviewActive: reviewContext !== undefined,
        isClarifyRerun: clarifyLineageContinues,
      })
      // RFC-123 follow-up (user「强制停止」): is the node EXPLICITLY stopped? RFC-132 (PR-C): a
      // 'stop' answer already writes the per-node clarify state (clarifySeal.setNodeClarifyDirective),
      // so the node directive IS the single source — `nodeStopOverride` alone captures both the canvas
      // toggle AND a latest answered 'stop'. Threaded to the runner so a disobedient
      // <workflow-clarify> is REJECTED (no session) under an explicit stop, while review reruns
      // (reviewActive && !isClarifyRerun) keep emitting clarify.
      const clarifyStopped = hasClarifyChannel && nodeStopOverride
      // RFC-165 (F12): the wired SELF-clarify node may declare
      // clarifyMode:'optional' — the channel is offered, never enforced.
      // Precedence stopped > optional > mandatory/suppressed; every rerun
      // (initial / retry / post-answer) recomputes from the same static
      // node field, so answering a round can never re-escalate the node to
      // mandatory. Cross channels carry no clarifyMode (undefined ⇒ off).
      const clarifyOptional = hasClarifyChannel && clarifyNodeObjForGate?.clarifyMode === 'optional'
      // RFC-122 (H2 fix), RFC-132 (PR-C): inject the standalone STOP CLARIFYING trailer whenever the
      // node is stopped. The flat block NEVER carries a per-question directive trailer (§5), so —
      // unlike the round-grouped path — the trailer's ONLY source is this notice. `contextDirective:
      // undefined` makes shouldInjectStopNotice return `nodeStopOverride` (the block can never
      // already carry it), so a stopped node always gets exactly one STOP trailer (first run /
      // review-rerun / answered-stop alike).
      const clarifyStopNotice = shouldInjectStopNotice({
        nodeStopOverride,
        contextDirective: undefined,
      })
      // RFC-122 (same-session follow-up fix): a same-session envelope follow-up
      // (renderEnvelopeFollowupPrompt) re-anchors on "the format previously
      // specified in this session" WITHOUT re-emitting the full protocol. If the
      // per-attempt STOP toggle flipped this attempt's clarify-vs-output mode
      // relative to the prior attempt, that format was never specified in the
      // resumed session — so bypass the follow-up and let the FULL
      // renderUserPrompt render the correct protocol (output-port list +
      // clarifyStopNotice, or the mandatory ask-back block) from scratch.
      // Bidirectional (stop→output AND output→stop). Golden-lock: with no toggle
      // the mode is stable across attempts ⇒ false ⇒ follow-up path unchanged.
      const clarifyModeFlip =
        followupDecision.followup && priorAttemptClarifyActive !== effectiveHasClarifyChannel
      priorAttemptClarifyActive = effectiveHasClarifyChannel
      // RFC-313 实现门 P1-1：与上一行同址更新——两个「上一次 attempt 的观察值」必须
      // 在同一个点写，否则它们会各自漂移到不同的 attempt 边界上。
      priorAttemptStopOverride = nodeStopOverride
      // RFC-119 / RFC-132 (PR-C) / RFC-141: generalized prior-output for ANY rerun — review
      // reject/iterate (supersede→canceled), manual retry, cascade, resume, clarify-answer,
      // mandatory ask-back rounds, override handoffs, AND the cross-clarify designer (whose
      // dedicated prior-output path was removed — a designer responding to feedback surfaces
      // its working draft through THIS single path). RFC-141 (user ruling) removed two former
      // gates:
      //   - RFC-119 D6 "mandatory ask-back suppresses" — its "nearly impossible" premise was
      //     disproved (a node with a done draft re-enters ask-back on every new answer batch;
      //     evidence: QMGP5 agent_m7p3n1 retry 17). renderUserPrompt now picks the ask-back
      //     directive variant off the same hasClarifyChannel signal that picks the trailing
      //     protocol, so the wording cannot contradict the clarify-only round.
      //   - RFC-120 §18 "pure-override handoff suppresses" — the override target now sees its
      //     own draft as background; the reassigned Q&A rides `## Clarify Q&A`.
      // Still skipped on inline session resume (the resumed session already holds the prior
      // output — re-injecting wastes tokens and re-anchors on stale text).
      // D10: on a review-ITERATE, RFC-014's `## Sibling Outputs` already carries the sibling ports;
      // restrict to the iterate-target port so the two don't duplicate. review-reject / non-review
      // reruns → all ports (onlyPorts undef).
      let priorOutputUpdate: { block: string } | undefined
      if (currentRunRow !== undefined && !resumeDecision.inlineMode) {
        const priorRun = await freshestPriorRunWithOutput(db, {
          taskId,
          nodeId: node.id,
          iteration: currentRunRow.iteration,
          shardKey: currentShardKey,
          id: currentRunRow.id,
        })
        if (priorRun !== undefined) {
          const onlyPorts =
            reviewContext?.iterateTargetPort !== undefined
              ? new Set([reviewContext.iterateTargetPort])
              : undefined
          const block = await composePriorOutputBlock(
            db,
            priorRun.id,
            agent.outputs ?? [],
            onlyPorts,
            envelopeNonce,
          )
          if (block.length > 0) priorOutputUpdate = { block }
        }
      }
      if (resumeDecision.inlineMode && resumeDecision.resumeSessionId !== undefined) {
        await recordClarifyInlineEvent(db, nodeRunId, {
          level: 'info',
          sessionIdPrefix: resumeDecision.resumeSessionId.slice(0, 8),
          extra: { clarifyGeneration },
        })
      }
      // RFC-042: follow-up attempts re-use the prior attempt's opencode
      // session id (captured above into `followupResumeSessionId`) AND swap
      // the prompt for a short re-anchor directive. The RFC-026 inline
      // clarify-rerun resume path only fires on the FIRST attempt of a
      // clarify-driven rerun (rows whose rerun_cause is in the gate-2 set;
      // follow-up attempt rows are minted cause='process-retry' and gate
      // FALSE) so the two paths cannot fight over the same
      // `resumeSessionId` slot. When both contexts are present,
      // follow-up wins because it expresses what THIS attempt is for.
      // RFC-122 (mode-flip session-clear): a STOP-toggle mode flip already
      // bypasses the same-session follow-up PROMPT (clarifyModeFlip → full
      // renderUserPrompt). Don't then resume the prior (wrong-mode) opencode
      // session for it — the prior session is clarify-only or output-only and
      // resuming it would feed the full fresh-mode prompt into a contradictory
      // conversation. On a flip we fall to resumeDecision.resumeSessionId, which
      // for a process-retry ('isolated') is undefined ⇒ a FRESH session matching
      // the full prompt. Golden-lock: no flip ⇒ `&& !clarifyModeFlip` is a no-op
      // ⇒ same-session resume byte-identical to today. (The worktree rollback +
      // pre-snapshot stay gated on followupDecision.followup — see the RFC-122
      // residual note: downgrading those needs the directive at loop top, which
      // is entangled with buildPromptContext; tracked as a follow-up.)
      // RFC-127 F1 + Codex impl-gate P2: a same-attempt envelope follow-up
      // (followupResumeSessionId is THIS attempt's own session) stays paired with
      // envelopeFollowup mode (the runner renders only the short repair prompt).
      // (RFC-132 ③: the borrowed-row special case is gone with the borrow ledger —
      // a node always runs its own agent, so the inline resume is always its own.)
      const effectiveResumeSessionId =
        followupDecision.followup && !clarifyModeFlip
          ? followupResumeSessionId
          : resumeDecision.resumeSessionId
      // RFC-132 (PR-C): the follow-up strong-bias trailer (renderEnvelopeFollowupPrompt) fires on
      // clarifyDirective==='continue'. When effectiveHasClarifyChannel is true the node IS in
      // ask-back ("keep clarifying") mode, so the directive is 'continue' by construction. Gate on a
      // non-empty flat queue (clarifyContext defined) to preserve the legacy "no trailer on a
      // first-ever run with no answered round" behavior (the per-round directive was undefined
      // there).
      const followupClarifyDirective =
        followupDecision.followup && effectiveHasClarifyChannel && clarifyContext !== undefined
          ? ('continue' as const)
          : undefined
      // RFC-111 D15: read the runtime frozen onto this node_run, or freeze it
      // now (agent.runtime ?? config.defaultRuntime) on the first dispatch.
      // resume/retry of the same row read the frozen value so a mutated
      // agent / default can't re-route a captured session to the wrong runtime.
      // RFC-112 P1: a retry / clarify-rerun mints a FRESH row but may carry a
      // prior session id — inherit that session owner's frozen (protocol,
      // binary) so the id + runtime stay a pair across the new row.
      const inheritedRuntime =
        effectiveResumeSessionId !== undefined
          ? await frozenRuntimeOfSession(db, effectiveResumeSessionId)
          : null
      const frozenRuntime = await resolveFrozenRuntime(
        db,
        nodeRunId,
        agent.runtime,
        state.opts.defaultRuntime,
        inheritedRuntime,
        freezeBinaryConfig(state.opts.configPath),
      )
      lastResult = await runNode({
        taskId,
        nodeRunId,
        nodeId: node.id,
        agent,
        triggerContext: state.triggerContext,
        runtime: frozenRuntime.protocol,
        runtimeBinary: frozenRuntime.binary,
        runtimeParams: frozenRuntime.params,
        runtimeConfigDir: frozenRuntime.configDir, // RFC-154: frozen config-dir profile
        inputs: upstreamInputs,
        // RFC-130 D16: the opencode cwd + ALL path-bearing template tokens point
        // at the ISOLATED worktree, not the canonical one — otherwise the agent
        // would be told (via {{__repo_path__}} / {{__repos__}}) to edit a path
        // outside its isolation. repos[].repoPath stays the source repo (an origin
        // reference, not a cwd); repos[].worktreePath becomes the per-repo iso.
        worktreePath: isoHandle.repos[0]?.isoWorktreePath ?? task.worktreePath,
        // Trusted platform-input mounts identify a digital-employee action.
        // Its Agent may edit business files but Git lifecycle is platform-only.
        ...(task.platformInputPathsJson !== null
          ? { gitMutationPolicy: 'read-only' as const }
          : {}),
        // RFC-067: thread per-task Git commit identity through to the runner
        // so `git commit` invocations inside the agent inherit the
        // task-scoped author + committer. Both NULL → runner skips
        // injection and falls back to daemon's default git config.
        gitUserName: task.gitUserName,
        gitUserEmail: task.gitUserEmail,
        templateMeta: {
          repoPath: isoHandle.repos[0]?.isoWorktreePath ?? task.repoPath,
          baseBranch: task.baseBranch,
          taskId,
          nodeId: node.id,
          iteration,
          // RFC-066: per-repo metadata for the {{__repos__}} /
          // {{__repo_names__}} / {{__repo_count__}} placeholders.
          repos: isoHandle.repos.map((r) => ({
            repoPath: r.repoPath,
            worktreePath: r.isoWorktreePath,
            worktreeDirName: r.worktreeDirName,
            mountPath: r.worktreeDirName,
            subdir: '',
            readonly: false,
            baseBranch: r.baseBranch,
          })),
        },
        ...(promptTemplate !== undefined ? { promptTemplate } : {}),
        ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
        ...(reviewContext !== undefined ? { reviewContext } : {}),
        // RFC-132 (PR-C): a single flat clarifyContext (self/questioner/designer merged, §5). No
        // separate designer External-Feedback context — the designer's Q&A rides
        // clarifyContext.flatBlock.
        ...(clarifyContext !== undefined ? { clarifyContext } : {}),
        ...(priorOutputUpdate !== undefined ? { priorOutputUpdate } : {}),
        ...(effectiveResumeSessionId !== undefined
          ? { resumeSessionId: effectiveResumeSessionId }
          : {}),
        // RFC-148: the followup quartet is ONE PromptMode value now. The
        // followup arm carries the session id (unrepresentable without one
        // — decideEnvelopeFollowup only fires when the prior attempt
        // captured a session). RFC-122: a same-session follow-up is
        // bypassed when the STOP toggle flipped this attempt's
        // clarify-vs-output mode (clarifyModeFlip) — the resumed session
        // never emitted the now-needed protocol, so the runner takes the
        // FULL renderUserPrompt path instead.
        ...(followupDecision.followup && !clarifyModeFlip && effectiveResumeSessionId !== undefined
          ? {
              promptMode: {
                kind: 'followup' as const,
                resumeSessionId: effectiveResumeSessionId,
                reason: followupDecision.reason,
                ...(followupClarifyDirective !== undefined
                  ? { clarifyDirective: followupClarifyDirective }
                  : {}),
                // RFC-049: thread the structured failures through so the
                // runner renders the per-kind repair block. Empty array
                // (degraded mode) is fine — the followup still fires.
                ...(followupDecision.reason === 'port-validation'
                  ? { portValidations: followupDecision.failures }
                  : {}),
              },
            }
          : {}),
        // RFC-313: 本次 attempt 是主动会话升级后的第一次运行 ⇒ 让渲染器在完整
        // prompt 的协议块之后追加一段简短告知。与 promptMode.followup 天然互斥
        // （升级时 followupDecision 已被 decideFollowupForRetry 收回成 false），
        // 所以短提示与告知永远不会同时出现。
        ...(pendingRestartReason !== undefined
          ? { priorSessionAbandonedReason: pendingRestartReason }
          : {}),
        // RFC-148: the clarify quartet is ONE ClarifyChannel value now —
        // wiring family (parser cap) × this-run directive (enforcement)
        // × stop-notice injection.
        clarifyChannel: !hasClarifyChannel
          ? { kind: 'none' as const }
          : {
              kind: channelKind,
              directive: clarifyStopped
                ? ('stopped' as const)
                : clarifyOptional
                  ? ('optional' as const)
                  : effectiveHasClarifyChannel
                    ? ('mandatory' as const)
                    : ('suppressed' as const),
              injectStopNotice: clarifyStopNotice,
            },
        skills: resolvedSkills,
        dependents,
        mcps,
        plugins,
        appHome: opts.appHome,
        ...(opts.binaryOverride ? { binaryOverride: opts.binaryOverride } : {}),
        db,
        log: log.child('run'),
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.subagentLiveCapture !== undefined
          ? { subagentLiveCapture: opts.subagentLiveCapture }
          : {}),
      })

      // RFC-026: persist opencode session id captured from the JSON event
      // stream so the NEXT clarify-driven rerun on this lineage can pass
      // it back via `--session`. NULL on failed / canceled runs is fine.
      if (lastResult.sessionId !== undefined && lastResult.sessionId !== '') {
        await db
          .update(nodeRuns)
          .set({ opencodeSessionId: lastResult.sessionId })
          .where(eq(nodeRuns.id, nodeRunId))
      }
      // RFC-026: post-spawn fallback — opencode rejected the resume id we
      // passed. Treat the run as a fail-soft signal: leave the failure to
      // surface naturally (status will be 'failed' or have empty outputs),
      // but log a warning so operators can see WHY. The next retry within
      // this attempt loop will not carry resumeSessionId (we only set it
      // on the first attempt of a clarify rerun).
      if (resumeDecision.inlineMode && lastResult.status !== 'done') {
        const stderrText = await readStderrText(db, nodeRunId)
        // RFC-284 T15（D10）：判据下沉 driver 能力面——措辞属各 CLI 私有。
        // 无该能力的 driver 视为「无法判定」（告警可能缺失但绝不误报）。
        if (getRuntimeDriver(frozenRuntime.protocol).detectSessionNotFound?.(stderrText) === true) {
          await recordClarifyInlineEvent(db, nodeRunId, {
            level: 'warning',
            reason: 'session-not-found',
            extra: { clarifyGeneration },
          })
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const errorMessage = `node ${node.id} threw: ${msg}`
      // runNode normally owns pending→running→terminal. Exceptions thrown
      // before it can enter that lifecycle (for example prompt-template
      // rendering) used to leave the attempt row pending. Retry minting then
      // abandoned each predecessor, while the final pending/isolating row was
      // redispatched and crashed on begin-isolation from an abandoned state.
      // Close the row before the retry policy observes the synthetic failure.
      await transitionNodeRunStatus({
        db,
        nodeRunId,
        event: { kind: 'mark-failed', reason: 'scheduler-node-threw' },
        extra: { finishedAt: Date.now(), errorMessage, exitCode: null },
      })
      lastResult = {
        status: 'failed',
        exitCode: null,
        outputs: {},
        tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
        prompt: '',
        errorMessage,
      }
      lastError = msg
    }

    broadcastNodeStatus(taskId, nodeRunId, node.id, lastResult.status)
    return lastResult
  }

  const windowOut = await runAssembly<Record<string, never>, RunResult | null, AgentWindowOut>(
    {},
    {
      // RFC-208：许可由骨架自取自放（全五条线同一口径）。
      pools: [agentSem],
      iso: {
        create: async () => {
          isoHandle = await createIsoUnderLock({
            writeSem,
            appHome: opts.appHome,
            taskId,
            db,
            isoKeyRunId,
            canonRepos: state.repos,
            log,
          })
          return isoHandle
        },
        // RFC-208: persisting the iso base must happen INSIDE the region whose
        // finally releases the permit. It used to sit between the acquire and the
        // window, and `transitionMergeState` throwing there (a documented,
        // test-locked behavior — NotFoundError / IllegalMergeStateTransition /
        // ConcurrentMergeStateTransition, plus any SQLite error) leaked one
        // daemon-wide permit per occurrence with no way back short of a restart.
        persistBase: 'in-window',
        persist: async () => {
          await persistIsoBase(db, nodeRunId, task.repoCount, isoHandle)
        },
      },
      onIsoSetupFailure: (err) => {
        log.warn('iso worktree setup failed', {
          nodeId: node.id,
          error: err instanceof Error ? err.message : String(err),
        })
        return {
          kind: 'settled',
          out: {
            kind: 'failed',
            summary: 'isolated worktree setup failed',
            message: 'iso-setup-failed',
          },
        }
      },
      // 机身不需要 attempt 序号：行已由 prepareRetryAttempt 按正确 retryIndex 铸好，
      // 机身一律读 nodeRunId（迁移前的 `attempt` 局部也只服务于重试前奏，机身里只在
      // 注释中出现过）。
      spawn: async () => await runOneAttempt(),
      retryPolicy: {
        // 迁移前的循环是 `for (attempt = retryIndex; attempt <= retryIndex + maxRetries)`
        // 配两处 break；三条判据逐字搬来，取值范围一一对应（k 为骨架轮次，0 起）。
        shouldRetry: (r, k) =>
          k < maxRetries &&
          r !== null &&
          r.status !== 'done' &&
          r.status !== 'canceled' &&
          shouldRetryNodeFailure(r.failureCode, r.processUnreaped === true),
        // D17：同会话续跑留用同一棵树，换新会话丢弃重建——判据即 RFC-042 决策本身。
        isoOnRetry: { keepIf: async (r) => await decideFollowupForRetry(r) },
        onIsoRecreateFailure: (err) => {
          log.warn('retry iso recreate failed', {
            nodeId: node.id,
            error: err instanceof Error ? err.message : String(err),
          })
          lastError = 'iso-recreate-failed'
          lastResult = {
            status: 'failed',
            exitCode: null,
            outputs: {},
            tokenUsage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0 },
            prompt: '',
            errorMessage: 'iso-recreate-failed',
          }
          // 迁移前这里是 `break` 落到窗口外收尾；判别式回 'ran' 等价。
          return { kind: 'ran', result: lastResult }
        },
        onNextAttempt: async (k) => {
          await prepareRetryAttempt(retryIndex + k)
        },
      },
      // 第五维：旧 child 可能还活着，树不能收（正交于合并处置）。
      keepFromOutcome: (r) => r?.processUnreaped === true,
      // RFC-130 §段③: on success, merge the iso delta back into the canonical
      // worktree under a brief writeSem window. The runner already wrote
      // status='done'; downstream readiness ALSO gates on merge_state (D15,
      // deriveFrontier), so nothing dispatches off this node until 'merged'.
      // D19: a <workflow-clarify> reply is status='done' with result.clarify set but
      // has NOT produced final output — skip merge-back and KEEP the iso so the
      // answered inline resume (same opencode session) sees the files it wrote.
      mergePhase: (_c, r) => {
        if (r !== null && r.status === 'done' && r.clarify !== undefined) {
          return { skip: 'park', keep: true, then: 'settle' }
        }
        if (r === null || r.status !== 'done')
          return { skip: 'not-done', keep: false, then: 'settle' }
        if (isoHandle.passthrough) return { skip: 'passthrough', keep: false, then: 'settle' }
        return 'merge'
      },
      mergeBack: {
        // RFC-188: the ONE merge-back assembly (mergeBackAndSettle) — the §6.2
        // writeSem hold, conflict resolution and merge_state settling now live
        // in isolatedAgentRun.ts; this site keeps only its own dispositions
        // (keepIso + awaiting_human on conflict-human; merge-failed stamp on
        // throw — RFC-130 D15 keeps downstream gated, RFC-144 §5 try-variant).
        run: async (_c, r) =>
          await mergeBackAndSettle({
            db,
            writeSem,
            handle: isoHandle,
            nodeRunId,
            repoCount: task.repoCount,
            via: 'live',
            // RFC-193 K1: this run's own just-emitted port files (not yet in the
            // handle's DB-aggregated roster) join the final-snapshot force list.
            extraForcedContainerPaths: (r?.portFilePaths ?? []).map((p) =>
              toContainerRelative(state.repos[0]?.worktreeDirName ?? '', p),
            ),
            conflictResolver: (conflicts, containerPath) =>
              resolveMergeConflicts(state, {
                conflicts,
                containerPath,
                conflictNodeRunId: nodeRunId,
                nodeId: node.id,
                iteration,
              }),
            log,
          }),
        disposition: {
          // §6.3 — merge agent could not resolve → park human. Conflict is NEVER
          // silently lost; canonical stays clean for siblings; the resolve-iso(s)
          // are kept so the human finishes there and resume re-merges (#4).
          onConflictHuman: (detail) => ({
            keep: true,
            produce: async () => {
              log.warn('merge-back conflict unresolved by merge agent → awaiting_human', {
                nodeId: node.id,
                detail,
              })
              return {
                kind: 'settled',
                out: {
                  kind: 'awaiting_human',
                  summary: `merge conflict unresolved: ${detail}`,
                  message: 'merge-conflict',
                },
              }
            },
          }),
          // 抛出走骨架默认处置（keep + markMergeFailed + settle），故不覆写 onThrow。
        },
      },
      // RFC-130 robustness: a merge-back that THROWS (iso corrupted, .git gone,
      // a git op error) must fail the node loudly — never leave a 'done' row
      // whose delta never reached canonical.
      //
      // RFC-210 impl-gate A1-fix: KEEP the iso on a merge-back throw. The iso
      // worktree can be the ONLY copy of the node's product — most acutely
      // when the snapshot phase itself failed (submodule auto-commit rejected
      // by a hook, object publish failed): nothing has reached canonical or
      // the pool yet, and the old discard-in-finally deleted the sole copy.
      // A later fresh-session retry builds its own iso under a new run id;
      // this one stays for manual salvage until the container GC sweeps it.
      // ——keep 由骨架默认处置负责；这里只做本线私有的 warn + 结局改写。
      markMergeFailed: async (msg) => {
        log.warn('merge-back failed', { nodeId: node.id, error: msg })
        await markMergeFailed(db, nodeRunId, msg, log)
        if (lastResult !== null) {
          lastResult = {
            ...lastResult,
            status: 'failed',
            errorMessage: `merge-back-failed: ${msg}`,
          }
        }
      },
      discardIso: async (h) => {
        // Discard the iso worktree on a terminal exit; keep it when the node is
        // parked (awaiting_human / merge conflict) so the resume path (D19) + the
        // future merge agent (PR-B) can reuse the exact same worktree state.
        await discardNodeIso(h as IsoHandle, log, writeSem)
      },
      settle: async () => ({ kind: 'ran', result: lastResult }),
      log,
    },
  )
  if (windowOut.kind === 'settled') return windowOut.out
  // 直线回填：让 TS 的控制流重新看到 `RunResult | null`（闭包内的赋值它看不见）。
  lastResult = windowOut.result

  if (lastResult === null) {
    return {
      kind: 'failed',
      summary: 'node produced no result',
      message: lastError ?? 'unknown',
    }
  }
  if (lastResult.status === 'canceled') {
    return {
      kind: 'canceled',
      summary: 'node canceled',
      message: lastResult.errorMessage ?? 'canceled',
    }
  }
  if (lastResult.status !== 'done') {
    return {
      kind: 'failed',
      summary: lastResult.errorMessage ?? `node ${node.id} ${lastResult.status}`,
      message: lastResult.errorMessage ?? lastResult.status,
      ...(lastResult.processUnreaped === true ? { processUnreaped: true as const } : {}),
    }
  }
  // RFC-023: when the agent reply was a <workflow-clarify> envelope, runner
  // returns status='done' AND populates result.clarify. The scheduler is the
  // only piece with access to the workflow definition, so it owns mapping
  // the asking agent → clarify node id and parking the clarify node_run
  // awaiting_human. After this returns 'awaiting_human', the scope loop
  // bubbles up and the task transitions to status='awaiting_human' until the
  // user POSTs answers via /api/clarify.
  if (lastResult.clarify !== undefined) {
    // RFC-056: prefer the cross-clarify route if the questioner's
    // __clarify__ port is wired to a clarify-cross-agent node. The
    // shared helper short-circuits when no cross-clarify target exists,
    // falling through to the RFC-023 self-clarify path below.
    const crossClarifyNodeId = findCrossClarifyNodeForQuestioner(definition, node.id)
    if (crossClarifyNodeId !== undefined) {
      const currentRunRowXc = (
        await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
      )[0]
      const designerNodeId = findDesignerNodeForCrossClarify(definition, crossClarifyNodeId)
      // Defensive: persistent stop would have been short-circuited at
      // dispatch already. If the questioner still emitted clarify, treat
      // as protocol violation. Caller's retries (RFC-042) kick in.
      const persistentRow = await db
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .limit(1)
      void persistentRow
      await createClarifyRound({
        kind: 'cross',
        db,
        taskId,
        intermediaryNodeId: crossClarifyNodeId,
        askingNodeId: node.id,
        askingNodeRunId: nodeRunId,
        targetConsumerNodeId: designerNodeId ?? null,
        loopIter: currentRunRowXc?.iteration ?? 0,
        questions: lastResult.clarify.questions,
        ...(lastResult.clarify.truncationWarnings.length > 0
          ? { truncationWarnings: lastResult.clarify.truncationWarnings }
          : {}),
      })
      return {
        kind: 'awaiting_human',
        summary: `questioner ${node.id} asked back via cross-clarify node ${crossClarifyNodeId}`,
        message: 'cross-clarify-awaiting-human',
      }
    }

    const clarifyNodeId = findClarifyNodeForAgent(definition, node.id)
    if (clarifyNodeId === undefined) {
      // Agent emitted clarify but has no clarify channel — protocol abuse.
      return {
        kind: 'failed',
        summary: `agent ${agent.name} emitted <workflow-clarify> but node ${node.id} has no clarify channel`,
        message: 'clarify-no-channel',
      }
    }
    const currentRunRow = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
    )[0]
    // RFC-074 PR-C: the clarify round index is the asking run's generation —
    // the count of its prior completed generations (id-order) — not the retired
    // clarifyIteration counter. First clarify round → generation 0.
    const askingGeneration = currentRunRow
      ? (
          await priorDoneGenerationsForRun(db, {
            taskId,
            nodeId: node.id,
            iteration: currentRunRow.iteration,
            shardKey: currentRunRow.shardKey ?? null,
            id: currentRunRow.id,
          })
        ).length
      : 0
    await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: node.id,
      askingNodeRunId: nodeRunId,
      askingShardKey: currentRunRow?.shardKey ?? null,
      intermediaryNodeId: clarifyNodeId,
      iteration: askingGeneration,
      questions: lastResult.clarify.questions,
      ...(lastResult.clarify.truncationWarnings.length > 0
        ? { truncationWarnings: lastResult.clarify.truncationWarnings }
        : {}),
    })
    return {
      kind: 'awaiting_human',
      summary: `agent ${node.id} asked back via clarify node ${clarifyNodeId}`,
      message: 'clarify-awaiting-human',
    }
  }
  return { kind: 'ok', summary: '', message: '' }
}

// -----------------------------------------------------------------------------
// RFC-040 — wrapper resume helpers shared by runLoopWrapperNode and
// runGitWrapperNode.
//
// Why they exist: before RFC-040, both wrappers silently swallowed
// `awaiting_human` / `awaiting_review` signals from their inner scope (only
// `canceled` / `failed` were matched) and either kept iterating (loop) or
// computed a diff against a half-finished worktree (git). The result was N
// ghost clarify/review rows and, for git, a wrong final diff. The fix is to
// (a) bubble the awaiting signal up unchanged, (b) persist enough state on
// the wrapper's node_run so the dispatcher can resume from the same loop
// iteration / git baseline when the user answers clarify or decides review,
// and (c) reuse the existing wrapper node_run row on resume instead of
// minting a fresh one. See design/RFC-040-wrapper-await-bubble/design.md §4.
// -----------------------------------------------------------------------------

/**
 * Find a non-terminal wrapper node_run row for (taskId, nodeId, iteration)
 * to resume into, if any. Terminal states (done / failed / canceled /
 * exhausted) return null — the dispatcher should mint a fresh wrapper run
 * for them (e.g. a sibling iteration of an outer loop wrapper).
 *
 * latestPerNode in runScope keys on nodeId only and would otherwise return
 * a stale row from another iteration when an outer loop wrapper drives the
 * dispatch; we MUST filter by iteration here to avoid grabbing a sibling
 * iteration's wrapper row.
 */
async function findResumableWrapperRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  parentIteration: number,
): Promise<typeof nodeRuns.$inferSelect | null> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, nodeId),
        eq(nodeRuns.iteration, parentIteration),
      ),
    )
    .orderBy(desc(nodeRuns.id))
    .limit(1)
  if (rows.length === 0) return null
  const r = rows[0]!
  if (r.status === 'done' || r.status === 'failed' || r.status === 'exhausted') {
    // RFC-095 (audit S-22): 'canceled' is NO LONGER terminal here — a wrapper
    // row canceled by task-cancel resumes from its persisted progress when the
    // task is revived via retryNode (loop continues at the parked iteration,
    // git keeps its pre-inner baseline), exactly like 'interrupted'. Restarting
    // instead (the old behavior: mint a fresh wrapper row) would rewind the
    // loop to iteration 0 and re-capture a WRONG git baseline.
    return null
  }
  return r
}

/**
 * RFC-098 B3 (audit S-7) — provenance for loop/git wrapper rows. For every
 * EXTERNAL upstream source of the wrapper (wrapperExternalUpstreamSources,
 * dispatchFrontier.ts) pick the run an inner node would consume via
 * resolveUpstreamInputs at this iteration window (pickUpstreamSourceRun —
 * shared picker, freshness.ts) and record `{sourceNodeId: runId}`. Stamped
 * onto the wrapper row so an upstream rerun demotes the wrapper's done row to
 * stale → frontier re-dispatch → findResumableWrapperRun sees done as
 * terminal → a FRESH wrapper row is minted: the loop restarts from iteration
 * 0 / the git wrapper re-captures its baseline (the correct semantics; the
 * fanout wrapper has carried the same contract since RFC-074 §8 D3).
 *
 * A source with no visible done run yet is simply ABSENT from the map (the
 * same warn-and-skip resolveUpstreamInputs applies) — that source can then
 * never demote this wrapper generation, which matches the agent-row contract
 * (isNodeRunFresh treats absent upstreams as still-fresh).
 *
 * Known bounded degradations (adversarial-review revision #6 + survey
 * §wp6c-loopgit, recorded here as the failure-mode ledger):
 *   - WRITE AT FRESH-MINT ONLY — resume must NOT overwrite. A resume-time
 *     overwrite would permanently mask an external-source rerun that landed
 *     while the wrapper was parked (the stale signal vanishes and the
 *     semantics drift with dispatch timing). Under fresh-mint-only the parked
 *     generation keeps its original provenance, finishes, is then naturally
 *     judged stale and fully re-run next invocation — one extra full pass,
 *     but convergent.
 *   - Same-invocation done→stale: if the upstream rerun lands in the SAME
 *     runScope invocation that already dispatched the wrapper, the
 *     per-invocation dedup parks the stale done row as
 *     blocked('stale-done-in-invocation-dedup') and the scope can end
 *     stalled — bounded, a resume re-derives and re-runs it.
 *   - Wrapper re-run does NOT roll the worktree back (wrapper rows carry no
 *     preSnapshot): the new generation sees the previous generation's
 *     worktree residue. Known open point, same family as the cross-generation
 *     preDirty interplay noted in design/RFC-098 §B3.
 */
async function computeWrapperConsumed(
  db: DbClient,
  taskId: string,
  definition: WorkflowDefinition,
  wrapperId: string,
  iteration: number,
): Promise<Record<string, string>> {
  const consumed: Record<string, string> = {}
  // Sorted for a deterministic JSON key order (stable across re-mints).
  const sources = [...wrapperExternalUpstreamSources(wrapperId, definition)].sort()
  for (const sourceNodeId of sources) {
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, sourceNodeId)))
    const run = pickUpstreamSourceRun(rows, iteration)
    if (run !== undefined) consumed[sourceNodeId] = run.id
  }
  return consumed
}

async function persistWrapperProgress(
  db: DbClient,
  wrapperRunId: string,
  progress: WrapperProgress,
): Promise<void> {
  await db
    .update(nodeRuns)
    .set({ wrapperProgressJson: encodeWrapperProgress(progress) })
    .where(eq(nodeRuns.id, wrapperRunId))
}

/**
 * RFC-230 PR-2 — 三个 wrapper 分派点的共同外壳：把 `WrapperSupersededSignal`
 * 收敛成 scope 结果。放在这一个位置而不是 15 个 markWrapperTerminal 调用点各判
 * 一次，是为了让「收尾撞上外部终态」只有一条出口，漏改一个分支不可能发生。
 */
async function runWrapperNode(
  state: SchedulerState,
  args: OneNodeArgs,
  run: (state: SchedulerState, args: OneNodeArgs) => Promise<OneNodeResult>,
): Promise<OneNodeResult> {
  try {
    return await run(state, args)
  } catch (err) {
    if (err instanceof WrapperSupersededSignal) return err.outcome
    throw err
  }
}

/**
 * RFC-230 PR-2 — wrapper 收尾时发现自己那行已被外部**合法**终态抢先（用户取消 /
 * 诊断修复 / 孤儿回收）时抛出的信号。在 wrapper 分派点（runWrapperNode）统一转成
 * scope 结果，而不是让 ConflictError 一路冒泡成任务级 `scheduler error` —— 那条
 * 报错说的是「两个写者对同一行的真相不一致」，但取消与修复本来就有权先落定，
 * 真相并不冲突，冲突的是收尾逻辑假设自己是唯一写者。
 *
 * 只有 canceled / interrupted 走这条路。其余非法转移（例如已 done 又要写 failed）
 * 仍然大声抛出：那才是真正的数据不一致，不能被收敛掩盖。
 */
class WrapperSupersededSignal extends Error {
  constructor(readonly outcome: OneNodeResult) {
    super(outcome.message)
    this.name = 'WrapperSupersededSignal'
  }
}

/**
 * 只有这两类错误可能是「别人合法地先落定了这一行」：
 *   - `illegal-node-run-transition` —— 读到的当前状态已是终态，守卫拒写；
 *   - `concurrent-node-run-transition` —— 读到非终态但 CAS 被人抢走。
 * DB 故障、NotFound、以及任何别的异常都不属于这一类，必须原样抛。
 */
function isSupersedableTransitionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'illegal-node-run-transition' || code === 'concurrent-node-run-transition'
}

/** 外部抢先的终态 → 本 scope 应当收敛到的结果；不是可收敛的终态则 null（原样抛）。 */
async function supersedingWrapperOutcome(
  db: DbClient,
  wrapperRunId: string,
): Promise<OneNodeResult | null> {
  const [cur] = await db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, wrapperRunId))
  if (cur === undefined) return null
  if (cur.status === 'canceled') {
    return {
      kind: 'canceled',
      summary: 'wrapper canceled while finalizing',
      message: 'wrapper-superseded-canceled',
    }
  }
  if (cur.status === 'interrupted') {
    // interrupted 是可 resume 的终态；任务收在 failed（同样可 resume），而不是
    // 假装成功 done —— 后者会让一段被外部打断的工作以绿色收场。
    return {
      kind: 'failed',
      summary: 'wrapper interrupted while finalizing',
      message: 'wrapper-superseded-interrupted',
    }
  }
  return null
}

async function markWrapperTerminal(
  db: DbClient,
  wrapperRunId: string,
  status: 'done' | 'failed' | 'canceled' | 'exhausted',
  errorMessage?: string,
): Promise<void> {
  // RFC-053: wrapper finalize is a runtime-determined transition into one of
  // four terminal states. 'running' is the typical legal source — RFC-098 B3
  // (audit S-28) marks every wrapper row running right after its fresh mint
  // (and the resume path always flips running first), so 'pending' is no
  // longer a reachable source here and was removed from allowedFrom; the only
  // surviving pending rows are daemon-crash orphans, which the boot reaper
  // flips to interrupted without passing through this function. awaiting_* is
  // still legal when a wrapper bubbled up an awaiting child and is now being
  // short-circuited by cancel.
  try {
    await setNodeRunStatus({
      db,
      nodeRunId: wrapperRunId,
      to: status,
      allowedFrom: ['running', 'awaiting_review', 'awaiting_human'],
      reason: 'wrapper-finalize',
      extra: {
        finishedAt: Date.now(),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      },
    })
  } catch (err) {
    // RFC-230 PR-2: 外部终态抢先 → 收敛。
    //
    // 只认这两类错误（Codex 设计门 P2-3）：终态守卫拒写、以及 CAS 丢失。
    // 捕获**任意**异常然后「重读一眼状态恰好是终态就收敛」，会在底层 DB 故障 /
    // NotFound 时把原始错误吞掉——那是把两种完全不同的失败混成一种。
    if (!isSupersedableTransitionError(err)) throw err
    const outcome = await supersedingWrapperOutcome(db, wrapperRunId)
    if (outcome === null) throw err
    // 先清 reuseDisabled 再抛信号：那个 flag 留着会永久禁掉这条 resume 血脉的
    // done-shard 复用。
    await clearWrapperReuseDisabled(db, wrapperRunId)
    createLogger('scheduler').info('wrapper finalize superseded by external terminal state', {
      wrapperRunId,
      attempted: status,
      outcome: outcome.message,
    })
    throw new WrapperSupersededSignal(outcome)
  }
  // Note: wrapperProgressJson is left in place after terminal transitions —
  // it's debug breadcrumb for "where did this wrapper park last" and is
  // never read again by the scheduler once status is terminal…
  //
  // …with ONE exception (RFC-098 B3, audit S-20 / adversarial-review revision
  // #7): the fanout `reuseDisabled` gate must be CLEARED here. By the time a
  // wrapper goes terminal, every shard owns a row from the disabled
  // generation (fail-all-after-join runs all shards to completion; cancel
  // joins too), so those rows are the freshest per shardKey and reuse is safe
  // again — leaving the flag set would permanently disable done-shard reuse
  // for this row's resume lineage. Only the flag is stripped; the rest of the
  // payload stays as breadcrumb.
  await clearWrapperReuseDisabled(db, wrapperRunId)
}

/** 见上：终态到达后必须剥掉 fanout 的 `reuseDisabled` 闸门，其余 payload 留作面包屑。 */
async function clearWrapperReuseDisabled(db: DbClient, wrapperRunId: string): Promise<void> {
  const [terminalRow] = await db
    .select({ wrapperProgressJson: nodeRuns.wrapperProgressJson })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, wrapperRunId))
  const progress = decodeWrapperProgress(terminalRow?.wrapperProgressJson, () => {})
  if (progress !== null && progress.reuseDisabled === true) {
    const { reuseDisabled: _cleared, ...rest } = progress
    await persistWrapperProgress(db, wrapperRunId, rest as WrapperProgress)
  }
}

// -----------------------------------------------------------------------------
// wrapper-loop (P-4-01) — RFC-040 makes it bubble awaiting_* and resumable.
// -----------------------------------------------------------------------------

type LoopCompletionReason = 'exit-condition' | 'max-iterations-continued'

/**
 * RFC-236: both loop success policies share one completion path. In particular,
 * reaching the iteration limit with continueOnMaxIterations=true must promote
 * the same content/kind/archive row and merge the same loop-private canonical
 * as an ordinary exit-condition success.
 */
async function completeLoopWrapperIteration(args: {
  state: SchedulerState
  node: WorkflowNode
  wrapperRunId: string
  wrapperIso: IsoHandle
  bindings: readonly Binding[]
  iteration: number
  maxIterations: number
  reason: LoopCompletionReason
  log: Logger
}): Promise<OneNodeResult> {
  const { state, node, wrapperRunId, wrapperIso, bindings, iteration, maxIterations, reason, log } =
    args
  const { db, taskId } = state

  for (const binding of bindings) {
    const value = await readPortRowAtIteration(
      db,
      taskId,
      binding.bind.nodeId,
      binding.bind.portName,
      iteration,
    )
    await upsertWrapperOutput(
      db,
      wrapperRunId,
      binding.name,
      value.content,
      value.kind,
      value.archiveJson,
      // RFC-306 D9: inheritance across the loop boundary.
      value.active,
    )
  }

  // RFC-130 T12: merge the loop's total (all-iterations) delta back into the
  // task canonical as one unit for both ordinary and policy-controlled success.
  if (!wrapperIso.passthrough) {
    const merge = await mergeBackWrapperIso(state, wrapperIso, wrapperRunId, node, iteration, log)
    if (merge.kind === 'conflict-human') {
      return {
        kind: 'awaiting_human',
        summary: `loop merge conflict: ${merge.detail}`,
        message: 'merge-conflict',
      }
    }
    if (merge.kind === 'merge-failed') {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `wrapper-merge-failed:${merge.msg}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `loop merge-back failed: ${merge.msg}`,
        message: 'wrapper-merge-failed',
      }
    }
  }

  await markWrapperTerminal(db, wrapperRunId, 'done')
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
  if (reason === 'max-iterations-continued') {
    log.warn('wrapper-loop reached max iterations and continued by policy', {
      code: 'wrapper-loop-max-iterations-continued',
      taskId,
      nodeId: node.id,
      wrapperRunId,
      iteration,
      maxIterations,
    })
  }
  return { kind: 'ok', summary: '', message: '' }
}

async function runLoopWrapperNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId, definition } = state
  const { node, iteration: parentIteration, log } = args
  const inner = pickStringArray(node, 'nodeIds')
  if (inner.length === 0) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} has no inner nodes`,
      message: 'wrapper-empty',
    }
  }
  const maxIter = pickNumber(node, 'maxIterations')
  if (maxIter === undefined || maxIter < 1) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} missing maxIterations`,
      message: 'wrapper-loop-max-iterations',
    }
  }
  const continueOnMaxIterations = readContinueOnMaxIterations(node)
  if (continueOnMaxIterations === null) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} continueOnMaxIterations must be a boolean`,
      message: 'wrapper-loop-continue-on-max-iterations',
    }
  }
  const cond = parseExitCondition((node as Record<string, unknown>).exitCondition)
  if (cond === null) {
    return {
      kind: 'failed',
      summary: `wrapper-loop ${node.id} invalid exitCondition`,
      message: 'wrapper-loop-exit-condition',
    }
  }
  const bindings = readBindings(node, 'outputBindings')

  // RFC-040 resume detection: if the dispatcher re-entered us after we
  // previously bubbled awaiting_*, reuse our prior wrapper row and pick up
  // at the persisted iteration. The user answered clarify / decided review
  // while we were parked; the inner runScope's deriveFrontier sees the
  // freshly-minted agent rerun row inside iter N (the wrapper itself was
  // re-dispatched because wrapperHasFreshInnerWork saw that pending row —
  // dispatchFrontier.ts; the old rescanScopeForNewPendingRows this comment
  // used to cite was deleted in RFC-076, comment fixed by RFC-094 S-26).
  const existing = await findResumableWrapperRun(db, taskId, node.id, parentIteration)
  let wrapperRunId: string
  let startIter = 0
  if (existing !== null) {
    const progress = decodeWrapperProgress(existing.wrapperProgressJson, (msg) => log.warn(msg))
    wrapperRunId = existing.id
    if (progress?.kind === 'loop' && typeof progress.iteration === 'number') {
      startIter = progress.iteration
    } else {
      // Malformed / missing payload — observable regression to "start over",
      // but at least we don't double-mint a wrapper row. decodeWrapperProgress
      // already logged a warn if applicable.
      startIter = 0
    }
    if (existing.status !== 'running') {
      // RFC-053: wrapper enter-running — resumes from awaiting_* / pending.
      await setNodeRunStatus({
        db,
        nodeRunId: wrapperRunId,
        to: 'running',
        allowedFrom: ['pending', 'awaiting_review', 'awaiting_human', 'interrupted', 'canceled'],
        // Daemon-restart resume legitimately overwrites the reaped 'interrupted'
        // wrapper row (wrappers reuse their row on resume per RFC-040, unlike
        // agent nodes which mint a fresh retry row); RFC-095 extends the same
        // continue-not-restart semantics to 'canceled' (task-cancel revival via
        // retryNode, audit S-22). Both are terminal statuses, so
        // setNodeRunStatus's terminal guard would otherwise refuse;
        // allowTerminal bypasses that guard while allowedFrom still restricts the
        // legal source set. See scheduler-boundary-wrapper-resume-interrupted.test.ts.
        allowTerminal: true,
        reason: 'wrapper-resume',
      })
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    }
    // RFC-098 B3 (audit S-7, revision #6): resume deliberately does NOT
    // (re-)write consumedUpstreamRunsJson — see computeWrapperConsumed's
    // failure-mode ledger. The fresh-mint stamp below is the only write.
  } else {
    // RFC-098 B3 (audit S-7): stamp external-upstream provenance at fresh
    // mint, mirroring the fanout wrapper (RFC-074 §8 D3) — an upstream rerun
    // now demotes this wrapper's done row to stale and the loop re-runs from
    // iteration 0 on the next dispatch.
    const consumed = await computeWrapperConsumed(db, taskId, definition, node.id, parentIteration)
    wrapperRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'wrapper-init',
      iteration: parentIteration,
      overrides: { consumedUpstreamRunsJson: JSON.stringify(consumed) },
    })
    // RFC-098 B3 (audit S-28): flip the freshly-minted row pending→running
    // BEFORE the broadcast (DB-first rule, lifecycle.ts) and before any
    // reachable markWrapperTerminal — the DB row and the WS 'running' ping
    // must never disagree (scheduler-audit-s07-s28 locks the pairing).
    await transitionNodeRunStatus({ db, nodeRunId: wrapperRunId, event: { kind: 'mark-running' } })
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
  }

  // RFC-130 T12 (D29): loop-PRIVATE canonical — the loop's inner iterations run in a
  // loop-canonical (iso worktree of the loop), so cross-iteration state accumulates
  // there ISOLATED from sibling merge-backs into the task canonical; the loop's total
  // delta merges back as ONE unit when it exits (§8.2). Passthrough (non-git harness)
  // → runs on the task canonical as before. Kept across a park; rebuilt on resume.
  const wrapperIso = await createOrRebuildWrapperIso(state, wrapperRunId, existing)
  const innerState: SchedulerState = wrapperIso.passthrough
    ? state
    : {
        ...state,
        repos: wrapperIso.repos.map((r, i) => ({
          // iso 仓按下标与 canonical 对齐，repoIndex 直接沿用。
          repoIndex: i,
          repoPath: r.repoPath,
          worktreePath: r.isoWorktreePath,
          worktreeDirName: r.worktreeDirName,
          // RFC-248: iso 仓由 `canonRepos: state.repos` 派生，**按下标对齐**，
          // 所以挂载路径与只读标记要从 state 那侧取真值——iso 句柄本身只带
          // worktreeDirName，用它当 mountPath 在组任务里就丢了嵌套信息。
          mountPath: state.repos[i]?.mountPath ?? r.worktreeDirName,
          readonly: state.repos[i]?.readonly ?? false,
          baseBranch: r.baseBranch,
          // RFC-187 §4 — a wrapper-iso repo's base is the commit it forked from.
          baseCommit: r.baseSnapshot,
        })),
        // RFC-193 D9: inner nodes' scope canonical is the loop-canonical
        // container (== repos[0] iso root when single-repo, dirName='').
        scopeRoot: wrapperIso.containerPath,
      }

  const innerSet = new Set(inner)
  for (let i = startIter; i < maxIter; i++) {
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'loop',
      iteration: i,
      phase: 'inner-running',
    })

    const subRes = await runScope(innerState, {
      scopeId: node.id,
      scopeIds: innerSet,
      iteration: i,
      log: log.child(`loop:${node.id}`),
    })
    if (subRes.kind === 'canceled') {
      await markWrapperTerminal(db, wrapperRunId, 'canceled')
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
      return { kind: 'canceled', summary: subRes.detail?.summary ?? 'canceled', message: '' }
    }
    if (subRes.kind === 'failed') {
      await markWrapperTerminal(
        db,
        wrapperRunId,
        'failed',
        subRes.detail?.message ?? 'inner failed',
      )
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: subRes.detail?.summary ?? `wrapper-loop ${node.id} inner failed`,
        message: subRes.detail?.message ?? 'inner failed',
      }
    }
    // RFC-040: bubble awaiting_* up. Wrapper stays non-terminal; its status
    // mirrors the inner park so the task chip reads "awaiting human/review".
    if (subRes.kind === 'awaiting_human' || subRes.kind === 'awaiting_review') {
      await persistWrapperProgress(db, wrapperRunId, {
        kind: 'loop',
        iteration: i,
        phase: 'awaiting',
      })
      const newStatus = subRes.kind === 'awaiting_human' ? 'awaiting_human' : 'awaiting_review'
      // RFC-053: wrapper bubbles inner awaiting_* — park-human / park-review
      // enforces pending|running → awaiting_*.
      await transitionNodeRunStatus({
        db,
        nodeRunId: wrapperRunId,
        event: subRes.kind === 'awaiting_human' ? { kind: 'park-human' } : { kind: 'park-review' },
      })
      broadcastNodeStatus(taskId, wrapperRunId, node.id, newStatus)
      return {
        kind: subRes.kind,
        summary: subRes.detail?.summary ?? '',
        message: subRes.detail?.message ?? '',
      }
    }

    // subRes.kind === 'ok' — evaluate exit condition for this iteration.
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'loop',
      iteration: i,
      phase: 'iter-done',
    })
    // RFC-306: the exit rule now sees ACTIVATION as well as content, so a loop
    // can exit on "the body closed this branch" (`port-inactive`) instead of
    // having to encode that as an empty string.
    const portRow = await readPortRowAtIteration(db, taskId, cond.nodeId, cond.portName, i)
    if (evaluateExitCondition(cond, { content: portRow.content, active: portRow.active })) {
      return completeLoopWrapperIteration({
        state,
        node,
        wrapperRunId,
        wrapperIso,
        bindings,
        iteration: i,
        maxIterations: maxIter,
        reason: 'exit-condition',
        log,
      })
    }
  }

  if (continueOnMaxIterations) {
    return completeLoopWrapperIteration({
      state,
      node,
      wrapperRunId,
      wrapperIso,
      bindings,
      iteration: maxIter - 1,
      maxIterations: maxIter,
      reason: 'max-iterations-continued',
      log,
    })
  }

  // Exhausted: max iterations without exit.
  await markWrapperTerminal(db, wrapperRunId, 'exhausted', 'max iterations reached')
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'exhausted')
  return {
    kind: 'failed',
    summary: `wrapper-loop ${node.id} exhausted after ${maxIter} iterations`,
    message: 'wrapper-loop-exhausted',
  }
}

// -----------------------------------------------------------------------------
// wrapper-fanout (RFC-060) — fan a list<T> shardSource into N parallel inner
// dispatches, optionally aggregated by an inner role='aggregator' agent.
//
// PR-D v1 inner-kind support: agent-single only. agent-multi / wrapper-*
// / review / clarify / clarify-cross-agent / output / input inside a
// wrapper-fanout's inner subgraph are PR-D2 scope and fail at runtime with
// `wrapper-fanout-v1-unsupported-inner-kind` (the user gets a clear error
// rather than silent wrong behavior). The validator emits a static warning
// for the nested wrapper-fanout case; runtime rejection here is the
// secondary safety net.
//
// Lifecycle (RFC-053 compatible — D.T8):
//   pending → running → done | failed
// Shard child rows are minted with parentNodeRunId=wrapperRunId so they
// don't bubble into latestPerNode of the wrapper's parent scope.
// -----------------------------------------------------------------------------

/**
 * RFC-223 (PR-3a impl-gate H2): the CANONICAL dedup / lookup key for a
 * wrapper-fanout inner agent node — its stamped `agentId`. Used by BOTH the
 * inner-agent-map hydration and per-shard dispatch. A name-only node returns
 * null and fails closed.
 */
export function fanoutInnerAgentKey(node: {
  agentId?: unknown
  agentName?: unknown
}): string | null {
  // RFC-271 T6d：判据收到 `services/ref/runtimeRef.ts` 的单一读取点。
  // 语义与返回值逐字不变——name-only 节点仍返回 null 并 fail closed。
  return fanoutInnerAgentRefKey(node)
}

async function runFanoutWrapperNode(
  state: SchedulerState,
  args: OneNodeArgs,
): Promise<OneNodeResult> {
  const { db, taskId, definition, opts, log: stateLog } = state
  const { node, iteration, log } = args

  // 1. Schema-shape validation (defensive — validator catches most pre-run).
  const rec = node as Record<string, unknown>
  const inputs = Array.isArray(rec.inputs) ? (rec.inputs as WrapperFanoutPort[]) : []
  const shardPort = inputs.find((p) => p?.isShardSource === true)
  if (shardPort === undefined) {
    return {
      kind: 'failed',
      summary: `wrapper-fanout ${node.id} missing shardSource input`,
      message: 'wrapper-fanout-shard-source-missing',
    }
  }
  const parsedKind = tryParseKind(shardPort.kind)
  if (parsedKind === null || parsedKind.kind !== 'list') {
    return {
      kind: 'failed',
      summary: `wrapper-fanout ${node.id} shardSource port '${shardPort.name}' kind '${shardPort.kind}' must be list<T>`,
      message: 'wrapper-fanout-shard-source-not-list',
    }
  }
  const itemKind = parsedKind.item
  const innerIds = pickStringArray(node, 'nodeIds')
  if (innerIds.length === 0) {
    return {
      kind: 'failed',
      summary: `wrapper-fanout ${node.id} has no inner nodes`,
      message: 'wrapper-empty',
    }
  }

  // 2. Hydrate the inner-node agent map. findFanoutAggregator + scope
  // computation both consult this. Missing-agent here is fatal.
  // RFC-223 (PR-2/PR-3a impl-gate H2): resolve + dedup + key each inner agent by
  // its CANONICAL identity — the required agentId (rename-/ABA-safe). The old
  // dedup keyed by NAME (`agentsMap.has(an)`), which collapsed two same-name
  // DIFFERENT-id inner nodes into one — the second was skipped and both then
  // dispatched under the FIRST node's agent. Keying dedup + the map entry by the
  // canonical key keeps distinct-id inner nodes distinct; the shared
  // `resolveNodeAgent` (findFanoutAggregator / scope) and the per-shard dispatch
  // below both look up by that same key.
  const agentsMap = new Map<string, Agent>()
  for (const id of innerIds) {
    const inner = definition.nodes.find((n) => n.id === id)
    if (inner === undefined) continue
    const rec = inner as Record<string, unknown>
    // RFC-271 T6d：此处原本内联重算了一遍与 `fanoutInnerAgentKey` 完全相同的判据
    // （紧接着的下一行又调了它），现在只留一次。
    const dedupKey = fanoutInnerAgentKey(rec)
    if (dedupKey === null || agentsMap.has(dedupKey)) continue
    // ⚠️ 归属：hydration **静默跳过**缺失/查不到的 ref（FANOUT_HYDRATE_CALL_POLICY），
    // 与主派发的「节点失败」不同——这是实测差异，不是笔误。
    const resolved = await resolveNodeAgentRef(db, rec, FANOUT_HYDRATE_CALL_POLICY)
    if (resolved.ok) agentsMap.set(dedupKey, resolved.value)
  }

  // 3. Wrapper row resume / mint (mirrors wrapper-git pattern).
  const existing = await findResumableWrapperRun(db, taskId, node.id, iteration)
  let wrapperRunId: string
  if (existing !== null) {
    wrapperRunId = existing.id
    if (existing.status !== 'running') {
      await setNodeRunStatus({
        db,
        nodeRunId: wrapperRunId,
        to: 'running',
        allowedFrom: ['pending', 'awaiting_review', 'awaiting_human', 'interrupted', 'canceled'],
        // Daemon-restart resume legitimately overwrites the reaped 'interrupted'
        // wrapper row (wrappers reuse their row on resume per RFC-040, unlike
        // agent nodes which mint a fresh retry row); RFC-095 extends the same
        // continue-not-restart semantics to 'canceled' (task-cancel revival via
        // retryNode, audit S-22). Both are terminal statuses, so
        // setNodeRunStatus's terminal guard would otherwise refuse;
        // allowTerminal bypasses that guard while allowedFrom still restricts the
        // legal source set. See scheduler-boundary-wrapper-resume-interrupted.test.ts.
        allowTerminal: true,
        reason: 'wrapper-fanout-resume',
      })
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    }
  } else {
    wrapperRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'wrapper-init',
      iteration,
    })
    // RFC-098 B3 (audit S-28): mark-running immediately after the mint — it
    // must precede EVERY reachable markWrapperTerminal below (empty-source
    // short-circuit done, cartesian guard, inner/agent-missing failures) so
    // their from='running' is legal, and precede the broadcast (DB-first
    // rule, lifecycle.ts).
    await transitionNodeRunStatus({ db, nodeRunId: wrapperRunId, event: { kind: 'mark-running' } })
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
  }

  // 4. Read shardSource content via upstream resolution. Boundary-input edges
  // (source.nodeId = wrapper) are NOT involved here — those edges connect the
  // wrapper's own input ports to inner nodes; the upstream shardSource value
  // arrives at the wrapper via a regular edge (target.nodeId = wrapper.id,
  // target.portName = shardPort.name).
  const { inputs: upstreamInputs, consumed: wrapperConsumed } = await resolveUpstreamInputs(
    db,
    taskId,
    definition.edges,
    node.id,
    iteration,
    log,
    definition,
    state.containerOf,
  )
  const rawContent = upstreamInputs[shardPort.name] ?? ''

  // RFC-098 B3 (audit S-20 + adversarial-review revision #7) — consumed
  // GENERATION GATE, evaluated BEFORE the provenance overwrite below (the
  // overwrite is exactly what used to erase the mismatch evidence). When the
  // previously recorded consumed map differs from the freshly resolved one,
  // an external upstream re-ran while this wrapper was parked/failed — the
  // prior generation's done shard rows may be stale in ways the per-shard
  // value hash cannot see (path-family shard values are bare path strings),
  // so done-row reuse is disabled for this entire pass (full re-run).
  let reuseDisabled = false
  let priorConsumedRaw: string | null = null
  if (existing !== null) {
    // Resume: compare against the row's own previously recorded consumed, and
    // honor the PERSISTED gate (revision #7 crash-resume backdoor: a crashed
    // disabled run has already overwritten the consumed column, so the
    // comparison alone would wrongly pass on resume).
    priorConsumedRaw = existing.consumedUpstreamRunsJson
    const persisted = decodeWrapperProgress(existing.wrapperProgressJson, (msg) =>
      log.warn(msg, { taskId, nodeId: node.id }),
    )
    if (persisted !== null && persisted.reuseDisabled === true) reuseDisabled = true
  } else {
    // Fresh mint: cross-generation shard reuse replays the PREVIOUS
    // generation's children, so ITS recorded consumed is the comparison base.
    // Rows with NULL consumed are skipped (retryNode's inert placeholder rows
    // never ran and record nothing; legacy rows predate provenance) — absent
    // evidence is treated as MATCH, mirroring the hash NULL=match policy.
    const priorGenRows = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, node.id),
          eq(nodeRuns.iteration, iteration),
        ),
      )
    const priorGen = pickFreshestRun(
      priorGenRows.filter((r) => r.id !== wrapperRunId && r.consumedUpstreamRunsJson !== null),
      { topLevelOnly: true },
    )
    priorConsumedRaw = priorGen?.consumedUpstreamRunsJson ?? null
  }
  if (
    priorConsumedRaw !== null &&
    !consumedMapsEqual(parseConsumedJson(priorConsumedRaw), wrapperConsumed)
  ) {
    reuseDisabled = true
  }
  if (reuseDisabled) {
    // Persist BEFORE overwriting consumed: a crash between the two writes
    // re-derives the same verdict on resume (the comparison still trips); a
    // crash AFTER the overwrite is covered by this persisted flag. Cleared by
    // markWrapperTerminal once the wrapper reaches a terminal state.
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'fanout',
      phase: 'inner-running',
      reuseDisabled: true,
    })
  }

  // RFC-074 §8 (D3): the fan-out wrapper is provenance-atomic — record which
  // upstream runs the wrapper consumed on the wrapper row so freshness can
  // re-run the whole wrapper when an upstream advances. Inner shard rows do NOT
  // record provenance (treated as fresh within this wrapper run). RFC-098 B3:
  // this overwrite intentionally happens AFTER the generation gate above.
  await db
    .update(nodeRuns)
    .set({ consumedUpstreamRunsJson: JSON.stringify(wrapperConsumed) })
    .where(eq(nodeRuns.id, wrapperRunId))

  // 5. Derive wrapper outlets (aggregator outputs OR __done__ signal).
  const derivedOutputs = deriveWrapperFanoutOutputs(definition, node.id, agentsMap)

  // 6. Empty source: short-circuit done with empty outlets.
  // RFC-103 T4 (05-PORT-06/07): split via the single-source listWire codec,
  // kind-aware — `list<markdown>` items are inline multi-line bodies framed by
  // MARKDOWN_DOC_BOUNDARY; `list<path<md>>` / `list<string>` are one-per-line.
  // Hand-rolling `.split('\n')` here shredded each markdown document per line.
  // RFC-317 T57（findings NK-01）—— codec 选择收进 handler（`splitPortItems`）。
  // 这里的分支本身是对的，但它是**第三份**独立判据：另两处（list.ts 的 validate、
  // portArtifacts）当时忘了分支，于是同一份内容落库时按行切、分片时按边界行切。
  // 走同一个入口之后，"这个 kind 怎么切" 只有一个答案。
  const items = splitPortItems(itemKind, rawContent)
  if (items.length === 0) {
    for (const port of derivedOutputs) {
      await upsertWrapperOutput(db, wrapperRunId, port.name, '')
    }
    await markWrapperTerminal(db, wrapperRunId, 'done')
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
    return { kind: 'ok', summary: '', message: 'wrapper-fanout-empty' }
  }

  // 7. Cartesian guard (D.T6). Multiplies through nested wrapper-fanout's
  // expectedShardCount (estimateShardTotal) so the user gets a bounded
  // failure rather than a flood of node_runs.
  const maxAllowed = opts.fanoutMaxShardTotal ?? 256
  const projectedTotal = estimateShardTotal(definition, node.id, items.length)
  if (projectedTotal > maxAllowed) {
    await markWrapperTerminal(
      db,
      wrapperRunId,
      'failed',
      `cartesian-exceeds-max:${projectedTotal}>${maxAllowed}`,
    )
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
    return {
      kind: 'failed',
      summary: `wrapper-fanout ${node.id} would mint ${projectedTotal} shards > limit ${maxAllowed}`,
      message: `wrapper-fanout-cartesian-exceeds-max:${projectedTotal}`,
    }
  }

  // 8. Compute shard scope (D.T1) + apply auto-promote.
  let scope = computeShardScope({ wrapperId: node.id, defn: definition, agents: agentsMap })
  scope = applyAutoPromote(scope, definition)

  // 9. Build shards with per-item shardKey (resolveKeyOf — path-family uses
  // the path itself, others default to 0-based index).
  const keyOf = resolveKeyOf(itemKind)
  // Disambiguate colliding shardKeys (e.g. duplicate path items, whose
  // path-family key IS the path string) by suffixing the index, so every item
  // gets a UNIQUE shard identity. Without this, two equal items mint two
  // children with the same shardKey and the aggregator's find-by-shardKey drops
  // one. See scheduler-boundary-fanout-shardkey-collision.test.ts.
  const seenShardKeys = new Set<string>()
  const shards = items.map((value, idx) => {
    let shardKey = keyOf(value, idx, itemKind)
    if (seenShardKeys.has(shardKey)) shardKey = `${shardKey}#${idx}`
    seenShardKeys.add(shardKey)
    return { shardKey, value }
  })

  // 10. Dispatch each inner node (skip aggregator — handled last).
  for (const innerId of innerIds) {
    const inner = definition.nodes.find((n) => n.id === innerId)
    if (inner === undefined) {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-missing:${innerId}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper-fanout ${node.id} inner node '${innerId}' not found in definition`,
        message: `wrapper-fanout-inner-missing:${innerId}`,
      }
    }
    if (innerId === scope.aggregatorId) continue

    if (inner.kind !== 'agent-single') {
      await markWrapperTerminal(
        db,
        wrapperRunId,
        'failed',
        `v1-unsupported-inner-kind:${inner.kind}`,
      )
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper-fanout ${node.id} inner '${innerId}' kind '${inner.kind}' — v1 supports agent-single only inside wrapper-fanout (PR-D2 will extend support)`,
        message: `wrapper-fanout-v1-unsupported-inner-kind:${inner.kind}`,
      }
    }

    const innerRec = inner as Record<string, unknown>
    const innerAgentName =
      typeof innerRec.agentName === 'string' ? innerRec.agentName : `node:${innerId}`
    const innerAgentId = fanoutInnerAgentKey(innerRec)
    if (innerAgentId === null) {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-missing-agentId:${innerId}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper-fanout ${node.id} inner '${innerId}' missing canonical agentId`,
        message: 'wrapper-fanout-inner-missing-agent-id',
      }
    }
    const innerAgent = agentsMap.get(innerAgentId)
    if (innerAgent === undefined) {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-agent-missing:${innerAgentName}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper-fanout ${node.id} inner agent '${innerAgentName}' not found`,
        message: `agent-not-found:${innerAgentName}`,
      }
    }

    // Per-shard boundary-input edges from THIS wrapper to THIS inner node.
    // Used to inject shard value into the inner's resolved inputs when an
    // edge binds wrapper.shardPort.name → inner.somePort.
    const boundaryEdges = findBoundaryEdgesToInner(definition, node.id, innerId)
    // RFC-074 §8: inner shard nodes do NOT record provenance (fresh within the
    // wrapper run); take only the resolved inputs.
    const { inputs: innerUpstream } = await resolveUpstreamInputs(
      db,
      taskId,
      definition.edges,
      innerId,
      iteration,
      log,
      definition,
      state.containerOf,
    )
    // Boundary inputs are structural mirrors and are deliberately excluded
    // from resolveUpstreamInputs. Inject every non-shard wrapper input as a
    // broadcast value here; dispatchFanoutShard replaces only the shard-source
    // target with the current item. This lets one per-shard node receive both
    // its item and shared context through explicit wrapper boundaries.
    for (const edge of boundaryEdges) {
      if (edge.source.portName === shardPort.name) continue
      const value = upstreamInputs[edge.source.portName] ?? ''
      const prior = innerUpstream[edge.target.portName]
      innerUpstream[edge.target.portName] =
        prior === undefined ? value : `${prior}\n\n---\n\n${value}`
    }

    if (scope.perShard.has(innerId)) {
      const shardResults = await Promise.all(
        shards.map((sh) =>
          dispatchFanoutShard({
            state,
            wrapperId: node.id,
            wrapperRunId,
            innerNode: inner,
            innerAgent,
            iteration,
            shard: sh,
            shardSourcePortName: shardPort.name,
            boundaryEdges,
            broadcastInputs: innerUpstream,
            reuseDisabled,
            log: log.child(`fanout:${node.id}:${innerId}`),
          }),
        ),
      )
      // Cancel takes precedence over failure: when the task was aborted, shards
      // come back 'canceled' (SIGTERM) — the wrapper row must reflect 'canceled',
      // not 'failed' (a canceled task should leave no 'failed' run). See
      // scheduler-boundary-canceled-fanout-status.test.ts.
      if (shardResults.some((r) => r.kind === 'canceled') || opts.signal?.aborted === true) {
        await markWrapperTerminal(db, wrapperRunId, 'canceled')
        broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
        return {
          kind: 'canceled',
          summary: `wrapper-fanout ${node.id} canceled`,
          message: 'canceled',
        }
      }
      const failedShards = shardResults.filter((r) => r.kind === 'failed')
      if (failedShards.length > 0) {
        const msg = failedShards.map((f) => `${f.shardKey}:${f.message}`).join(' | ')
        await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-shard-failed:${msg}`)
        broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
        return {
          kind: 'failed',
          summary: `wrapper-fanout ${node.id} inner '${innerId}' ${failedShards.length}/${shards.length} shards failed`,
          message: msg,
        }
      }
    } else {
      // Shared inner: dispatch once (no shardKey). Boundary-input edges from
      // the shardSource port don't make sense for shared inner nodes (a
      // shared node by definition isn't shard-aware); the validator should
      // already prevent that wiring — if it slipped through, the boundary
      // edge injection below still copies the first shard's value, which is
      // an acceptable degenerate behavior.
      const r = await dispatchFanoutShard({
        state,
        wrapperId: node.id,
        wrapperRunId,
        innerNode: inner,
        innerAgent,
        iteration,
        shard: null,
        shardSourcePortName: shardPort.name,
        boundaryEdges,
        broadcastInputs: innerUpstream,
        reuseDisabled,
        log: log.child(`fanout:${node.id}:${innerId}:shared`),
      })
      if (r.kind === 'canceled' || opts.signal?.aborted === true) {
        await markWrapperTerminal(db, wrapperRunId, 'canceled')
        broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
        return {
          kind: 'canceled',
          summary: `wrapper-fanout ${node.id} canceled`,
          message: 'canceled',
        }
      }
      if (r.kind === 'failed') {
        await markWrapperTerminal(db, wrapperRunId, 'failed', `inner-shared-failed:${r.message}`)
        broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
        return {
          kind: 'failed',
          summary: `wrapper-fanout ${node.id} inner shared '${innerId}' failed`,
          message: r.message,
        }
      }
    }
  }

  // 11. Aggregator dispatch (D.T3) — collect every perShard inner agent's
  // outputs into raw lists keyed by shardKey, dispatched once.
  if (scope.aggregatorId !== null) {
    const aggInfo = findFanoutAggregator(definition, node.id, agentsMap)
    if (aggInfo === null) {
      await markWrapperTerminal(db, wrapperRunId, 'failed', 'aggregator-resolve-failed')
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: 'aggregator agent resolution failed',
        message: 'aggregator-resolve-failed',
      }
    }
    const aggRes = await dispatchFanoutAggregator({
      state,
      wrapperId: node.id,
      wrapperRunId,
      aggNode: aggInfo.node,
      aggAgent: aggInfo.agent,
      iteration,
      shards,
      definition,
      scope,
      reuseDisabled,
      log: log.child(`fanout:${node.id}:aggregator`),
    })
    if (aggRes.kind === 'failed') {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `aggregator-failed:${aggRes.message}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return aggRes
    }
    // Propagate aggregator outputs → wrapper outlets, renamed by
    // outputWrapperPortNames where set (RFC-060 design §5.4).
    const renames = aggInfo.agent.outputWrapperPortNames ?? {}
    for (const port of aggInfo.agent.outputs) {
      const outletName = renames[port] ?? port
      const content = aggRes.outputs[port] ?? ''
      // RFC-193 D16: the aggregator run's row carries kind+archive reference
      // (runner wrote them) — the outlet projection must not drop them. The
      // aggregator run is a CHILD row (parentNodeRunId = wrapperRunId), so a
      // topLevelOnly picker never sees it (Codex impl-gate P1): read the exact
      // run the dispatch returned.
      const aggRows =
        aggRes.aggRunId !== undefined
          ? await db
              .select()
              .from(nodeRunOutputs)
              .where(
                and(
                  eq(nodeRunOutputs.nodeRunId, aggRes.aggRunId),
                  eq(nodeRunOutputs.portName, port),
                ),
              )
          : []
      const row = aggRows[0]
      // RFC-306 D9 (design-gate P1#5): the aggregator may itself declare a branch
      // port — that is how a decision made INSIDE a fanout leaves the wrapper.
      // Dropping `active` here silently re-opened the branch at the boundary, so
      // downstream ran with the aggregator's reason text as its input.
      await upsertWrapperOutput(
        db,
        wrapperRunId,
        outletName,
        content,
        row?.kind ?? null,
        row !== undefined && row.content === content ? (row.archiveJson ?? null) : null,
        row?.active !== false,
      )
    }
  } else {
    // No aggregator: emit the implicit __done__ signal outlet. Empty content;
    // downstream can chain on it but must NOT reference it inside {{...}} —
    // assertNoPromptSignalRefs (D.T7) catches that at prompt-render time.
    await upsertWrapperOutput(db, wrapperRunId, FANOUT_DONE_PORT_NAME, '')
  }

  await markWrapperTerminal(db, wrapperRunId, 'done')
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
  stateLog.info('wrapper-fanout done', {
    taskId,
    nodeId: node.id,
    shards: shards.length,
    hasAggregator: scope.aggregatorId !== null,
  })
  return { kind: 'ok', summary: '', message: '' }
}

interface ShardSpec {
  shardKey: string
  value: string
}

/**
 * RFC-098 B3 (audit S-20): sha256 hex of a fanout shard's value — the
 * cross-generation reuse identity stamped into `node_runs.shard_value_hash`
 * (migration 0043) and re-derived at dispatch time for the
 * pickReusableShardRun match. sha256Hex（@/util/hash）precedent: util/git.ts 同款单步 hash 收口。
 */

interface DispatchShardArgs {
  state: SchedulerState
  wrapperId: string
  wrapperRunId: string
  innerNode: WorkflowNode
  innerAgent: Agent
  iteration: number
  /** null = shared (broadcast) dispatch — no shardKey, runs once. */
  shard: ShardSpec | null
  shardSourcePortName: string
  boundaryEdges: WorkflowEdge[]
  broadcastInputs: Record<string, string>
  /**
   * RFC-098 B3 (audit S-20): the wrapper-entry consumed generation gate —
   * true forbids replaying ANY done prior row (this shard re-runs even when
   * its value hash matches). See runFanoutWrapperNode's gate block.
   */
  reuseDisabled: boolean
  /**
   * Internal process-retry attempt. When present, dispatch must mint a fresh
   * child row instead of replaying/resetting the failed same-generation row.
   */
  processRetryIndex?: number
  log: Logger
}

interface DispatchShardResult {
  kind: 'ok' | 'failed' | 'canceled'
  shardKey: string
  outputs: Record<string, string>
  message: string
  /** Present only when the failed attempt may consume process-retry budget. */
  retry?: {
    retryIndex: number
    failureCode: FailureCode | null
    processUnreaped?: true
  }
}

/**
 * Dispatch one agent-single inner node for one shard (or shared/broadcast
 * mode when `shard === null`). Mints a node_run row with shardKey +
 * parentNodeRunId=wrapperRunId, runs `runNode`, persists outputs.
 *
 * v1 limitations (PR-D2 will extend):
 *   - No clarify / review channel — the channel hooks are wired in by the
 *     scheduler's runOneNode single-agent branch; bringing that whole branch
 *     in here would duplicate ~500 lines. PR-D2's per-shard review (D.T4)
 *     and per-shard clarify (D.T5) will add the corresponding hand-offs.
 *   - No clarify / review channel. Process failures consume the same global
 *     retry budget as a top-level agent node; envelope follow-up remains a
 *     top-level-only optimization because fanout retries use fresh sessions.
 *     After retries, the wrapper keeps FAIL-ALL-AFTER-JOIN semantics
 *     (RFC-094 / audit S-18): every shard runs to completion, then ANY failed
 *     shard fails the whole wrapper and skips aggregation.
 */
async function dispatchFanoutShard(args: DispatchShardArgs): Promise<DispatchShardResult> {
  const maxRetries = args.state.opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
  let attemptArgs = args
  for (let retriesUsed = 0; ; retriesUsed++) {
    const result = await dispatchFanoutShardAttempt(attemptArgs)
    if (
      result.kind !== 'failed' ||
      result.retry === undefined ||
      retriesUsed >= maxRetries ||
      !shouldRetryNodeFailure(result.retry.failureCode, result.retry.processUnreaped === true)
    ) {
      return result
    }
    attemptArgs = {
      ...args,
      reuseDisabled: true,
      processRetryIndex: result.retry.retryIndex + 1,
    }
  }
}

async function dispatchFanoutShardAttempt(args: DispatchShardArgs): Promise<DispatchShardResult> {
  const {
    state,
    wrapperRunId,
    innerNode,
    innerAgent,
    iteration,
    shard,
    shardSourcePortName,
    boundaryEdges,
    broadcastInputs,
    log,
  } = args
  const { db, task, taskId, opts } = state

  const shardKey = shard?.shardKey ?? '__shared__'
  const rowShardKey = shard === null ? null : shardKey
  // Cross-generation reuse identity (S-20): sha256 of the shard VALUE. The
  // shared/broadcast dispatch has no per-shard value → NULL (matches any —
  // the consumed generation gate is the shared row's only content guard).
  const valueHash = shard === null ? null : sha256Hex(shard.value)

  // Idempotent (re)dispatch — RFC-098 B3 (audit S-19): candidates are anchored
  // on (taskId, innerNodeId, iteration, shardKey, parentNodeRunId IS NOT NULL),
  // RELAXED from the old "parentNodeRunId = this wrapperRunId" so a retried
  // wrapper generation (failed → resume mints a FRESH wrapperRunId) can replay
  // the previous generation's done children instead of re-running every shard.
  // The non-null parent filter keeps frontier invisibility intact (deriveFrontier
  // / buildFreshestSettledPerNode / pickFreshestRun all skip child rows) AND
  // excludes the top-level inert placeholder rows retryNode mints for inner
  // nodes. Three branches on the FRESHEST candidate (pure id-order):
  //   1. freshest is done + value-hash match (NULL=match, legacy rows) + reuse
  //      not disabled → replay its outputs without a spawn (same- OR cross-
  //      generation; the row keeps its original parent — history stays true).
  //   2. freshest is non-done and belongs to THIS wrapper generation → re-run
  //      it in place (the same-generation idempotency branch:
  //      scheduler-boundary-fanout-resume-duplicate-shards locks each shardKey
  //      to exactly ONE row under the resumed wrapper).
  //   3. anything else (no candidate / prior-generation non-done residue /
  //      done but hash-mismatched or reuse-disabled) → mint a fresh row under
  //      this wrapper, stamped with sha256(shard.value) (shared rows stay NULL).
  const candidates = (
    await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, innerNode.id),
          eq(nodeRuns.iteration, iteration),
          isNotNull(nodeRuns.parentNodeRunId),
        ),
      )
  ).filter((r) => (r.shardKey ?? null) === rowShardKey)
  const freshest = pickFreshestRun(candidates, { topLevelOnly: false })
  const forcedProcessRetry = args.processRetryIndex !== undefined
  const reusable =
    args.reuseDisabled || forcedProcessRetry
      ? undefined
      : pickReusableShardRun(candidates, { shardKey: rowShardKey, valueHash })
  let shardRunId: string
  let shardRetryIndex: number
  // RFC-130 §8.3 D9 (T14): when this dispatch RE-RUNS a shard whose prior attempt's
  // delta is already merged into canon, undo that prior delta INSIDE the fresh iso
  // (below, after createNodeIso, before the agent) so the rerun's output REPLACES the
  // prior output instead of superimposing on it. SINGLE REPLACEMENT LEVEL (Codex
  // impl-gate P1): only when EXACTLY ONE done+merged candidate exists — its persisted
  // base_snapshot is then the true pre-shard state. With ≥2 merged generations the
  // older row's base already carries an earlier delta, so a further undo would
  // resurrect stale files; we fall back to superimposition (== pre-T14 for that rare
  // 3rd+ generation, never destructive). Covers branch-2 resume too (the merged row is
  // an older candidate, not the non-done freshest). Passthrough rows keep NULL iso
  // columns → skipped. Applied only to the private iso — canon is never touched before
  // the rerun succeeds (AC-6). Branch 1 (reuse) returns before the iso is built.
  let priorShardUndo: { base: Record<string, string>; node: Record<string, string> } | null = null
  const doneMergedCandidates = candidates.filter(
    (c) => c.status === 'done' && c.mergeState === ('merged' satisfies MergeState),
  )
  if (doneMergedCandidates.length === 1) {
    const priorMergedRow = doneMergedCandidates[0]!
    const priorBase: Record<string, string> = {}
    const priorNode: Record<string, string> = {}
    if (task.repoCount === 1) {
      if (priorMergedRow.isoBaseSnapshot !== null) priorBase[''] = priorMergedRow.isoBaseSnapshot
      if (priorMergedRow.isoNodeTree !== null) priorNode[''] = priorMergedRow.isoNodeTree
    } else {
      Object.assign(priorBase, parseIsoJsonMap(priorMergedRow.isoBaseSnapshotReposJson))
      Object.assign(priorNode, parseIsoJsonMap(priorMergedRow.isoNodeTreeReposJson))
    }
    if (Object.keys(priorNode).length > 0) priorShardUndo = { base: priorBase, node: priorNode }
  }
  if (
    !forcedProcessRetry &&
    freshest !== undefined &&
    reusable !== undefined &&
    reusable.id === freshest.id
  ) {
    // Branch 1 — replay. The `reusable.id === freshest.id` guard refuses a
    // done row that has been SUPERSEDED by a fresher attempt of any status
    // (e.g. a user-targeted shard retry placeholder): replaying it would undo
    // that newer attempt's intent.
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, reusable.id))
    const outputs: Record<string, string> = {}
    for (const o of outRows) outputs[o.portName] = o.content
    broadcastNodeStatus(taskId, reusable.id, innerNode.id, 'done')
    return { kind: 'ok', shardKey, outputs, message: '' }
  }
  if (
    !forcedProcessRetry &&
    freshest !== undefined &&
    freshest.status !== 'done' &&
    freshest.parentNodeRunId === wrapperRunId
  ) {
    // Branch 2 — re-run the existing same-generation child in place.
    // allowTerminal: a reaped child is 'interrupted' (terminal); reset to
    // pending so runNode's mark-running (pending → running) applies cleanly.
    shardRunId = freshest.id
    await setNodeRunStatus({
      db,
      nodeRunId: shardRunId,
      to: 'pending',
      allowedFrom: ['pending', 'running', 'interrupted', 'failed', 'canceled'],
      allowTerminal: true,
      reason: 'fanout-shard-resume',
    })
    // The re-run consumes the CURRENT shard value — refresh the stored hash
    // so future reuse decisions compare against what actually ran.
    await db.update(nodeRuns).set({ shardValueHash: valueHash }).where(eq(nodeRuns.id, shardRunId))
    shardRetryIndex = freshest.retryIndex
  } else {
    // Branch 3 — mint a fresh row under this wrapper. The T14 replacement target
    // (priorShardUndo) was already derived above from the latest done+merged
    // candidate and is applied at merge-back.
    shardRunId = await mintNodeRun(db, {
      taskId,
      nodeId: innerNode.id,
      status: 'pending',
      cause: forcedProcessRetry ? 'process-retry' : 'fanout-shard',
      retryIndex: args.processRetryIndex ?? 0,
      iteration,
      overrides: {
        parentNodeRunId: wrapperRunId,
        shardKey: rowShardKey,
        shardValueHash: valueHash,
      },
    })
    shardRetryIndex = args.processRetryIndex ?? 0
  }
  broadcastNodeStatus(taskId, shardRunId, innerNode.id, 'pending')

  // Build inner inputs: broadcast first, then inject shard value for any
  // boundary-input edge that wires the wrapper's shardSource port into one
  // of the inner's input ports.
  const inputs: Record<string, string> = { ...broadcastInputs }
  if (shard !== null) {
    for (const e of boundaryEdges) {
      if (e.source.portName !== shardSourcePortName) continue
      inputs[e.target.portName] = shard.value
    }
  }

  // RFC-060 D.T7: build inputPortKinds from boundary edges so the runner can
  // refuse `{{port}}` references against signal-kind inputs. We look up each
  // boundary edge's source port on the wrapper itself to find its declared
  // kind (signal / list<T> / etc.) and stash that against the target
  // (inner's local) port name.
  const inputPortKinds: Record<string, string> = {}
  const wrapper = args.state.definition.nodes.find((n) => n.id === args.wrapperId)
  if (wrapper !== undefined && wrapper.kind === 'wrapper-fanout') {
    const wrapperInputs = ((wrapper as Record<string, unknown>).inputs ?? []) as WrapperFanoutPort[]
    for (const e of boundaryEdges) {
      const wp = wrapperInputs.find((p) => p.name === e.source.portName)
      if (wp !== undefined) {
        // For shardSource ports, the inner receives ONE item (the shard
        // value); the item's effective kind is the list's item kind, not
        // `list<T>`. For non-shard broadcast boundary ports, the kind is
        // the wrapper's declared input kind verbatim.
        if (wp.isShardSource === true) {
          const lk = tryParseKind(wp.kind)
          if (lk !== null && lk.kind === 'list') {
            // The shard item's effective kind is the list's ITEM kind, stringified
            // so the runner can re-parse it. Use the canonical stringifyKind rather
            // than a hand-rolled per-kind switch: the old inline version dropped a
            // nested list<list<...>> item to a bare 'list' (losing the inner kind);
            // stringifyKind round-trips path<md> / list<...> items intact.
            inputPortKinds[e.target.portName] = stringifyKind(lk.item)
          } else {
            inputPortKinds[e.target.portName] = wp.kind
          }
        } else {
          inputPortKinds[e.target.portName] = wp.kind
        }
      }
    }
  }

  const injection = await resolveInjection(db, innerAgent, { appHome: opts.appHome, log })
  if (injection.kind === 'failed') {
    await setNodeRunStatus({
      db,
      nodeRunId: shardRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'fanout-shard-injection-failed',
      extra: { finishedAt: Date.now(), errorMessage: injection.message },
    })
    broadcastNodeStatus(taskId, shardRunId, innerNode.id, 'failed')
    return { kind: 'failed', shardKey, outputs: {}, message: injection.message }
  }
  const promptTemplate = pickString(innerNode, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = opts.defaultPerNodeTimeoutMs

  // RFC-130: each fan-out shard runs in its OWN isolated worktree (no shared-worktree
  // writeSem serialization — shards run truly in parallel up to global/subprocess
  // caps and merge their deltas back one at a time). Shards usually touch DIFFERENT
  // files (per-file / per-dir sharding), so merge-backs rarely conflict.
  // RFC-287 T4：分片线改走骨架。与聚合线逐相位同构，多出的只有 T14 的
  // 「在新隔离树里先撤销上一次已合并的增量」——正落在 beforeSpawn 钩子上：
  // 它逐仓自兜（失败只记 warn 退回叠加，绝不让一个本来好好的分片失败），整体
  // 又在 iso 物化的同一个 try 内，所以未兜住的抛出走 onIsoSetupFailure，形态
  // 与现状一致（design §10.2 的 beforeSpawn 契约就是为它写的）。
  let shardIso: IsoHandle | null = null
  return await runAssembly<Record<string, never>, RunResult, DispatchShardResult>(
    {},
    {
      pools: [state.agentSem, state.subprocessSem],
      iso: {
        create: async () => {
          shardIso = await createIsoUnderLock({
            writeSem: state.writeSem,
            appHome: opts.appHome,
            taskId,
            db,
            isoKeyRunId: shardRunId,
            canonRepos: state.repos,
            log,
          })
          return shardIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough)
            await persistIsoBase(db, shardRunId, task.repoCount, shardIso as IsoHandle)
        },
      },
      beforeSpawn: async () => {
        const iso = shardIso as IsoHandle
        if (priorShardUndo !== null && !iso.passthrough) {
          for (const r of iso.repos) {
            try {
              await undoPriorShardDeltaInIso(
                r.isoWorktreePath,
                priorShardUndo.node[r.worktreeDirName],
                priorShardUndo.base[r.worktreeDirName],
                log,
                r.forcedRepoRelPaths,
              )
            } catch (err) {
              log.warn('T14 iso-undo failed — superimposition fallback', {
                shardKey,
                worktreeDirName: r.worktreeDirName,
                mountPath: r.worktreeDirName,
                subdir: '',
                readonly: false,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
        }
      },
      onIsoSetupFailure: (err) => {
        log.warn('fanout shard iso setup failed', {
          shardKey,
          error: err instanceof Error ? err.message : String(err),
        })
        return { kind: 'failed', shardKey, outputs: {}, message: 'iso-setup-failed' }
      },
      spawn: async () => {
        // RFC-111 D15 (Codex impl-gate P2-1): freeze the runtime for the fanout shard
        // so a claude-selected agent-multi dispatches its shards on claude, not opencode.
        const shardRuntime = await resolveFrozenRuntime(
          db,
          shardRunId,
          innerAgent.runtime,
          opts.defaultRuntime,
          null,
          freezeBinaryConfig(opts.configPath),
        )
        const iso = shardIso as IsoHandle
        const result = await runNode({
          taskId,
          nodeRunId: shardRunId,
          nodeId: innerNode.id,
          agent: innerAgent,
          triggerContext: state.triggerContext,
          runtime: shardRuntime.protocol,
          runtimeBinary: shardRuntime.binary,
          runtimeParams: shardRuntime.params,
          runtimeConfigDir: shardRuntime.configDir, // RFC-154: frozen config-dir profile
          inputs,
          // RFC-130 D16: cwd + path tokens → the shard's isolated worktree.
          worktreePath: iso.repos[0]?.isoWorktreePath ?? task.worktreePath,
          // RFC-067: per-task Git identity threaded through fanout shard dispatch.
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          templateMeta: {
            repoPath: iso.repos[0]?.isoWorktreePath ?? task.repoPath,
            baseBranch: task.baseBranch,
            taskId,
            nodeId: innerNode.id,
            iteration,
            ...(shard !== null ? { shardKey } : {}),
            // RFC-066: per-repo metadata for prompt placeholders.
            repos: iso.repos.map((r) => ({
              repoPath: r.repoPath,
              worktreePath: r.isoWorktreePath,
              worktreeDirName: r.worktreeDirName,
              mountPath: r.worktreeDirName,
              subdir: '',
              readonly: false,
              baseBranch: r.baseBranch,
            })),
          },
          ...(promptTemplate !== undefined ? { promptTemplate } : {}),
          ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
          // PR-D2: per-shard clarify stays off — RFC-148 ADT form.
          clarifyChannel: { kind: 'none' as const },
          skills: injection.spec.skills,
          dependents: injection.spec.dependents,
          mcps: injection.spec.mcps,
          plugins: injection.spec.plugins,
          appHome: opts.appHome,
          ...(opts.binaryOverride ? { binaryOverride: opts.binaryOverride } : {}),
          ...(Object.keys(inputPortKinds).length > 0 ? { inputPortKinds } : {}),
          db,
          log,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.subagentLiveCapture !== undefined
            ? { subagentLiveCapture: opts.subagentLiveCapture }
            : {}),
        })
        broadcastNodeStatus(taskId, shardRunId, innerNode.id, result.status)
        return result
      },
      keepFromOutcome: (result) => result.processUnreaped === true,
      mergePhase: (_c, result) => {
        if (result.status !== 'done') {
          return {
            skip: 'not-done',
            keep: false,
            then: {
              produce: async () => ({
                kind: 'failed' as const,
                shardKey,
                outputs: {},
                message: result.errorMessage ?? `shard-${result.status}`,
                ...(result.status === 'canceled'
                  ? {}
                  : {
                      retry: {
                        retryIndex: shardRetryIndex,
                        failureCode: result.failureCode ?? null,
                        ...(result.processUnreaped === true
                          ? { processUnreaped: true as const }
                          : {}),
                      },
                    }),
              }),
            },
          }
        }
        if ((shardIso as IsoHandle).passthrough) {
          return { skip: 'passthrough', keep: false, then: 'settle' }
        }
        return 'merge'
      },
      mergeBack: {
        run: async (_c, result) => {
          const iso = shardIso as IsoHandle
          const merge = await mergeBackAndSettle({
            db,
            writeSem: state.writeSem,
            handle: iso,
            nodeRunId: shardRunId,
            repoCount: task.repoCount,
            via: 'live',
            extraForcedContainerPaths: (result.portFilePaths ?? []).map((p) =>
              toContainerRelative(state.repos[0]?.worktreeDirName ?? '', p),
            ),
            conflictResolver: (conflicts, containerPath) =>
              resolveMergeConflicts(state, {
                conflicts,
                containerPath,
                conflictNodeRunId: shardRunId,
                nodeId: innerNode.id,
                iteration,
              }),
            log,
          })
          return merge
        },
        disposition: {
          // RFC-287 T14（用户拍板在本 RFC 内补掉的既存缺陷）：与 L1 同款，本线也
          // 许不起「留着给人解」的承诺——`keep: false` 意味着骨架随即丢弃 iso 并删
          // pin refs，而 `mergeBackAndSettle` **已经**把行落成了 conflict-human
          // （isolatedAgentRun.ts 的 park-conflict-human）。库里承诺「等待人工解决」、
          // 物理载体却没了，`replayConflictHumanResolutions` 又在每个任务的 runTask
          // 入口都跑，下次 resume 就会去找已 GC 的提交、抛错并打挂**整个任务**。
          //
          // 迁移前 fanout 两条线同样漏了这一步（63adfb66^ 的 7984/8411）——RFC-187
          // T8 当年只为工作组线修了，fanout 一直带病。这次一并补上：这份 delta 是
          // 真的被丢弃了，状态就该如实说 abandon。
          onConflictHuman: (detail) => ({
            keep: false,
            produce: async () => {
              await tryTransitionMergeState({
                db,
                nodeRunId: shardRunId,
                event: { kind: 'abandon', reason: 'fanout-shard-merge-conflict-unresolved' },
              })
              return {
                kind: 'failed' as const,
                shardKey,
                outputs: {},
                message: `merge-back-conflict (merge agent could not resolve): ${detail}`,
              }
            },
          }),
          onThrow: (err) => ({
            keep: true,
            then: {
              produce: async () => {
                const msg = err instanceof Error ? err.message : String(err)
                await markMergeFailed(db, shardRunId, msg, log)
                return {
                  kind: 'failed' as const,
                  shardKey,
                  outputs: {},
                  message: `merge-back-failed: ${msg}`,
                }
              },
            },
          }),
        },
      },
      onUnhandledThrow: (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        broadcastNodeStatus(taskId, shardRunId, innerNode.id, 'failed')
        return {
          kind: 'failed',
          shardKey,
          outputs: {},
          message: msg,
          retry: { retryIndex: shardRetryIndex, failureCode: null },
        }
      },
      discardIso: async (h: IsoLike) => discardNodeIso(h as IsoHandle, log, state.writeSem),
      settle: async (_c, result) => ({
        kind: 'ok',
        shardKey,
        outputs: result.outputs,
        message: '',
      }),
      log,
    },
  )
}

interface DispatchAggregatorArgs {
  state: SchedulerState
  wrapperId: string
  wrapperRunId: string
  aggNode: WorkflowNode
  aggAgent: Agent
  iteration: number
  shards: ShardSpec[]
  definition: WorkflowDefinition
  scope: ReturnType<typeof computeShardScope>
  /** RFC-098 B3 (audit S-20): see DispatchShardArgs.reuseDisabled. */
  reuseDisabled: boolean
  /** Internal fresh-row process retry; see DispatchShardArgs.processRetryIndex. */
  processRetryIndex?: number
  log: Logger
}

type DispatchAggregatorResult = OneNodeResult & {
  outputs: Record<string, string>
  aggRunId?: string
  /** Present only when the failed attempt may consume process-retry budget. */
  retry?: {
    retryIndex: number
    failureCode: FailureCode | null
    processUnreaped?: true
  }
}

/**
 * Dispatch the wrapper-fanout's aggregator agent — runs once, with per-shard
 * inner outputs collected into raw lists. The aggregator's prompt template
 * accesses these via {{#each port.shards}}{{shardKey}}: {{content}}{{/each}}
 * (PR-D2 will add that template syntax to renderUserPrompt; PR-D ships the
 * minimum: each per-shard output is delimited by a blank line and prefixed
 * with `### <shardKey>` so even a plain `{{port}}` substitution gives the
 * aggregator readable input).
 */
async function dispatchFanoutAggregator(
  args: DispatchAggregatorArgs,
): Promise<DispatchAggregatorResult> {
  const maxRetries = args.state.opts.defaultNodeRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
  let attemptArgs = args
  for (let retriesUsed = 0; ; retriesUsed++) {
    const result = await dispatchFanoutAggregatorAttempt(attemptArgs)
    if (
      result.kind !== 'failed' ||
      result.retry === undefined ||
      retriesUsed >= maxRetries ||
      !shouldRetryNodeFailure(result.retry.failureCode, result.retry.processUnreaped === true)
    ) {
      return result
    }
    attemptArgs = {
      ...args,
      reuseDisabled: true,
      processRetryIndex: result.retry.retryIndex + 1,
    }
  }
}

async function dispatchFanoutAggregatorAttempt(
  args: DispatchAggregatorArgs,
): Promise<DispatchAggregatorResult> {
  const { state, wrapperRunId, aggNode, aggAgent, iteration, shards, definition, scope, log } = args
  const { db, task, taskId, opts } = state

  // Collect each perShard inner's outputs across all shards. The aggregator
  // declares (via its edges' target.portName) which inner port to read; we
  // group by aggregator-input port name → newline-joined `### shardKey` blocks.
  // boundary-input edges from the wrapper itself are NOT relevant here (the
  // aggregator sits inside the wrapper and consumes inner-to-inner edges).
  //
  // RFC-098 B3 (audit S-21): row picking is done-only + freshest-per-shardKey
  // via pickReusableShardRun — the EXACT picker the shard dispatch uses — and
  // the anchor is relaxed in lockstep with dispatchFanoutShard's (taskId,
  // nodeId, iteration, parentNodeRunId IS NOT NULL): a cross-generation done
  // child the dispatch phase replayed would otherwise be invisible here
  // (silent empty aggregation). The old form read with NO status filter and
  // took SELECT-order first-match — a stale outputless child shadowed the
  // fresh one.
  const aggInputs: Record<string, string> = {}
  // Every inner row that fed this aggregation: an existing aggregator row may
  // only be REPLAYED when it is fresher (pure id-order) than ALL of them — a
  // shard that re-ran after the old aggregation makes that aggregation stale.
  const participatingRowIds: string[] = []
  const incoming = definition.edges.filter(
    (e) => e.target.nodeId === aggNode.id && e.boundary === undefined,
  )
  for (const edge of incoming) {
    const blocks: string[] = []
    // For each shard, pick the corresponding inner node_run + read port.
    const innerRows = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, edge.source.nodeId),
          eq(nodeRuns.iteration, iteration),
          isNotNull(nodeRuns.parentNodeRunId),
        ),
      )
    if (scope.perShard.has(edge.source.nodeId)) {
      // sorted by shardKey dictionary order (matches agent-multi convention).
      const sortedShards = [...shards].sort((a, b) => a.shardKey.localeCompare(b.shardKey))
      for (const s of sortedShards) {
        const row = pickReusableShardRun(innerRows, {
          shardKey: s.shardKey,
          valueHash: sha256Hex(s.value),
        })
        if (row === undefined) continue
        participatingRowIds.push(row.id)
        const outRows = await db
          .select()
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, row.id))
        const port = outRows.find((o) => o.portName === edge.source.portName)
        // RFC-306 D13: only ACTIVE shards feed the aggregation. A shard that
        // closed this branch contributes nothing at all — not an empty `###`
        // block. Two reasons it must be absent rather than blank: the aggregator
        // prompt would otherwise carry N empty sections that read as "these
        // shards found nothing" (they were never asked), and the port's content
        // on an inactive port is the shard's REASON text, which would land in
        // the aggregate as if it were a finding.
        if (port !== undefined && port.active !== false) {
          blocks.push(`### ${s.shardKey}\n${port.content}`)
        }
      }
    } else {
      // shared upstream — single (NULL-shardKey) row, plain content.
      const row = pickReusableShardRun(innerRows, { shardKey: null, valueHash: null })
      if (row !== undefined) {
        participatingRowIds.push(row.id)
        const outRows = await db
          .select()
          .from(nodeRunOutputs)
          .where(eq(nodeRunOutputs.nodeRunId, row.id))
        const port = outRows.find((o) => o.portName === edge.source.portName)
        // Same rule for a shared (broadcast) upstream — see above.
        if (port !== undefined && port.active !== false) blocks.push(port.content)
      }
    }
    aggInputs[edge.target.portName] = blocks.join('\n\n')
  }

  // RFC-098 B3 (audit S-21) — aggregator idempotency, mirroring the shard
  // branches. Candidates: (taskId, aggNodeId, iteration, shardKey IS NULL,
  // parentNodeRunId IS NOT NULL) — the aggregator is the convergence point so
  // its row carries no shardKey, and the relaxed anchor lets a retried
  // wrapper generation see the previous generation's aggregator row.
  //   1. freshest is done + fresher than EVERY participating inner row + reuse
  //      not disabled → replay its outputs without a spawn.
  //   2. freshest is non-done and belongs to THIS wrapper generation → re-run
  //      it in place (the daemon-restart residue that used to leak a
  //      permanently-interrupted row, scheduler-audit-s21 test 1).
  //   3. anything else → mint a fresh row (no shard_value_hash — the
  //      aggregator has no per-shard value).
  const aggCandidates = (
    await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, taskId),
          eq(nodeRuns.nodeId, aggNode.id),
          eq(nodeRuns.iteration, iteration),
          isNotNull(nodeRuns.parentNodeRunId),
        ),
      )
  ).filter((r) => r.shardKey === null)
  const freshestAgg = pickFreshestRun(aggCandidates, { topLevelOnly: false })
  const forcedProcessRetry = args.processRetryIndex !== undefined
  if (
    !forcedProcessRetry &&
    !args.reuseDisabled &&
    freshestAgg !== undefined &&
    freshestAgg.status === 'done' &&
    participatingRowIds.every((id) => isFresherNodeRun<{ id: string }>(freshestAgg, { id }))
  ) {
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, freshestAgg.id))
    const outputs: Record<string, string> = {}
    for (const o of outRows) outputs[o.portName] = o.content
    broadcastNodeStatus(taskId, freshestAgg.id, aggNode.id, 'done')
    return { kind: 'ok', summary: '', message: '', outputs, aggRunId: freshestAgg.id }
  }
  let aggRunId: string
  let aggRetryIndex: number
  if (
    !forcedProcessRetry &&
    freshestAgg !== undefined &&
    freshestAgg.status !== 'done' &&
    freshestAgg.parentNodeRunId === wrapperRunId
  ) {
    // Re-run the same-generation residue in place (allowTerminal: a reaped
    // aggregator is 'interrupted'; reset to pending for runNode's mark-running).
    aggRunId = freshestAgg.id
    await setNodeRunStatus({
      db,
      nodeRunId: aggRunId,
      to: 'pending',
      allowedFrom: ['pending', 'running', 'interrupted', 'failed', 'canceled'],
      allowTerminal: true,
      reason: 'fanout-aggregator-resume',
    })
    aggRetryIndex = freshestAgg.retryIndex
  } else {
    aggRunId = await mintNodeRun(db, {
      taskId,
      nodeId: aggNode.id,
      status: 'pending',
      cause: forcedProcessRetry ? 'process-retry' : 'fanout-aggregator',
      retryIndex: args.processRetryIndex ?? 0,
      iteration,
      overrides: { parentNodeRunId: wrapperRunId },
    })
    aggRetryIndex = args.processRetryIndex ?? 0
  }
  broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'pending')

  const injection = await resolveInjection(db, aggAgent, { appHome: opts.appHome, log })
  if (injection.kind === 'failed') {
    await setNodeRunStatus({
      db,
      nodeRunId: aggRunId,
      to: 'failed',
      allowedFrom: ['pending'],
      reason: 'fanout-aggregator-injection-failed',
      extra: { finishedAt: Date.now(), errorMessage: injection.message },
    })
    broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'failed')
    return { kind: 'failed', summary: injection.summary, message: injection.message, outputs: {} }
  }
  const promptTemplate = pickString(aggNode, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = opts.defaultPerNodeTimeoutMs

  // RFC-119 multi-process (D9 revision): surface the aggregator's prior output on
  // a genuine re-run so it UPDATES the prior aggregated result instead of
  // regenerating blind — the multi-process analogue of the single-process
  // review/retry case. We only reach here when the aggregator actually spawns
  // (the value-hash replay branch above returned early), so this fires exactly on
  // a real re-run. `freshestPriorRunWithOutput` is parent-agnostic, so it finds
  // the prior generation's aggregator CHILD (shardKey null) for this aggNode.
  // SHARDS are deliberately NOT given prior output: their value-hash replay means
  // an unchanged slice replays without a spawn, and a CHANGED slice's prior
  // output would mis-anchor the agent to stale content.
  const aggPriorRun = await freshestPriorRunWithOutput(db, {
    taskId,
    nodeId: aggNode.id,
    iteration,
    shardKey: null,
    id: aggRunId,
  })
  let aggPriorOutputUpdate: { block: string } | undefined
  if (aggPriorRun !== undefined) {
    const block = await composePriorOutputBlock(
      db,
      aggPriorRun.id,
      aggAgent.outputs ?? [],
      undefined,
      await loadRunEnvelopeNonce(db, aggRunId),
    )
    if (block.length > 0) aggPriorOutputUpdate = { block }
  }

  // RFC-130: the aggregator runs in its OWN isolated worktree too (it can write —
  // e.g. concatenate shard outputs into a file). Merge-back into canonical on
  // success; no whole-run writeSem.
  // RFC-287 T3：本线改走 `runAssembly` 骨架。相位与逐线声明一一对应，行为逐字保持：
  //   · 双许可（agent 池 + 本任务子进程池），释放逆序、finally 保证；
  //   · iso 物化 + 落基线同处一个 try（persistBase: 'in-setup'）——抛出即释放许可
  //     并返回结构化 iso-setup-failed（§10.10 按线声明，本线保持现状）；
  //   · processUnreaped ⇒ 保留 iso（§10.11 第五维，与合并处置正交）；
  //   · 非 done / passthrough 各自跳合并；撞冲突判失败且**不**保留（fail-all，
  //     C8 落地时改 abandon）；合并抛出保留 iso + 标记合并失败；
  //   · 线级 catch-all 带 retry 载荷（failureCode 为 null ⇒ 会重试到上限）。
  let aggIso: IsoHandle | null = null
  return await runAssembly<Record<string, never>, RunResult, DispatchAggregatorResult>(
    {},
    {
      pools: [state.agentSem, state.subprocessSem],
      iso: {
        create: async () => {
          aggIso = await createIsoUnderLock({
            writeSem: state.writeSem,
            appHome: opts.appHome,
            taskId,
            db,
            isoKeyRunId: aggRunId,
            canonRepos: state.repos,
            log,
          })
          return aggIso
        },
        persistBase: 'in-setup',
        persist: async (h: IsoLike) => {
          if (!h.passthrough)
            await persistIsoBase(db, aggRunId, task.repoCount, aggIso as IsoHandle)
        },
      },
      onIsoSetupFailure: () => ({
        kind: 'failed',
        summary: 'aggregator iso setup failed',
        message: 'iso-setup-failed',
        outputs: {},
      }),
      spawn: async () => {
        // RFC-111 D15 (Codex impl-gate P2-1): freeze the runtime for the aggregator.
        const aggRuntime = await resolveFrozenRuntime(
          db,
          aggRunId,
          aggAgent.runtime,
          opts.defaultRuntime,
          null,
          freezeBinaryConfig(opts.configPath),
        )
        const iso = aggIso as IsoHandle
        const result = await runNode({
          taskId,
          nodeRunId: aggRunId,
          nodeId: aggNode.id,
          agent: aggAgent,
          triggerContext: state.triggerContext,
          runtime: aggRuntime.protocol,
          runtimeBinary: aggRuntime.binary,
          runtimeParams: aggRuntime.params,
          runtimeConfigDir: aggRuntime.configDir, // RFC-154: frozen config-dir profile
          inputs: aggInputs,
          worktreePath: iso.repos[0]?.isoWorktreePath ?? task.worktreePath,
          // RFC-067: per-task Git identity threaded through fanout aggregator dispatch.
          gitUserName: task.gitUserName,
          gitUserEmail: task.gitUserEmail,
          templateMeta: {
            repoPath: iso.repos[0]?.isoWorktreePath ?? task.repoPath,
            baseBranch: task.baseBranch,
            taskId,
            nodeId: aggNode.id,
            iteration,
            // RFC-066: per-repo metadata for prompt placeholders.
            repos: iso.repos.map((r) => ({
              repoPath: r.repoPath,
              worktreePath: r.isoWorktreePath,
              worktreeDirName: r.worktreeDirName,
              mountPath: r.worktreeDirName,
              subdir: '',
              readonly: false,
              baseBranch: r.baseBranch,
            })),
          },
          ...(promptTemplate !== undefined ? { promptTemplate } : {}),
          ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
          // RFC-119 multi-process: prior aggregated output on re-run (see above).
          ...(aggPriorOutputUpdate !== undefined
            ? { priorOutputUpdate: aggPriorOutputUpdate }
            : {}),
          clarifyChannel: { kind: 'none' as const }, // PR-D2
          skills: injection.spec.skills,
          dependents: injection.spec.dependents,
          mcps: injection.spec.mcps,
          plugins: injection.spec.plugins,
          appHome: opts.appHome,
          ...(opts.binaryOverride ? { binaryOverride: opts.binaryOverride } : {}),
          db,
          log,
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.subagentLiveCapture !== undefined
            ? { subagentLiveCapture: opts.subagentLiveCapture }
            : {}),
        })
        broadcastNodeStatus(taskId, aggRunId, aggNode.id, result.status)
        return result
      },
      keepFromOutcome: (result) => result.processUnreaped === true,
      mergePhase: (_c, result) => {
        if (result.status !== 'done') {
          return {
            skip: 'not-done',
            keep: false,
            then: {
              produce: async () => ({
                kind: 'failed' as const,
                summary: `aggregator ${aggNode.id} ${result.status}`,
                message: result.errorMessage ?? `aggregator-${result.status}`,
                outputs: {},
                ...(result.status === 'canceled'
                  ? {}
                  : {
                      retry: {
                        retryIndex: aggRetryIndex,
                        failureCode: result.failureCode ?? null,
                        ...(result.processUnreaped === true
                          ? { processUnreaped: true as const }
                          : {}),
                      },
                    }),
              }),
            },
          }
        }
        // RFC-130 §段③: merge the aggregator's iso delta back into canonical.
        if ((aggIso as IsoHandle).passthrough) {
          return { skip: 'passthrough', keep: false, then: 'settle' }
        }
        return 'merge'
      },
      mergeBack: {
        // RFC-188: the ONE merge-back assembly. §6.3 disposition: unresolved →
        // conflict-human + fail loudly (per-node awaiting_human bubbling for
        // fanout is a follow-up, #4/PR-E); conflict never lost.
        run: async (_c, result) => {
          const iso = aggIso as IsoHandle
          const merge = await mergeBackAndSettle({
            db,
            writeSem: state.writeSem,
            handle: iso,
            nodeRunId: aggRunId,
            repoCount: task.repoCount,
            via: 'live',
            extraForcedContainerPaths: (result.portFilePaths ?? []).map((p) =>
              toContainerRelative(state.repos[0]?.worktreeDirName ?? '', p),
            ),
            conflictResolver: (conflicts, containerPath) =>
              resolveMergeConflicts(state, {
                conflicts,
                containerPath,
                conflictNodeRunId: aggRunId,
                nodeId: aggNode.id,
                iteration,
              }),
            log,
          })
          return merge
        },
        disposition: {
          // 与分片线同款、同理由（见那边的长注释）：keep:false 之后 iso 就没了，
          // 所以不能把行留在 conflict-human——否则下次 resume 找不到树，整任务打挂。
          onConflictHuman: (detail) => ({
            keep: false,
            produce: async () => {
              await tryTransitionMergeState({
                db,
                nodeRunId: aggRunId,
                event: { kind: 'abandon', reason: 'fanout-agg-merge-conflict-unresolved' },
              })
              return {
                kind: 'failed' as const,
                summary: 'aggregator merge conflict',
                message: `merge-back-conflict (merge agent could not resolve): ${detail}`,
                outputs: {},
              }
            },
          }),
          onThrow: (err) => ({
            keep: true,
            then: {
              produce: async () => {
                const msg = err instanceof Error ? err.message : String(err)
                await markMergeFailed(db, aggRunId, msg, log)
                return {
                  kind: 'failed' as const,
                  summary: 'aggregator merge failed',
                  message: `merge-back-failed: ${msg}`,
                  outputs: {},
                }
              },
            },
          }),
        },
      },
      onUnhandledThrow: (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        broadcastNodeStatus(taskId, aggRunId, aggNode.id, 'failed')
        return {
          kind: 'failed',
          summary: 'aggregator threw',
          message: msg,
          outputs: {},
          retry: { retryIndex: aggRetryIndex, failureCode: null },
        }
      },
      discardIso: async (h: IsoLike) => discardNodeIso(h as IsoHandle, log, state.writeSem),
      // Aggregator's outputs are already persisted by runner.ts (nodeRunOutputs
      // upsert at runner.ts §port-persist). The wrapper-row outlet copy is
      // handled by the caller (runFanoutWrapperNode after this returns).
      settle: async (_c, result) => ({
        kind: 'ok',
        summary: '',
        message: '',
        outputs: result.outputs,
        aggRunId,
      }),
      log,
    },
  )
}

// -----------------------------------------------------------------------------
// wrapper-git (P-3-03 + nested via P-4-03) — RFC-040 makes it bubble
// awaiting_* and resumable.
//
// The wrapper takes a baseline = HEAD, recursively executes its inner scope
// once, then computes the diff vs the baseline. This works for unnested
// wrappers and for wrapper-loop-in-wrapper-git (the inner scope can itself
// contain a wrapper-loop). On RFC-040 resume the baseline is read from
// persisted progress — we MUST NOT re-capture HEAD on resume because the
// worktree has already diverged from the original pre-inner state while the
// inner agent was running; the final diff is meant to be against pre-inner,
// not pre-resume.
// -----------------------------------------------------------------------------

async function captureHead(worktreePath: string): Promise<string> {
  try {
    const r = await runGit(worktreePath, ['rev-parse', 'HEAD'])
    if (r.exitCode === 0) return r.stdout.trim()
  } catch {
    /* empty fixture in tests */
  }
  return ''
}

// RFC-098 B3 (audit S-4, adversarial-review revision #9) — preDirty caps.
// Beyond either limit the capture DEGRADES TO THE EMPTY SET: the finalize
// subtraction then removes nothing, which is exactly the pre-fix cumulative
// behavior — over-report, never drop a real change. (A "paths-only" degrade
// was explicitly rejected: subtracting by bare path would drop files the
// inner scope genuinely rewrote.)
const GIT_PRE_DIRTY_MAX_ENTRIES = 4096
const GIT_PRE_DIRTY_MAX_JSON_BYTES = 256 * 1024

/**
 * RFC-098 B3 (audit S-4) — sample the worktree's pre-existing dirty set
 * `{path: blobSha | 'deleted'}` at git-wrapper FRESH MINT, right after the
 * baseline capture and inside the same task-write-lock window (no sibling
 * writer can be mid-write while we sample). Best-effort by design: any git
 * failure (no commits yet, fixture without a repo, hash race) degrades to the
 * empty set with a warn — entry must never fail the wrapper, and the empty
 * set only over-reports. Resume NEVER calls this (it reads the persisted map
 * from wrapperProgress; re-capturing after the inner scope started would
 * swallow the inner scope's own writes into the pre-set — silent UNDER-report,
 * worse than today).
 */
async function captureGitPreDirty(
  worktreePath: string,
  baseline: string,
  log: Logger,
): Promise<Record<string, string>> {
  try {
    const paths = await gitChangedFiles(worktreePath, baseline || 'HEAD')
    if (paths.length === 0) return {}
    if (paths.length > GIT_PRE_DIRTY_MAX_ENTRIES) {
      log.warn('git wrapper preDirty over entry cap — degrading to empty set (over-report)', {
        worktreePath,
        entries: paths.length,
        cap: GIT_PRE_DIRTY_MAX_ENTRIES,
      })
      return {}
    }
    const hashes = await gitBlobHashes(worktreePath, paths)
    const bytes = new TextEncoder().encode(JSON.stringify(hashes)).byteLength
    if (bytes > GIT_PRE_DIRTY_MAX_JSON_BYTES) {
      log.warn('git wrapper preDirty over JSON-size cap — degrading to empty set (over-report)', {
        worktreePath,
        bytes,
        cap: GIT_PRE_DIRTY_MAX_JSON_BYTES,
      })
      return {}
    }
    return hashes
  } catch (err) {
    log.warn('git wrapper preDirty capture failed — degrading to empty set (over-report)', {
      worktreePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

/**
 * RFC-130 T11 — create (fresh mint) or rebuild (resume) the wrapper-canonical iso
 * for a wrapper node. Fresh: snapshot the task canonical into an iso worktree keyed
 * by the wrapper's run id + persist its base. Resume: rebuild the handle pointing at
 * the SAME worktree (kept across a park — carrying the inner scope's accumulated
 * changes — so it must NOT be recreated). A non-git task worktree (mock harness)
 * yields a passthrough handle (the wrapper runs directly on the task canonical).
 */
/**
 * RFC-144 (PR-5 review P2) — wrapper outputs are written onto the wrapper's
 * OWN row, and wrapper rows are multi-generation (same-row revival after a
 * merged/conflict-human prior generation). The prior generation may have
 * already written its output rows before its merge-back crashed/parked, so a
 * plain INSERT would violate the (node_run_id, port_name) PK on the rerun.
 * Upsert: the new generation's content REPLACES the stale one (mirrors the
 * runner's same-session envelope upsert, runner.ts).
 */
async function upsertWrapperOutput(
  db: DbClient,
  wrapperRunId: string,
  portName: string,
  content: string,
  // RFC-193 D16: projections copy the source row's kind + archive reference
  // (synthesized outlets — __done__, git_diff — have no source row: NULL).
  kind: string | null = null,
  archiveJson: string | null = null,
  /**
   * RFC-306 D9 — whether the promoted outlet carries a value. A wrapper outlet
   * whose bound inner source sat on a closed branch is itself inactive, and that
   * is how a branch escapes a loop / fanout to the graph outside it. Defaults to
   * true so synthesized outlets (`__done__`, `git_diff`) and every existing
   * caller keep their current behavior.
   */
  active = true,
): Promise<void> {
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: wrapperRunId, portName, content, kind, archiveJson, active })
    .onConflictDoUpdate({
      target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
      set: { content, kind, archiveJson, active },
    })
}

export async function createOrRebuildWrapperIso(
  state: SchedulerState,
  wrapperRunId: string,
  existing: {
    isoBaseSnapshot: string | null
    isoBaseSnapshotReposJson: string | null
    // RFC-210: the rebuilt wrapper iso merges back like any other node's, so the
    // caller must hand its persisted submodule topology through too.
    isoSubmodulesJson?: string | null
    isoSubmodulesReposJson?: string | null
  } | null,
): Promise<IsoHandle> {
  const { db, task, taskId } = state
  // RFC-144 (Codex impl-gate P2) — same-row wrapper revival: a revived wrapper
  // row may arrive with a SETTLED prior generation ('merged': crash inside
  // mergeBackWrapperIso got its pending-merge replayed at entry;
  // 'conflict-human': canceled while parked). This run opens a NEW isolation
  // generation on the same row — re-enter 'isolating' so the strict machine's
  // mark-pending-merge (from=isolating) holds at the wrapper's merge-back.
  // isolating (mid-run revival, the common case) and NULL (fresh row /
  // passthrough) rows never emit this.
  const cur = (
    await db
      .select({ mergeState: nodeRuns.mergeState })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, wrapperRunId))
      .limit(1)
  )[0]
  let effectiveExisting = existing
  if (cur !== undefined && (cur.mergeState === 'merged' || cur.mergeState === 'conflict-human')) {
    if (cur.mergeState === 'merged') {
      // Impl-gate P2 second half: the prior generation's delta is ALREADY in
      // canonical — the new generation must branch from the CURRENT canonical,
      // NOT the stale gen-1 base. A three-way merge against the old base would
      // treat gen-1 files (now in canon) as `ours` additions and resurrect
      // content the new generation deleted.
      //
      // ORDER (impl-gate P2 rounds 3-5): the reenter CAS runs FIRST — it is the
      // ownership claim. A concurrent reviver that also read 'merged' loses the
      // CAS here and throws BEFORE any destructive cleanup (it can never remove
      // the winner's freshly-built iso). The CAS ATOMICALLY clears the base
      // columns + wrapperProgressJson, so a crash anywhere after it leaves an
      // isolating row with NULL base/progress — the next resume re-detects
      // "generation start" from durable state and the stale-iso cleanup below
      // (derived paths only, no column values needed) makes the re-create
      // idempotent. conflict-human re-entry keeps base + progress: its delta
      // never reached canonical (D27), so the old base/baseline stay the
      // correct merge/diff anchors.
      await transitionMergeState({
        db,
        nodeRunId: wrapperRunId,
        event: { kind: 'reenter-isolation' },
        extra: {
          isoWorktreePath: null,
          isoBaseSnapshot: null,
          isoBaseSnapshotReposJson: null,
          wrapperProgressJson: null,
        },
      })
      effectiveExisting = null
    } else {
      await transitionMergeState({
        db,
        nodeRunId: wrapperRunId,
        event: { kind: 'reenter-isolation' },
      })
    }
  }
  if (effectiveExisting !== null) {
    const baseSnapshots: Record<string, string> = {}
    if (task.repoCount === 1) {
      if (effectiveExisting.isoBaseSnapshot !== null) {
        baseSnapshots[''] = effectiveExisting.isoBaseSnapshot
      }
    } else {
      Object.assign(baseSnapshots, parseIsoJsonMap(effectiveExisting.isoBaseSnapshotReposJson))
    }
    if (Object.keys(baseSnapshots).length > 0) {
      const taskBaseHeads: Record<string, string> = {}
      for (const repo of state.repos) {
        taskBaseHeads[repo.worktreeDirName] = (
          await runGit(repo.worktreePath, ['rev-parse', 'HEAD'])
        ).stdout.trim()
      }
      return rebuildIsoHandle({
        appHome: state.opts.appHome,
        taskId,
        nodeRunId: wrapperRunId,
        canonRepos: state.repos,
        baseSnapshots,
        taskBaseHeads,
        forcedContainerPaths: await forcedPortPathsForTask(state.db, taskId),
        // RFC-210: a rebuilt wrapper iso merges back like any other, so it
        // carries the same submodule topology. (The discard-only rebuild below
        // deliberately does not — it needs paths and refs, nothing else.)
        submodules: parseIsoSubmodules(
          {
            isoSubmodulesJson: effectiveExisting.isoSubmodulesJson ?? null,
            isoSubmodulesReposJson: effectiveExisting.isoSubmodulesReposJson ?? null,
          },
          task.repoCount,
        ),
      })
    }
    // No persisted iso base (legacy / passthrough row) — fall through to create.
  }
  if (existing !== null) {
    // Reaching CREATE for a row that has lived before (merged re-entry, or a
    // crash inside a prior re-entry window that cleared the base columns): a
    // stale iso worktree may still sit at this wrapper's derived path, and
    // `git worktree add` fails LOUDLY on an existing dir — without cleanup the
    // task would wedge on every resume. discardNodeIso only needs the derived
    // paths + refs (base snapshot VALUES are unused for removal), so a handle
    // rebuilt with empty snapshot maps cleans up regardless of what the crash
    // left behind. Tolerant: nothing there → warn-and-continue.
    await discardNodeIso(
      rebuildIsoHandle({
        appHome: state.opts.appHome,
        taskId,
        nodeRunId: wrapperRunId,
        canonRepos: state.repos,
        baseSnapshots: {},
        taskBaseHeads: {},
      }),
      state.log,
      state.writeSem,
    )
  }
  // Wrapper-private canonicals and ordinary sibling agent isos mutate the same
  // repository's `.git/worktrees` registry. They MUST share the task write
  // semaphore; otherwise a top-level wrapper and a slow sibling can overlap
  // `git worktree add`, leaving a partially initialized registration whose
  // `commondir` cannot be read. Keep only the short create/snapshot window
  // locked — wrapper execution itself remains concurrent.
  const handle = await createIsoUnderLock({
    writeSem: state.writeSem,
    appHome: state.opts.appHome,
    taskId,
    isoKeyRunId: wrapperRunId,
    canonRepos: state.repos,
    db,
    log: state.log,
  })
  if (!handle.passthrough) await persistIsoBase(db, wrapperRunId, task.repoCount, handle)
  return handle
}

/**
 * RFC-130 T11 — merge a completed wrapper's total delta (its wrapper-canonical)
 * back into the parent (task) canonical as ONE unit, exactly like a node merge-back
 * (§6). Clean → merge_state='merged' (D15 lets downstream consume) + iso discarded;
 * conflict → merge agent, unresolved → the wrapper is parked conflict-human (iso
 * kept) — the caller returns awaiting_human; a merge-back error → merge-failed, the
 * caller fails the wrapper. Shared by the git + loop (+ fanout) wrappers so the
 * merge-back semantics can't fork.
 */
async function mergeBackWrapperIso(
  state: SchedulerState,
  wrapperIso: IsoHandle,
  wrapperRunId: string,
  node: WorkflowNode,
  iteration: number,
  log: Logger,
): Promise<
  // RFC-144 naming收敛: the parked-conflict variant is 'conflict-human' — same
  // vocabulary as the merge_state column and the node-path union above (the
  // old 'awaiting_human' kind said what the TASK would do, not what the row
  // is; callers translate conflict-human → awaiting_human scope outcome).
  | { kind: 'merged' }
  | { kind: 'conflict-human'; detail: string }
  | { kind: 'merge-failed'; msg: string }
> {
  const { db, task, taskId } = state
  try {
    // RFC-193 K1: re-aggregate at wrapper-final time — the wrapper handle is
    // the one LONG-LIVED handle (inner nodes archived new port files during
    // its lifetime; the create-time roster predates them, design §4.5).
    const nodeTrees = await snapshotNodeIsoFinal(
      wrapperIso,
      log,
      await forcedPortPathsForTask(db, taskId),
    )
    // RFC-210 impl-gate: the handle rides along so a topology the snapshot
    // extended (submodule added inside the wrapper) survives into crash replay.
    await persistIsoNodeTree(db, wrapperRunId, task.repoCount, nodeTrees, wrapperIso)
    const merge = await state.writeSem.run(async () => {
      const mr = await mergeBackNodeIso(wrapperIso, nodeTrees, log)
      if (mr.clean) return { kind: 'merged' as const }
      const res = await resolveMergeConflicts(state, {
        conflicts: mr.conflicts,
        containerPath: wrapperIso.containerPath,
        conflictNodeRunId: wrapperRunId,
        nodeId: node.id,
        iteration,
      })
      return res.allResolved
        ? { kind: 'merged' as const }
        : { kind: 'conflict-human' as const, detail: res.detail }
    })
    if (merge.kind !== 'merged') {
      await transitionMergeState({
        db,
        nodeRunId: wrapperRunId,
        event: { kind: 'park-conflict-human', via: 'live' },
      })
      // D10: merge_state and status are two orthogonal machines — two CAS
      // writes, not one cross-machine tx; the frontier's done-branch bridges
      // the (rare) crash window between them.
      await transitionNodeRunStatus({ db, nodeRunId: wrapperRunId, event: { kind: 'park-human' } })
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'awaiting_human')
      return { kind: 'conflict-human', detail: merge.detail }
    }
    await transitionMergeState({
      db,
      nodeRunId: wrapperRunId,
      event: { kind: 'mark-merged', via: 'live' },
    })
    await discardNodeIso(wrapperIso, log, state.writeSem)
    return { kind: 'merged' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const flipped = await tryTransitionMergeState({
      db,
      nodeRunId: wrapperRunId,
      event: { kind: 'mark-merge-failed', reason: msg },
    })
    if (!flipped) {
      log.warn('merge_state flip to merge-failed lost/illegal', { nodeRunId: wrapperRunId })
    }
    return { kind: 'merge-failed', msg }
  }
}

async function runGitWrapperNode(state: SchedulerState, args: OneNodeArgs): Promise<OneNodeResult> {
  // RFC-248: `task` 曾用于 passthrough 时的 `task.worktreePath` 回落——那条回落
  // 现在由 `diffableRepos` 从 `state.repos` 直接取，不再需要它。
  const { db, taskId, definition } = state
  const { node, iteration, log } = args
  const inner = pickStringArray(node, 'nodeIds')
  if (inner.length === 0) {
    return {
      kind: 'failed',
      summary: `wrapper-git ${node.id} has no inner nodes`,
      message: 'wrapper-empty',
    }
  }

  const existing = await findResumableWrapperRun(db, taskId, node.id, iteration)
  let wrapperRunId: string
  // RFC-098 B3 (audit S-4): the worktree's pre-existing dirty set, sampled at fresh
  // mint only — finalize subtracts hash-equal members so git_diff carries ONLY paths
  // this wrapper's inner scope produced/modified (fixes sequential-wrapper pollution
  // AND git-in-loop cumulative diffs). RFC-130 T11: baseline/preDirty are captured on
  // the WRAPPER-canonical (below), NOT the task canonical.
  let baseline: string | undefined
  let preDirty: Record<string, string> = {}
  // RFC-248 D9: 多仓的逐仓形态（键 = 挂载路径，挂根为 ''）。上面两个标量继续
  // 承载 repos[0]，见 wrapperProgress.ts 上关于「为什么不翻新成 map-only」的说明。
  let baselines: Record<string, string> = {}
  let preDirtyByRepo: Record<string, Record<string, string>> = {}
  // RFC-144 D13 second half (PR-4 review P2): a revived row whose prior
  // generation is 'merged' gets a FRESH wrapper-canonical from the CURRENT
  // task canonical (createOrRebuildWrapperIso replaces the iso). The persisted
  // baseline/preDirty belong to the OLD generation's canon — reusing them
  // would make the final gitChangedFiles report gen-1's already-merged files
  // in this generation's git_diff. Treat it as a fresh generation: skip the
  // persisted progress, recapture + re-persist on the new wrapper-canonical
  // below. (conflict-human / mid-run revival keep the S-4 never-recapture
  // rule — their iso and its inner writes are preserved.)
  // Crash durability (PR-5 review P2): the re-entry flip clears base cols +
  // progress ATOMICALLY, so a crash inside the re-entry window leaves an
  // isolating row with NULL base columns — the second disjunct re-detects it
  // as a generation start on the next resume (a genuine mid-generation row
  // always carries the base columns persistIsoBase stamped before any inner
  // work; passthrough rows have NULL merge_state and never match).
  const freshGeneration =
    existing !== null &&
    (existing.mergeState === 'merged' ||
      (existing.mergeState === 'isolating' &&
        existing.isoBaseSnapshot === null &&
        existing.isoBaseSnapshotReposJson === null))
  if (existing !== null) {
    const progress = decodeWrapperProgress(existing.wrapperProgressJson, (msg) => log.warn(msg))
    wrapperRunId = existing.id
    if (!freshGeneration && progress?.kind === 'git' && typeof progress.baseline === 'string') {
      baseline = progress.baseline
      // S-4: resume reads the persisted pre-set; NEVER re-capture — the inner scope's
      // own writes are already in the (wrapper-)worktree.
      preDirty = progress.preDirty ?? {}
      // RFC-248: 优先用逐仓 map；RFC-248 之前的 payload 只有标量，把它当作
      // `{ '': baseline }`——单仓的挂载路径正好就是空串，两种形态天然对齐，
      // 所以升级期间**跑在半路**的包裹器不会丢基线。
      baselines = progress.baselines ?? { '': progress.baseline }
      preDirtyByRepo = progress.preDirtyByRepo ?? { '': preDirty }
    }
    // Malformed / missing payload → baseline stays undefined → captured below on the
    // wrapper-canonical (pre-set stays empty, S-4 malformed fallback).
    if (existing.status !== 'running') {
      // RFC-053: wrapper enter-running — resumes from awaiting_* / pending.
      await setNodeRunStatus({
        db,
        nodeRunId: wrapperRunId,
        to: 'running',
        allowedFrom: ['pending', 'awaiting_review', 'awaiting_human', 'interrupted', 'canceled'],
        // Daemon-restart resume legitimately overwrites the reaped 'interrupted'
        // wrapper row (wrappers reuse their row on resume per RFC-040, unlike
        // agent nodes which mint a fresh retry row); RFC-095 extends the same
        // continue-not-restart semantics to 'canceled' (task-cancel revival via
        // retryNode, audit S-22). Both are terminal statuses, so
        // setNodeRunStatus's terminal guard would otherwise refuse;
        // allowTerminal bypasses that guard while allowedFrom still restricts the
        // legal source set. See scheduler-boundary-wrapper-resume-interrupted.test.ts.
        allowTerminal: true,
        reason: 'wrapper-resume',
      })
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    }
    // RFC-098 B3 (audit S-7, revision #6): resume does NOT overwrite the
    // wrapper's consumedUpstreamRunsJson — fresh-mint-only.
  } else {
    // RFC-098 B3 (audit S-7): external-upstream provenance at fresh mint
    // (mirrors the fanout wrapper, RFC-074 §8 D3) — an upstream rerun demotes
    // the done wrapper row to stale; the next dispatch mints a new generation
    // that re-captures baseline + pre-set below.
    const consumed = await computeWrapperConsumed(db, taskId, definition, node.id, iteration)
    wrapperRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'pending',
      cause: 'wrapper-init',
      iteration,
      overrides: { consumedUpstreamRunsJson: JSON.stringify(consumed) },
    })
    // RFC-098 B3 (audit S-28): mark-running before the broadcast and before
    // any reachable markWrapperTerminal (DB-first rule, lifecycle.ts).
    await transitionNodeRunStatus({ db, nodeRunId: wrapperRunId, event: { kind: 'mark-running' } })
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    // baseline/preDirty captured below on the wrapper-canonical (after it exists).
  }

  // RFC-130 T11 (D29): wrapper-PRIVATE canonical. The wrapper's inner scope runs in
  // a `wrapper-canonical` — an iso worktree of the WRAPPER, branched from the task
  // canonical — so a sibling writer's merge-back into the TASK canonical cannot
  // pollute THIS wrapper's git_diff (AC-10). Inner nodes isolate FROM / merge-back
  // INTO the wrapper-canonical (their createNodeIso reads `innerState.repos`); the
  // wrapper's total delta merges back into the task canonical as ONE unit on done.
  // On a NON-git worktree (mock harness) createNodeIso returns passthrough → the
  // wrapper runs directly on the task canonical as pre-RFC-130 (diff + no merge-back).
  const wrapperIso = await createOrRebuildWrapperIso(state, wrapperRunId, existing)
  // RFC-248 D9: 包裹器要逐仓取快照 / 逐仓 diff 的那批仓。
  // 这里原本先算一个 `wrapperCanonPath = wrapperIso.repos[0]?.isoWorktreePath`
  // 再对它单独取快照/做 diff——那正是 RFC-066 当年必须禁掉多仓 wrapper-git 的
  // 原因（只看得见第一个仓）。现在整块换成逐仓，那个变量随之删除。
  // - passthrough（mock 夹具 / 非 git 工作树）走 `state.repos`，与 pre-RFC-130 一致；
  // - 正常路径走 wrapper-iso 的 per-repo 句柄（与 state.repos 按下标对齐）。
  // **只读成员不参与**（D11：它的改动不进 git_diff、不被提交推送）。
  const diffableRepos: Array<{ path: string; mountPath: string }> = (
    wrapperIso.passthrough
      ? state.repos.map((r) => ({
          path: r.worktreePath,
          mountPath: r.mountPath,
          readonly: r.readonly,
        }))
      : wrapperIso.repos.map((r, i) => ({
          path: r.isoWorktreePath,
          mountPath: state.repos[i]?.mountPath ?? r.worktreeDirName,
          readonly: state.repos[i]?.readonly ?? false,
        }))
  )
    .filter((r) => !r.readonly)
    .map((r) => ({ path: r.path, mountPath: r.mountPath }))
  // 标量兼容字段承载的那个仓：优先挂根的成员，否则第一个可 diff 的。
  const primaryMount = diffableRepos.some((r) => r.mountPath === '')
    ? ''
    : (diffableRepos[0]?.mountPath ?? '')
  const innerState: SchedulerState = wrapperIso.passthrough
    ? state
    : {
        ...state,
        repos: wrapperIso.repos.map((r, i) => ({
          repoIndex: i,
          repoPath: r.repoPath,
          worktreePath: r.isoWorktreePath,
          worktreeDirName: r.worktreeDirName,
          mountPath: r.worktreeDirName,
          subdir: '',
          readonly: false,
          baseBranch: r.baseBranch,
          // RFC-187 §4 — a wrapper-iso repo's base is the commit it forked from.
          baseCommit: r.baseSnapshot,
        })),
        // RFC-193 D9: inner nodes' scope canonical is the wrapper-canonical
        // container (== repos[0] iso root when single-repo, dirName='').
        scopeRoot: wrapperIso.containerPath,
      }

  // RFC-130 T11 / §6.4: capture baseline (+ preDirty on fresh mint) on the WRAPPER-
  // canonical, NOT the task canonical. Critical for a git wrapper NESTED IN A LOOP:
  // the wrapper-canonical already carries the loop's prior-iteration writes as its
  // dirty-at-entry set, so preDirty subtracts them and each iteration's git_diff
  // stays that-round-only (per-iteration, §6.4/6.5) — diffing the task canonical
  // (which the loop hasn't merged into yet) would leave preDirty empty and wrongly
  // report the cumulative union. RFC-098 B1 (S-24): captured under the write lock.
  if (baseline === undefined) {
    // Establishing this generation's baseline. Two states land here, split by
    // a DURABLE discriminator (impl-gate P2 rounds 5-6):
    //
    // ① Generation start — fresh mint / merged re-entry / a crash after the
    //   re-entry cleared progress (even one landing after persistIsoBase
    //   re-stamped the base columns). Invariant: persistWrapperProgress runs
    //   strictly BEFORE runScope, and the ONLY writer that nulls it is the
    //   re-entry CAS — so `wrapperProgressJson IS NULL` ⟹ zero inner work in
    //   this generation. Capture preDirty (a git wrapper nested in a loop
    //   branches from the loop's DIRTY wrapper-canonical; skipping the pre-set
    //   would leak those entry-dirty files into git_diff) and persist
    //   immediately (durable for same-generation resumes).
    //
    // ② Malformed NON-NULL progress — mid-generation corruption; inner work
    //   may already sit in the wrapper worktree. Capturing preDirty here would
    //   hash-match those real inner changes and SWALLOW them from git_diff
    //   (under-report breaks downstream consumers). Keep the documented
    //   pre-RFC-144 fallback: empty pre-set (over-report, never drop) and no
    //   progress overwrite.
    const generationStart =
      existing === null || freshGeneration || existing.wrapperProgressJson === null
    // RFC-248 D9: 逐仓捕获。只读成员不参与（D11——它的改动不进 git_diff）。
    const entry = await state.writeSem.run(async () => {
      const bases: Record<string, string> = {}
      const pres: Record<string, Record<string, string>> = {}
      for (const r of diffableRepos) {
        const b = await captureHead(r.path)
        bases[r.mountPath] = b
        pres[r.mountPath] = generationStart ? await captureGitPreDirty(r.path, b, log) : {}
      }
      return { bases, pres }
    })
    baselines = entry.bases
    preDirtyByRepo = entry.pres
    // 标量字段继续写 repos[0]，保住既有遥测与老 payload 的 resume（见
    // wrapperProgress.ts 上的说明）。
    baseline = baselines[primaryMount] ?? ''
    preDirty = preDirtyByRepo[primaryMount] ?? {}
    if (generationStart) {
      await persistWrapperProgress(db, wrapperRunId, {
        kind: 'git',
        baseline,
        preDirty,
        baselines,
        preDirtyByRepo,
        phase: 'inner-running',
      })
    }
  }

  const subRes = await runScope(innerState, {
    scopeId: node.id,
    scopeIds: new Set(inner),
    iteration,
    log: log.child(`git:${node.id}`),
  })
  if (subRes.kind === 'canceled') {
    await markWrapperTerminal(db, wrapperRunId, 'canceled')
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'canceled')
    return { kind: 'canceled', summary: 'inner canceled', message: '' }
  }
  if (subRes.kind === 'failed') {
    await markWrapperTerminal(db, wrapperRunId, 'failed', subRes.detail?.message ?? 'inner failed')
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
    return {
      kind: 'failed',
      summary: subRes.detail?.summary ?? `wrapper-git ${node.id} inner failed`,
      message: subRes.detail?.message ?? 'inner failed',
    }
  }
  // RFC-040: bubble awaiting_* up. We do NOT compute the diff yet —
  // doing so against a half-finished worktree was the silent correctness
  // bug RFC-040 is fixing.
  if (subRes.kind === 'awaiting_human' || subRes.kind === 'awaiting_review') {
    // S-4: re-persist preDirty alongside the baseline — dropping it here
    // would make the post-park resume read an empty pre-set and regress to
    // the cumulative diff.
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'git',
      baseline,
      preDirty,
      phase: 'awaiting',
    })
    const newStatus = subRes.kind === 'awaiting_human' ? 'awaiting_human' : 'awaiting_review'
    // RFC-053: wrapper-git bubbles inner awaiting_*; same semantics as
    // wrapper-loop above.
    await transitionNodeRunStatus({
      db,
      nodeRunId: wrapperRunId,
      event: subRes.kind === 'awaiting_human' ? { kind: 'park-human' } : { kind: 'park-review' },
    })
    broadcastNodeStatus(taskId, wrapperRunId, node.id, newStatus)
    return {
      kind: subRes.kind,
      summary: subRes.detail?.summary ?? '',
      message: subRes.detail?.message ?? '',
    }
  }

  // subRes.kind === 'ok' — emit changed-file list against persisted baseline.
  // RFC-060 PR-E: git_diff outlet is now `list<path<*>>` (newline-joined file
  // paths) instead of a full unified diff. Downstream wrapper-fanout can
  // consume it directly as a shardSource. Authors who still want the raw
  // diff can run `git diff` themselves in a downstream agent — or wait for
  // the planned `git_diff_full` companion outlet.
  let paths: string[] = []
  try {
    // RFC-098 B1 (audit S-24): the diff is captured under the task write lock
    // (no sibling writer mid-write can leak half-written files into the
    // changed-file list), and a diff FAILURE now fails the wrapper instead of
    // silently degrading to an empty git_diff — the old empty-catch sent the
    // whole downstream fan-out into the empty-source short-circuit and the
    // task went green with zero audit shards.
    //
    // RFC-098 B3 (audit S-4): subtract the PRE-EXISTING dirty set sampled at
    // fresh mint — a post path is dropped iff it was already dirty at entry
    // AND its current state matches the entry state (blob-hash equal, or both
    // 'deleted'). A pre-dirty file the inner scope rewrote keeps its place; a
    // touched-then-reverted one is subtracted (git-status-consistent). The
    // post hashes are sampled inside the SAME lock window as the path list.
    // Known open point (revision #9): a stale-redispatch generation inherits
    // the previous generation's residue as preDirty (wrapper re-run performs
    // no worktree rollback) — recorded in design/RFC-098 §B3.
    paths = await state.writeSem.run(async () => {
      // RFC-130 T11: diff the WRAPPER-canonical (isolated from sibling merge-backs),
      // not the task canonical — with passthrough this IS the task canonical.
      //
      // RFC-248 D9: 逐仓做，再把每个仓的路径用它的**挂载路径**前缀化后合并。
      // 端口契约仍是 `list<path<*>>`（`nodePorts.ts:188`）——不是拼接的完整
      // patch；下游 wrapper-fanout 直接把它当路径列表消费，前缀让分片天然带上
      // 仓归属、也让 agent `cd <前缀>` 就能到位。
      const out: string[] = []
      for (const r of diffableRepos) {
        const base = baselines[r.mountPath] ?? ''
        const pre = preDirtyByRepo[r.mountPath] ?? {}
        const all = await gitChangedFiles(r.path, base || 'HEAD')
        const candidates = all.filter((p) => pre[p] !== undefined)
        const kept =
          candidates.length === 0
            ? all
            : await (async () => {
                const post = await gitBlobHashes(r.path, candidates)
                return all.filter((p) => pre[p] === undefined || post[p] !== pre[p])
              })()
        for (const p of kept) out.push(r.mountPath === '' ? p : `${r.mountPath}/${p}`)
      }
      return out
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await markWrapperTerminal(db, wrapperRunId, 'failed', `git-diff-failed:${msg}`)
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
    return { kind: 'failed', summary: `git diff failed: ${msg}`, message: 'git-diff-failed' }
  }
  await upsertWrapperOutput(db, wrapperRunId, 'git_diff', paths.join('\n'))
  // RFC-130 T11: merge the wrapper's total delta (its wrapper-canonical) back into
  // the TASK canonical as ONE unit — the wrapper is isolated like a node. Clean →
  // materialized + merge_state='merged' (D15 lets downstream consume the git_diff);
  // conflict → merge agent (§6), unresolved → the wrapper parks conflict-human (iso
  // kept for the human); a merge-back error fails the wrapper loudly. Passthrough
  // wrappers already ran on the task canonical (nothing to merge, merge_state NULL).
  if (!wrapperIso.passthrough) {
    const mb = await mergeBackWrapperIso(state, wrapperIso, wrapperRunId, node, iteration, log)
    if (mb.kind === 'conflict-human') {
      // row parked conflict-human → the scope outcome is awaiting_human.
      return {
        kind: 'awaiting_human',
        summary: `wrapper merge conflict: ${mb.detail}`,
        message: 'merge-conflict',
      }
    }
    if (mb.kind === 'merge-failed') {
      await markWrapperTerminal(db, wrapperRunId, 'failed', `wrapper-merge-failed:${mb.msg}`)
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'failed')
      return {
        kind: 'failed',
        summary: `wrapper merge-back failed: ${mb.msg}`,
        message: 'wrapper-merge-failed',
      }
    }
  }
  await markWrapperTerminal(db, wrapperRunId, 'done')
  broadcastNodeStatus(taskId, wrapperRunId, node.id, 'done')
  return { kind: 'ok', summary: '', message: '' }
}

// RFC-060 PR-E: runFanOutNode (the M3 agent-multi fan-out implementation)
// was removed. wrapper-fanout (RFC-060) is now the sole fan-out mechanism;
// see runFanoutWrapperNode above for the replacement.

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function emitStatus(db: DbClient, taskId: string): Promise<void> {
  const t = await getTask(db, taskId)
  if (t !== null) emitTaskStatus(t)
}

function broadcastNodeStatus(
  taskId: string,
  nodeRunId: string,
  nodeId: string,
  status: NodeStatus,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'node.status',
    nodeRunId,
    nodeId,
    status,
  })
}

// RFC-098 WP-10 T-a: the old `insertNodeRun` half-factory was absorbed into
// the single mint factory — see services/nodeRunMint.ts (grep-guarded).

async function failTask(
  db: DbClient,
  taskId: string,
  errorSummary: string,
  errorMessage: string,
  failedNodeId?: string,
): Promise<void> {
  // RFC-097: callers sit either before mark-running (snapshot-invalid /
  // unsupported-kind → from=pending) or inside the running scope. A canceled
  // winner is respected (cancel outranks fail).
  const won = await trySetTaskStatus({
    db,
    taskId,
    to: 'failed',
    allowedFrom: ['pending', 'running'],
    extra: {
      finishedAt: Date.now(),
      errorSummary,
      errorMessage,
      ...(failedNodeId !== undefined ? { failedNodeId } : {}),
    },
    reason: `failTask: ${errorSummary}`,
  })
  if (!won) {
    createLogger('scheduler').warn(
      'failTask write lost to a concurrent transition — respecting winner',
      { taskId, errorSummary },
    )
    return
  }
  await emitStatus(db, taskId)
}

async function cancelTaskRow(
  db: DbClient,
  taskId: string,
  failedNodeId?: string,
  abortReason?: unknown,
): Promise<void> {
  return withTaskReviewMutationLock(taskId, () =>
    cancelTaskRowUnlocked(db, taskId, failedNodeId, abortReason),
  )
}

async function cancelTaskRowUnlocked(
  db: DbClient,
  taskId: string,
  failedNodeId?: string,
  abortReason?: unknown,
): Promise<void> {
  // RFC-202 T4: a graceful daemon shutdown aborts the scheduler exactly like
  // a user cancel did — but writing 'canceled by user' misattributes it and
  // strands the task (canceled has no resume edge; audit P1 F-13). The
  // shutdown path tags its abort with reason='daemon-shutdown'
  // (AbortController.abort(reason)); a user cancel aborts with no argument,
  // whose signal.reason is a DOMException — the string comparison below
  // leaves that path byte-identical. Shutdown-interrupted tasks land
  // interrupted + DAEMON_RESTART_ERROR_SUMMARY so both the Resume button and
  // boot auto-resume (autoResume.ts matches exactly that summary) cover them.
  if (abortReason === DAEMON_SHUTDOWN_ABORT_REASON) {
    const won = await trySetTaskStatus({
      db,
      taskId,
      to: 'interrupted',
      allowedFrom: ['running'],
      extra: {
        finishedAt: Date.now(),
        errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
        errorMessage: 'daemon shutdown interrupted this task; resume (or auto-resume) continues it',
        ...(failedNodeId !== undefined ? { failedNodeId } : {}),
      },
      reason: 'cancelTaskRow-shutdown',
    })
    if (won) await emitStatus(db, taskId)
    return
  }
  const structuredCause = taskStopCauseOf(abortReason)
  const projection = taskStopProjection(structuredCause ?? { kind: 'user' })
  // RFC-097: idempotent — cancelTask's fallback (or a failTask that raced
  // first) may already have landed a terminal status; respect the winner.
  const won = await trySetTaskStatus({
    db,
    taskId,
    to: 'canceled',
    allowedFrom: ['running'],
    extra: {
      finishedAt: Date.now(),
      errorSummary: projection.summary,
      errorMessage:
        structuredCause?.kind === 'webhook-terminal'
          ? `${projection.code}: delivery=${structuredCause.deliveryId} revision=${structuredCause.streamRevision}`
          : structuredCause?.kind === 'parent-cascade' && structuredCause.rootCause !== undefined
            ? `${projection.code}: parent=${structuredCause.parentTaskId} delivery=${structuredCause.rootCause.deliveryId} revision=${structuredCause.rootCause.streamRevision}`
            : projection.code,
      ...(failedNodeId !== undefined ? { failedNodeId } : {}),
    },
    reason: 'cancelTaskRow',
  })
  if (!won) {
    createLogger('scheduler').warn(
      'cancelTaskRow lost to a concurrent transition — respecting winner',
      { taskId },
    )
    return
  }
  await emitStatus(db, taskId)
}

function taskStopCauseOf(value: unknown): TaskStopCause | null {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return null
  const candidate = value as TaskStopCause
  switch (candidate.kind) {
    case 'user':
    case 'daemon-shutdown':
      return candidate
    case 'parent-cascade':
      return typeof candidate.parentTaskId === 'string' ? candidate : null
    case 'webhook-terminal':
      return (candidate.terminal === 'closed' || candidate.terminal === 'merged') &&
        typeof candidate.deliveryId === 'string' &&
        Number.isInteger(candidate.streamRevision)
        ? candidate
        : null
    default:
      return null
  }
}

/**
 * Resolve upstream port values for one node at a given iteration.
 *
 * For each incoming edge: pick the upstream node's latest run whose iteration
 * is ≤ current iteration (prefer the highest matching iteration, then highest
 * retry_index). This lets inner-scope nodes see top-level node outputs
 * (iteration=0) and same-iteration upstream outputs from earlier ready batches.
 */
// RFC-074: exported (was module-private) for the picker baseline test. PR-B
// unified the source-run picker with the freshness picker (done-only,
// highest-iteration-then-isFresherNodeRun) and now returns `consumed`
// provenance alongside the resolved inputs — see body + design §5.1 / D10.
export async function resolveUpstreamInputs(
  db: DbClient,
  taskId: string,
  edges: WorkflowEdge[],
  nodeId: string,
  iteration: number,
  log: Logger,
  definition?: WorkflowDefinition,
  parents?: ReadonlyMap<string, string>,
): Promise<{ inputs: Record<string, string>; consumed: Record<string, string> }> {
  const grouped = new Map<string, string[]>()
  // Fanout boundary edges are structural mirrors, and clarify/cross-clarify
  // response edges are prompt-injected system channels — neither is ordinary
  // row-to-row dataflow. Reading them here would either observe a still-running
  // wrapper/channel row (and emit a false "missing upstream" warning) or, when
  // an older channel output exists, inject it into a reserved agent input and
  // record false consumed provenance. Keep agent.__clarify__ → cross-clarify:
  // channelEdgeDataflowSkip deliberately treats that direction as a real
  // dependency when the target kind is clarify-cross-agent.
  //
  // RFC-306: the projection now lives in task-execution/domain/inboundEdges so
  // the branch-activation judgment reads EXACTLY the same edge set — see that
  // module's header for why a second hand-rolled copy would be a bug factory.
  const kindById = nodeKindIndex(definition)
  const incoming = collectDataflowInboundEdges(edges, nodeId, kindById)
  // RFC-074 provenance: which upstream node_run each source edge actually read.
  // Keyed by source nodeId — all edges from the same source resolve to the same
  // picked run, so this stays consistent across multi-port fan-in.
  const consumed: Record<string, string> = {}

  for (const edge of incoming) {
    const resolved =
      definition === undefined
        ? { ok: true as const, source: edge.source, exitedWrapperIds: [] }
        : resolveWorkflowSourceRef(definition, edge.source, nodeId, parents)
    if (!resolved.ok) {
      throw new Error(
        `wrapper-output-boundary-missing: source '${edge.source.nodeId}.${edge.source.portName}' is not exposed by ${describeWrapperKind(resolved.wrapperKind)} '${resolved.wrapperId}'`,
      )
    }
    const source = resolved.source
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, source.nodeId)))
    // RFC-074 (decision D10 / design §5.1): unify the source-run picker with
    // the freshness picker. Previously this sorted by (iteration desc,
    // retryIndex desc) with NO cci term and NO status filter — so it could read
    // a STALE pre-clarify row (higher retryIndex, lower cci) or even a pending
    // row's empty output while a done row carried the real content (the
    // three-picker drift the RFC indicts; baseline PB1/PB2). Now: among
    // top-level DONE rows within the iteration window, pick the highest
    // iteration (cross-boundary "latest visible", e.g. git-wrapper / loop
    // carry) and, within that iteration, the freshest by isFresherNodeRun.
    // RFC-098 B3 (audit S-7): the two-phase picker body now lives in
    // freshness.ts (pickUpstreamSourceRun) so computeWrapperConsumed shares
    // the exact same口径 — behavior here is unchanged.
    const run = pickUpstreamSourceRun(rows, iteration)
    if (!run) {
      log.warn('upstream node_run not found', { taskId, sourceNodeId: source.nodeId })
      continue
    }
    consumed[source.nodeId] = run.id
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, run.id))
    const port = outRows.find((o) => o.portName === source.portName)
    // RFC-306: a closed branch contributes NOTHING to a downstream prompt.
    //
    //   * source row `skipped` ⇒ it produced no ports at all;
    //   * port row `active === false` ⇒ its content is the author's REASON for
    //     closing the branch. That text must never reach another agent: it is
    //     one model's private justification, and injecting it as if it were data
    //     invents an input the author never wired.
    //
    // Reaching this line at all means the node was judged ACTIVE — i.e. some
    // OTHER inbound edge is live (joinMode 'any'), or the operator forced the
    // node to run. Empty string is exactly the right value for the dead legs.
    const inactive = run.status === 'skipped' || port?.active === false
    const content = inactive ? '' : (port?.content ?? '')
    const list = grouped.get(edge.target.portName) ?? []
    list.push(content)
    grouped.set(edge.target.portName, list)
  }

  const inputs: Record<string, string> = {}
  for (const [name, values] of grouped) {
    inputs[name] = values.length === 1 ? (values[0] ?? '') : values.join('\n\n---\n\n')
  }
  return { inputs, consumed }
}

// RFC-060 PR-E: pickLatestSourceRun + sumChildTokens were used only by the
// agent-multi runFanOutNode path (now removed). Deleted alongside the fan-out
// implementation.

/**
 * RFC-193 D16 — row-returning variant: derived-output projections (output
 * virtual nodes, wrapper outlet promotion) must copy `kind` + `archive_json`
 * alongside `content`, or the projected row 404s on the port-artifacts API
 * and goes dark after worktree GC (Codex design-gate P1).
 */
async function readPortRowAtIteration(
  db: DbClient,
  taskId: string,
  nodeId: string,
  portName: string,
  iteration: number,
): Promise<{
  runId: string | null
  content: string
  kind: string | null
  archiveJson: string | null
  /**
   * RFC-306: false when this port is NOT carrying a value this round — either
   * the producer marked it `active="false"`, or the producing run was itself
   * skipped. Every projection built on this read (output nodes, wrapper outlet
   * promotion, loop exit conditions) has to propagate it, or a closed branch
   * silently re-opens one layer up.
   */
  active: boolean
}> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
  // Pick the freshest DONE top-level run visible at this iteration. For a
  // normal in-loop source, the current iteration wins. For a historical
  // snapshot that references an outer source, iteration 0 remains visible in
  // later loop rounds instead of turning into a synthetic empty value.
  // RFC-096 (audit 附录 C #5): the done-only filter aligns this read with
  // buildFreshestSettledPerNode / the RFC-074 freshness口径 — without it, a
  // freshly minted non-done row (e.g. a concurrent designer-rerun pending
  // row) was picked as freshest, had no outputs, and the port read returned
  // '': a loop `port-empty` exit condition false-fired and the wrapper
  // persisted '' outputs. Non-done rows never have outputs (the runner only
  // persists ports on done), so skipping them can only surface the newest
  // REAL content. (The RFC-040 shadowing fix — pure id over retryIndex — is
  // inherited from isFresherNodeRun; the old comment describing the retired
  // (clarifyIteration, retryIndex, id) triple was stale and is gone.)
  const chosen = pickUpstreamSourceRun(rows, iteration)
  if (chosen === undefined) {
    // No settled run at all. `active: true` (not false) on purpose: "nothing has
    // run yet" is not a branch decision, and reporting it as inactive would let
    // a bookkeeping gap masquerade as a deliberate skip.
    return { runId: null, content: '', kind: null, archiveJson: null, active: true }
  }
  const out = await db
    .select()
    .from(nodeRunOutputs)
    .where(and(eq(nodeRunOutputs.nodeRunId, chosen.id), eq(nodeRunOutputs.portName, portName)))
  // A skipped producing run has no port rows at all, so the port-row check alone
  // would read it as "absent ⇒ active" (the compatibility default). The run
  // status has to be consulted too.
  const active = chosen.status !== 'skipped' && out[0]?.active !== false
  return {
    runId: chosen.id,
    content: active ? (out[0]?.content ?? '') : '',
    kind: out[0]?.kind ?? null,
    archiveJson: out[0]?.archiveJson ?? null,
    active,
  }
}

/**
 * Detect a cycle in a scope's structural upstream graph (the same `upstreamsOf`
 * the dispatch frontier walks). Returns a node id that lies on a cycle, or null
 * when the scope is acyclic. DFS with white/grey/black coloring; a grey re-visit
 * is a back-edge. `upstreamsOf` values are always in-scope (buildScopeUpstreams
 * drops out-of-scope sources), so the walk stays within the scope.
 */
function findScopeCycle(
  scopeNodes: WorkflowNode[],
  upstreamsOf: Map<string, string[]>,
): string | null {
  const color = new Map<string, 0 | 1 | 2>() // 0=unvisited 1=visiting 2=done
  const visit = (id: string): string | null => {
    color.set(id, 1)
    for (const up of upstreamsOf.get(id) ?? []) {
      const c = color.get(up) ?? 0
      if (c === 1) return up // back-edge → cycle
      if (c === 0) {
        const found = visit(up)
        if (found !== null) return found
      }
    }
    color.set(id, 2)
    return null
  }
  for (const n of scopeNodes) {
    if ((color.get(n.id) ?? 0) === 0) {
      const found = visit(n.id)
      if (found !== null) return found
    }
  }
  return null
}

function pickString(node: WorkflowNode, key: string): string | null {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function pickNumber(node: WorkflowNode, key: string): number | undefined {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function pickStringArray(node: WorkflowNode, key: string): string[] {
  const v = (node as Record<string, unknown>)[key]
  if (!Array.isArray(v)) return []
  return v.filter((s): s is string => typeof s === 'string')
}

interface Binding {
  name: string
  bind: { nodeId: string; portName: string }
}

function readBindings(node: WorkflowNode, key: string): Binding[] {
  const arr = (node as Record<string, unknown>)[key]
  if (!Array.isArray(arr)) return []
  const out: Binding[] = []
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.name !== 'string') continue
    const bind = rec.bind
    if (typeof bind !== 'object' || bind === null) continue
    const br = bind as Record<string, unknown>
    if (typeof br.nodeId !== 'string' || typeof br.portName !== 'string') continue
    out.push({ name: rec.name, bind: { nodeId: br.nodeId, portName: br.portName } })
  }
  return out
}

// RFC-092 T2: `readSnapshotForLatestRun` was deleted (its `orderBy(desc(retryIndex))`
// was one of the audit S-13 freshest-row forks, ruled out in favor of id-order).
// RFC-130: the retry-rollback machinery it fed is itself GONE — a fresh-session
// retry now DISCARDS the failed iso and re-branches from the current canonical
// state (runOneNode); the canonical worktree is never dirtied, so there is nothing
// to roll back.

/**
 * RFC-119 / RFC-056: read a prior run's captured port outputs and render them in
 * the agent's declared-output order via the shared `buildPriorOutputBlock`.
 * Shared by the cross-clarify update-mode path AND the generalized rerun path.
 * `onlyPorts` (RFC-119 D10) restricts which declared ports render — review-iterate
 * passes the single iterate-target port so it doesn't duplicate RFC-014's
 * `## Sibling Outputs`; everything else passes undefined (all ports).
 */
export async function composePriorOutputBlock(
  db: DbClient,
  priorRunId: string,
  agentOutputs: readonly string[],
  onlyPorts?: ReadonlySet<string>,
  envelopeNonce = '',
): Promise<string> {
  const captured = await db
    .select()
    .from(nodeRunOutputs)
    .where(eq(nodeRunOutputs.nodeRunId, priorRunId))
  const byPort = new Map(captured.map((r) => [r.portName, r.content]))
  const ordered = (agentOutputs ?? [])
    .filter((p) => onlyPorts === undefined || onlyPorts.has(p))
    .map((p) => ({ portName: p, content: byPort.get(p) ?? '' }))
    .filter((o) => o.content.length > 0)
  return buildPriorOutputBlock(ordered, envelopeNonce)
}

/**
 * RFC-119: the freshest prior run of this node at the SAME (iteration, shardKey),
 * minted before this run (id < current), that captured at least one output row —
 * REGARDLESS of final status. Unlike `priorDoneGenerationsForRun` (deliberately
 * `done`-only, for the clarify generation count) this MUST also see
 * review-supersede `canceled` rows: review reject/iterate flips the prior `done`
 * row to `canceled` but keeps its node_run_outputs. node_run_outputs are written
 * only on a run that reached `done`, so "has an output row" == "this run produced
 * output at some point".
 *
 * RFC-119 multi-process (D9 revision): **parent-agnostic** — it deliberately does
 * NOT filter `parentNodeRunId === null`, so it ALSO matches fan-out children
 * across wrapper generations. The (nodeId, shardKey) tuple is what scopes the
 * lookup, and no node has both top-level AND child runs at the same
 * (nodeId, iteration, shardKey): a single-process agent node has only top-level
 * runs (so the dropped filter is a no-op there); a fan-out inner node has only
 * shard children (keyed by shardKey); a fan-out aggregator node has only
 * aggregator children (shardKey null). So id-order within (nodeId, iteration,
 * shardKey) uniquely identifies the freshest prior run for all three dispatch
 * sites (single-process / fan-out shard / fan-out aggregator).
 *
 * Candidate set is tiny (one node's attempts this iteration), so the per-row
 * existence probe is cheap; the freshest candidate normally hits on the first.
 */
export async function freshestPriorRunWithOutput(
  db: DbClient,
  run: { taskId: string; nodeId: string; iteration: number; shardKey: string | null; id: string },
): Promise<typeof nodeRuns.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, run.taskId),
        eq(nodeRuns.nodeId, run.nodeId),
        eq(nodeRuns.iteration, run.iteration),
      ),
    )
  // shardKey filtered in memory (drizzle IS NULL handling varies; see
  // readPriorAgentSessionId). Walk freshest-first (largest id) and return the
  // first prior run (any parent — see doc) that captured output.
  const candidates = rows
    .filter((r) => (r.shardKey ?? null) === (run.shardKey ?? null) && r.id < run.id)
    .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))
  for (const c of candidates) {
    const has = await db
      .select({ p: nodeRunOutputs.portName })
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, c.id))
      .limit(1)
    if (has.length > 0) return c
  }
  return undefined
}

/**
 * RFC-183 (Codex design-gate P2#1/P2#4): the cause chain of this run's
 * lineage, newest-first, INCLUDING the current row — the input to
 * `continuesClarifyLineage` (nodeRunMint.ts). Top-level rows only, same
 * (taskId, nodeId, iteration, shardKey), id <= current. Persisted-row
 * derivation on purpose: the verdict must survive the attempt loop
 * (process-retry mints), daemon restarts (interrupted → 'revival' mints) and
 * resumes alike — an in-memory boolean carried across attempts cannot
 * (RFC-183 design §2.5).
 */
async function lineageCausesNewestFirst(
  db: DbClient,
  run: { taskId: string; nodeId: string; iteration: number; shardKey: string | null; id: string },
): Promise<Array<string | null>> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, run.taskId),
        eq(nodeRuns.nodeId, run.nodeId),
        eq(nodeRuns.iteration, run.iteration),
      ),
    )
  return rows
    .filter(
      (r) =>
        (r.shardKey ?? null) === (run.shardKey ?? null) &&
        r.parentNodeRunId === null &&
        r.id <= run.id,
    )
    .sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))
    .map((r) => r.rerunCause)
}

/**
 * RFC-074 PR-C: derive a node_run's clarify "generation" from id-order instead
 * of the retired `clarifyIteration` counter. The generation is the number of
 * earlier completed generations: top-level (`parentNodeRunId === null`) `done`
 * rows for the same (taskId, nodeId, iteration, shardKey) minted before this
 * run (id < beforeId). 0 = first generation. `done` (not canceled) so
 * review-iterate supersede markers don't inflate it; parent-null so fan-out
 * shard children don't either. Returns the prior rows too — the freshest is the
 * clarify-rerun's working draft (priorDoneDesigner) and the session-resume
 * source.
 */
async function priorDoneGenerationsForRun(
  db: DbClient,
  run: { taskId: string; nodeId: string; iteration: number; shardKey: string | null; id: string },
): Promise<Array<typeof nodeRuns.$inferSelect>> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, run.taskId),
        eq(nodeRuns.nodeId, run.nodeId),
        eq(nodeRuns.iteration, run.iteration),
        eq(nodeRuns.status, 'done'),
      ),
    )
  return rows.filter(
    (r) =>
      (r.shardKey ?? null) === (run.shardKey ?? null) &&
      r.parentNodeRunId === null &&
      r.id < run.id,
  )
}

/**
 * RFC-026: look up the opencode session id captured on the agent's PRIOR
 * clarify round. RFC-074 PR-C: the retired `clarifyIteration` counter is
 * replaced by id-order — the prior generation is simply the freshest top-level
 * `done` row for this node minted BEFORE the current run (id < beforeId),
 * scoped to the same (taskId, nodeId, iteration, shardKey). That row emitted
 * the `<workflow-clarify>` envelope the user just answered. Returns null when
 * nothing matches (will then degrade to isolated via `decideResumeSessionId`).
 */
async function readPriorAgentSessionId(
  db: DbClient,
  args: {
    taskId: string
    agentNodeId: string
    shardKey: string | null
    iteration: number
    beforeId: string
  },
): Promise<string | null> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, args.taskId),
        eq(nodeRuns.nodeId, args.agentNodeId),
        eq(nodeRuns.iteration, args.iteration),
        eq(nodeRuns.status, 'done'),
      ),
    )
    .orderBy(desc(nodeRuns.id))
  // shardKey is filtered in memory because drizzle's IS NULL handling
  // varies; the result set is tiny (one row per prior attempt). Walk newest
  // first (largest id) and return the first prior generation that captured a
  // session id.
  const filtered = rows.filter(
    (r) =>
      (r.shardKey ?? null) === args.shardKey && r.parentNodeRunId === null && r.id < args.beforeId,
  )
  for (const r of filtered) {
    if (r.opencodeSessionId !== null && r.opencodeSessionId !== '') {
      return r.opencodeSessionId
    }
  }
  return null
}

/**
 * RFC-026: read concatenated stderr text recorded for a node_run via the
 * runner's stderr pump. Used post-spawn to sniff for `session not found`
 * style messages so the inline-mode fallback can degrade gracefully.
 */
async function readStderrText(db: DbClient, nodeRunId: string): Promise<string> {
  const rows = await db
    .select()
    .from(nodeRunEvents)
    .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), eq(nodeRunEvents.kind, 'stderr')))
    .orderBy(asc(nodeRunEvents.id))
  return rows.map((r) => r.payload).join('\n')
}

/**
 * RFC-026: record an info/warning row about inline-mode session resume.
 *
 * Both flavors are written as `kind: 'text'` (the closest enum value that
 * doesn't collide with stderr / step-finish / etc.) with a structured JSON
 * payload + a stable `[rfc026/...]` prefix. PR-B's frontend reads the
 * prefix to render the row with an info or warning style; until then the
 * payload is plain-readable in the events tab.
 */
async function recordClarifyInlineEvent(
  db: DbClient,
  nodeRunId: string,
  args:
    | {
        level: 'info'
        sessionIdPrefix: string
        extra?: Record<string, unknown>
      }
    | {
        level: 'warning'
        reason: ClarifyInlineFallbackReason
        extra?: Record<string, unknown>
      },
): Promise<void> {
  const tag = args.level === 'info' ? '[rfc026/inline-session-resumed]' : '[rfc026/inline-fallback]'
  const payload =
    args.level === 'info'
      ? JSON.stringify({
          rfc: 'rfc026',
          code: 'clarify-session-resumed',
          sessionIdPrefix: args.sessionIdPrefix,
          ...args.extra,
        })
      : JSON.stringify({
          rfc: 'rfc026',
          code: 'inline-clarify-fallback-to-isolated',
          reason: args.reason,
          ...args.extra,
        })
  await db.insert(nodeRunEvents).values({
    nodeRunId,
    ts: Date.now(),
    kind: 'text',
    payload: `${tag} ${payload}`,
  })
}

/**
 * Build the structural dependency map for one recursive execution scope.
 *
 * Flat workflow edges are projected to the direct representatives at their
 * endpoint LCA. Therefore `external → loop-inner` becomes
 * `external → loop` in the parent scope, while the child scope correctly sees
 * no local dependency for that already-settled external value. This same
 * projection handles git wrappers, nested wrappers, and dependencies leaving a
 * wrapper. Implicit review/output/loop references use the identical path.
 */
function buildScopeUpstreams(
  definition: WorkflowDefinition,
  ids: Set<string>,
  scopeId: string | null,
  parents: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const scopeNodes = definition.nodes.filter((node) => ids.has(node.id))
  const m = new Map<string, string[]>()
  for (const n of scopeNodes) m.set(n.id, [])
  // Build a quick node-kind lookup so the channel-edge skip can
  // distinguish RFC-023 clarify targets (skip the edge — clarify nodes
  // are dispatched out-of-band by the runner) from RFC-056 cross-clarify
  // targets (KEEP the edge — the cross-clarify node legitimately
  // depends on the questioner reaching a terminal state).
  const kindById = new Map<string, string>()
  for (const n of definition.nodes) kindById.set(n.id, n.kind)

  const addProjected = (sourceNodeId: string, targetNodeId: string): void => {
    const projected = projectWorkflowDependency(sourceNodeId, targetNodeId, parents)
    if (projected === null || projected.scopeId !== scopeId) return
    if (projected.sourceNodeId === projected.targetNodeId) return
    if (!ids.has(projected.sourceNodeId) || !ids.has(projected.targetNodeId)) return
    const list = m.get(projected.targetNodeId) ?? []
    if (!list.includes(projected.sourceNodeId)) list.push(projected.sourceNodeId)
    m.set(projected.targetNodeId, list)
  }

  for (const e of definition.edges) {
    // Fan-out boundary mirrors are consumed by runFanoutWrapperNode; projecting
    // them would only collapse wrapper↔inner into a self-dependency.
    if (e.boundary !== undefined) continue
    // RFC-147: channel-edge dataflow semantics come from the shared
    // system-channel-port registry. The nuanced rule lives there —
    // agent.__clarify__ → clarify is dispatched out-of-band (skip to
    // prevent agent→clarify→agent cycles) while a cross-clarify TARGET
    // keeps the edge as a real dependency (2026-05-22 bug: skipping it
    // made cross-clarify a no-upstream leaf the dispatcher re-fired every
    // tick); answer / back-channel ports are prompt-injected, never
    // dataflow inputs.
    if (channelEdgeDataflowSkip(e, (id) => kindById.get(id))) continue
    const resolved = resolveWorkflowSourceRef(definition, e.source, e.target.nodeId, parents)
    addProjected(resolved.ok ? resolved.source.nodeId : e.source.nodeId, e.target.nodeId)
  }
  // RFC-060 PR-E: agent-multi removed; its sourcePort dep handling deleted
  // (wrapper-fanout uses boundary edges instead, which are real graph edges).
  // Walk implicit dependencies from the whole flat definition, then let the
  // LCA projection select the dependency that belongs to this scope. Limiting
  // this walk to `scopeNodes` loses `external → nested review/output` at the
  // parent scope for exactly the same reason raw cross-scope edges used to be
  // lost.
  for (const n of definition.nodes) {
    // RFC-005: review.inputSource.nodeId is an implicit upstream dep — it
    // isn't an edge in the user-authored graph, but the scheduler must wait
    // for the source node before parking the review at awaiting_review.
    if (n.kind === 'review') {
      const inp = (n as Record<string, unknown>).inputSource as { nodeId?: unknown } | undefined
      if (inp === undefined || typeof inp.nodeId !== 'string') continue
      const portName =
        typeof (inp as { portName?: unknown }).portName === 'string'
          ? ((inp as { portName: string }).portName ?? '')
          : ''
      const resolved = resolveWorkflowSourceRef(
        definition,
        { nodeId: inp.nodeId, portName },
        n.id,
        parents,
      )
      addProjected(resolved.ok ? resolved.source.nodeId : inp.nodeId, n.id)
    }
    // Output nodes carry their dependencies in `ports[].bind` (not always as
    // edges; the canvas editor emits both in practice but bindings are the
    // canonical form per workflow.validator.ts §output bindings). Treating
    // them as implicit upstream deps keeps the scheduler from snapshotting
    // empty port content when an output node would otherwise be considered
    // a graph root with no incoming edges.
    if (n.kind === 'output') {
      const bindings = readBindings(n, 'ports')
      for (const b of bindings) {
        const resolved = resolveWorkflowSourceRef(definition, b.bind, n.id, parents)
        addProjected(resolved.ok ? resolved.source.nodeId : b.bind.nodeId, n.id)
      }
    }
    // Defensive compatibility for historical/direct-seeded snapshots whose
    // loop condition or output binding points outside the loop. Current
    // validation rejects these references, but projecting them here keeps old
    // snapshots ordered and avoids the former empty-read race.
    if (n.kind === 'wrapper-loop') {
      const condition = parseExitCondition((n as Record<string, unknown>).exitCondition)
      if (condition !== null) addProjected(condition.nodeId, n.id)
      for (const binding of readBindings(n, 'outputBindings')) {
        addProjected(binding.bind.nodeId, n.id)
      }
    }
  }
  for (const list of m.values()) list.sort()
  return m
}

/**
 * Direct containment map: every child node id → its immediate wrapper. Chained
 * entries (`inner → nested wrapper → outer wrapper`) retain the full nesting
 * relation; nodes absent from the map are top-level. The shared implementation
 * is also used by layout/source-boundary projection so the three surfaces
 * cannot drift.
 */
// RFC-193: exported for lifecycleRepair S1's scopeRoot derivation (§4.6) —
// the repair path re-invokes dispatchReviewNode OUTSIDE the scheduler, so it
// must recover "which wrapper contains this review" the same way runTask does.
export function buildContainerMap(def: WorkflowDefinition): Map<string, string> {
  return buildWorkflowScopeParentMap(def)
}
