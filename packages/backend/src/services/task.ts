// Task service — start / list / get.
// Cancel/resume/retry land in P-1-15 + M3 (P-3-08, P-3-09).

import type {
  ScriptLanguage,
  PlannedDirectoryNode,
  PlannedRepo,
  FailureCode,
  NodeKind,
  NodeRun,
  NodeRunEvent,
  NodeRunEventsResponse,
  NodeRunOutput,
  StartTask,
  Task,
  TaskDiff,
  TaskListItem,
  TaskLaunchOrigin,
  TaskNodeRuns,
  TaskRepo,
  TaskSummary,
  TriggerContext,
  WebhookTaskSourceLink,
} from '@agent-workflow/shared'
import type { DwState } from '@agent-workflow/shared'
import {
  isRetryableGitFailure,
  REPO_PREP_NODE_ID,
  assignBranchNames,
  directChildren,
  exclusionPlanFor,
  mountDepth,
  orderForMaterialize,
  CommitPushMetaSchema,
  NODE_KIND_BEHAVIORS,
  WorkflowDefinitionSchema,
  allowedFromForTaskEvent,
  diffWorkflowForSync,
  emptyWorkflowSyncDiff,
  isTerminalNodeRunStatus,
  migrateWorkflowDefinitionToLatest,
  parseTriggerContextJson,
  webhookTaskSourceLinkOf,
} from '@agent-workflow/shared'
import type {
  CommitPushMeta,
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
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  type SQL,
} from 'drizzle-orm'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { insertWorkgroupTaskStateTx, setDwStateTx } from '@/services/workgroup/state'
import {
  agents,
  cachedRepos,
  clarifyRounds,
  docVersions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  runtimeSessionLeases,
  taskCollaborators,
  taskRepos,
  taskSpaceNodes,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import type { SecretBox } from '@/auth/secretBox'
import { unsealRepoUrl } from '@/services/repoCredentials'
import { canonicalRepoKeysWire } from '@/services/repoLabels'
import { buildLaunchCollabRows } from '@/services/taskCollab'
import { getWorkflow } from '@/services/workflow'
import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import { assertWorkflowLaunchInputs } from '@/services/workflowLaunchInputs'
import { finishClaimedWebhookWorkspacePrune, materializingSpaces } from '@/services/gc'
import { rollbackNodeRunWorktrees } from '@/services/nodeRollback'
import { WRAPPER_KINDS } from '@/services/dispatchFrontier'
import type { RollbackOutcome } from '@/services/nodeRollback'
import { killStaleRunProcessTree } from '@/util/process'
import type { StaleRunKillOutcome } from '@/util/process'
import type { SourceTerminationSnapshot } from '@/modules/task-execution/public/types'
import {
  sourceTerminationRevivalError,
  type TaskStopCause,
} from '@/modules/task-execution/domain/sourceTermination'
import { InMemoryTaskDriverSupervisor } from '@/modules/task-execution/infrastructure/inMemoryTaskDriverSupervisor'
import type {
  TaskDriverStopResult,
  TaskDriverStopTicket,
} from '@/modules/task-execution/ports/taskDriverSupervisor'
import { repairRuntimeSessionLeasesAfterOrphanReap } from '@/services/runtimeSessionLease'
import { recordRecoveryEvent } from '@/services/recovery'
import {
  setNodeRunStatus,
  setTaskStatus,
  transitionTaskStatusByEvent,
  trySetTaskStatus,
} from '@/services/lifecycle'
import type { TaskStatusUpdateExtra } from '@/services/lifecycle'
import { nextRetryIndex, mintNodeRun } from '@/services/nodeRunMint'
import { pickFreshestRun } from '@/services/freshness'
import { listAvailableRefs, resolveCachedRepo } from '@/services/gitRepoCache'
import {
  commitGitignorePreset,
  findTrackedPathUnderMounts,
  cleanupCreatedWorktree,
  createWorktree,
  gitDiffSnapshot,
  initScratchRepo,
  isGitWorkTree,
  type WorktreeCleanupProvenance,
  type WorktreeLifecycleHookEvent,
  worktreeDiff,
} from '@/util/git'
import { redactGitUrl } from '@agent-workflow/shared'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { readArchivedEvents } from '@/services/eventsArchive'
import {
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  taskBroadcaster,
  tasksListBroadcaster,
} from '@/ws/broadcaster'
import { runTask, type RunTaskOptions } from './scheduler'
import { Paths } from '@/util/paths'
import { createLogger, type Logger } from '@/util/log'
import { resolveRepoGroupLayout } from '@/services/repoGroup'
import { parseInjectedSnapshotJson } from './memoryInject'
import { parsePortValidationFailuresJson } from './envelope'
import { compareNodeRunsForTimeline, deriveReviewRoundTiming } from './reviewRoundStart'
import { isHumanReviewConclusion, selectCurrentReviewRound } from '@agent-workflow/shared'
import { clarifyNavKindForRoundStatus, type ClarifyRoundStatus } from '@agent-workflow/shared'
import { loadOwnerIdentities } from '@/services/ownerIdentity'
import type { Actor } from '@/auth/actor'
import { freezeCallClosure } from '@/services/execution/closure'
import {
  assertTriggerPreflight,
  triggerPreflightIssue,
  triggerSourceFromContext,
} from '@/services/execution/triggerPreflight'
import { collectExecutionRefs } from '@agent-workflow/shared'
import {
  defaultTaskAuthorizationRef,
  taskOwnershipScopeCondition,
} from '@/services/taskAuthorization'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'
import {
  deriveTaskLaunchOrigin,
  taskLaunchAdmissionIssue,
  type TaskLaunchProvenance,
} from '@/modules/task-execution/domain/taskLaunchOrigin'

/**
 * RFC-243 实现门 P0-1 — closure freezing needs the LAUNCH ACTOR (visibility
 * fence on the name fallback). Call-node-free definitions skip everything
 * (byte-compat). A call-bearing launch WITHOUT an actor (internal faces never
 * produce one today) fails closed rather than freezing blind.
 */
async function freezeClosureForLaunch(
  deps: StartTaskDeps,
  workflowId: string,
  definition: WorkflowDefinition,
): Promise<string | null> {
  const refs = collectExecutionRefs(definition)
  if (refs.workflowNames.size === 0 && refs.workgroupNames.size === 0) return null
  if (deps.launchActor === undefined) {
    throw new ValidationError(
      'workflow-call-ref-missing',
      'call-node launches require an authenticated launch actor for closure resolution',
    )
  }
  return freezeCallClosure(deps.db, { id: workflowId, definition }, deps.launchActor)
}

/**
 * RFC-292 reusable no-materialization launch preparation for public multipart
 * and ordinary startTask paths. Returns the closure frozen for this exact root
 * so callers may reuse it for static validation; startTask still repeats the
 * preparation to close route-to-service TOCTOU races.
 */
export async function prepareWorkflowTriggerLaunch(args: {
  deps: StartTaskDeps
  workflowId: string
  definition: WorkflowDefinition
}): Promise<string | null> {
  const definition = migrateWorkflowDefinitionToLatest(args.definition)
  const closureJson = await freezeClosureForLaunch(args.deps, args.workflowId, definition)
  assertTriggerPreflight({
    root: definition,
    closureJson,
    source: triggerSourceFromContext(args.deps.triggerContext),
  })
  return closureJson
}

const log = createLogger('task')

/**
 * Process-local registry of in-flight task AbortControllers. Used by
 * cancelTask to interrupt the running scheduler/runner pipeline.
 *
 * Survives only within this daemon process. On daemon restart, in-flight
 * tasks are reconciled by the startup orphan scan (P-4-07) — out of scope
 * for M1.
 */
const taskDriverRegistry = new InMemoryTaskDriverSupervisor()

const DRIVER_ATTACHABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(['pending', 'running'])

/**
 * RFC-303: driver ownership and source termination share the same per-task
 * coordinator.  A terminal fence that commits first rejects the attach; an
 * attach that wins first becomes visible to requestTaskDriverStop before the
 * coordinator is released.
 */
async function tryAttachTaskDriver(
  db: DbClient,
  taskId: string,
  controller: AbortController,
): Promise<'attached' | 'rejected-status-or-source-fence'> {
  return withTaskReviewMutationLock(taskId, async () => {
    const row = db
      .select({ status: tasks.status, sourceTerminationFence: tasks.sourceTerminationFence })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
      .all()[0]
    if (
      row === undefined ||
      !DRIVER_ATTACHABLE_STATUSES.has(row.status) ||
      row.sourceTerminationFence !== null ||
      !taskDriverRegistry.tryAttach(taskId, controller)
    ) {
      return 'rejected-status-or-source-fence'
    }
    return 'attached'
  })
}

/** RFC-300: release the in-process scheduler owner before touching its
 * workspace, then complete any lifecycle-created durable prune claim. The
 * identity check preserves RFC-097's successor-controller fence. */
async function releaseTaskDriverAndFinalizeWorkspace(
  db: DbClient,
  taskId: string,
  controller: AbortController,
): Promise<void> {
  const unreaped = depsUnreapedProcessCode(db, taskId)
  if (
    !taskDriverRegistry.release(
      taskId,
      controller,
      unreaped === null ? { kind: 'released' } : { kind: 'unreaped', code: unreaped },
    )
  ) {
    return
  }
  await finishClaimedWebhookWorkspacePrune(db, taskId)
}

function depsUnreapedProcessCode(db: DbClient, taskId: string): string | null {
  const row = db
    .select({ errorMessage: nodeRuns.errorMessage })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), like(nodeRuns.errorMessage, '%child-unkillable%')))
    .limit(1)
    .all()[0]
  return row === undefined ? null : 'child-unkillable'
}

/** RFC-097 (audit S-8/S-23): is an in-process scheduler loop attached to this
 *  task right now? Used by resume/retry entry rejection and lifecycleRepair's
 *  scheduler-liveness preflight. */
export function isTaskActive(taskId: string): boolean {
  return taskDriverRegistry.has(taskId)
}

/** RFC-222 — test-only: inject/clear the in-memory active-task set so the delete
 *  front-gate ('task-active') can be exercised without a live scheduler loop. */
export function __setActiveTaskForTesting(taskId: string | undefined): void {
  taskDriverRegistry.clearForTesting()
  if (taskId !== undefined) taskDriverRegistry.tryAttach(taskId, new AbortController())
}

/** Test-only: register one specific controller without clearing sibling task
 *  drivers, so parent/child cancellation lock ordering can be exercised. */
export function __registerActiveTaskForTesting(taskId: string, controller: AbortController): void {
  taskDriverRegistry.tryAttach(taskId, controller)
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
export function abortAllActiveTasks(reason?: string): string[] {
  return taskDriverRegistry.abortAll(reason)
}

/** RFC-303 task-execution adapter used only by the source-termination
 * participant. Callers receive an exact owner ticket, never the controller. */
export function requestTaskDriverStop(
  taskId: string,
  cause: TaskStopCause,
): TaskDriverStopTicket | 'no-active-owner' {
  return taskDriverRegistry.requestStop(taskId, cause)
}

export function awaitTaskDriverStopped(
  ticket: TaskDriverStopTicket,
): Promise<TaskDriverStopResult> {
  return taskDriverRegistry.awaitStopped(ticket)
}

/** RFC-303: a terminal effect may cancel a task that has no process-local
 * scheduler owner (pending/waiting or recovered row). In that case there is no
 * driver `finally` to complete RFC-300's already-claimed workspace prune. */
export async function finalizeCanceledTaskWithoutDriver(
  db: DbClient,
  taskId: string,
): Promise<void> {
  await finishClaimedWebhookWorkspacePrune(db, taskId)
}

export interface StartTaskDeps {
  /**
   * RFC-204: needed to unseal `cached_repos.url_enc` for a reuse-by-id launch.
   * Optional so tests / internal faces that never reuse can omit it; when a row
   * IS sealed and this is missing, the launch fails closed rather than guessing.
   */
  secretBox?: SecretBox
  db: DbClient
  /** Test/recovery seam; production uses the structured process-tree reaper. */
  killStaleRunProcessTree?: typeof killStaleRunProcessTree
  /** Override app home (tests). Defaults to `Paths.root`. */
  appHome?: string
  /** Default per-node timeout (ms). Defaults from settings; tests can pin. */
  defaultPerNodeTimeoutMs?: number
  /**
   * RFC-287 G7：把仓库准备推迟到任务行落库之后（仅 JSON-body 启动）。
   *
   * 开启后 `startTask` 只做「填错了立刻告诉你」的同步校验，任务先落 `pending`，
   * 克隆/抓取/多仓物化/建工作树由 `runTask` 认领后作为第 0 步推进；失败转 `failed`
   * 且 git 原文可见。multipart（要把上传物写进工作树）与 preCreated（调用方已建好
   * 树）必须保持预物化语义，故这两条路径不受本开关影响。
   */
  deferRepoPreparation?: boolean
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
  /** RFC-243 实现门 P0-1: the launch actor — closure name-resolution visibility fence. */
  launchActor?: Actor
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
  /**
   * RFC-020: when the multipart route has already created the worktree (so it
   * can land upload files into it BEFORE the task row exists), it passes the
   * pre-materialized worktree info in here. `startTask` then skips its own
   * `createWorktree` call and uses these values verbatim. JSON-bodied calls
   * never pass this; we generate a fresh ulid + worktree as before.
   */
  preCreatedWorktree?: PreCreatedWorktree
  /**
   * RFC-107 — the multipart-upload route resolves the (single) repo source
   * BEFORE materializing the worktree (it must turn a `repoUrl` into a local
   * cache path so it can clone, build the worktree, and write uploads into it).
   * It threads that already-resolved source back in here so `startTask`'s own
   * resolution loop reuses it for the single repo (index 0) instead of calling
   * `resolveRepoSourceSingle` a second time — guaranteeing the URL is resolved
   * EXACTLY ONCE (no redundant clone/fetch) on both the success handoff and the
   * materialize-failure (`earlyError`) handoff. Only meaningful for single-repo
   * bodies (multipart upload is single-repo only); multi-repo ignores it.
   */
  preResolvedSource?: ResolvedRepoSource
  /**
   * RFC-165 (F3): the fully-materialized space handed off by a route that had
   * to touch the workspace before the task row exists (multipart uploads).
   * Carries success OR failure (earlyError) — startTask consumes it verbatim
   * and never re-resolves / re-materializes. Supersedes the
   * preCreatedWorktree+preResolvedSource pair for the multipart flow (the
   * pair remains for the legacy fusion handoff until its internalSource
   * migration).
   */
  materializedSpace?: MaterializedSpace
  /**
   * RFC-165 (F4): the framework-INTERNAL local-path launch face. Deliberately
   * a deps field (never a body field) so it is unreachable from any wire —
   * the public StartTask contract retires path mode, but fusion (and the
   * test suite via `startTaskWithLocalRepo`) legitimately launch against a
   * pre-existing local repo. Mutually exclusive with `scratch` / `repoUrl` /
   * `repos`; may be combined with `preCreatedWorktree` (paths must agree).
   * Tasks launched through it persist `space_kind='internal'` (GC-excluded —
   * fusion's approval flow needs the dirs to survive terminal states).
   */
  internalSource?: { kind: 'local-path'; repoPath: string; baseBranch: string }
  /**
   * RFC-036 — launcher user id. NULL falls back to the legacy single-user
   * behavior (ownerUserId stays NULL; no collab/assignment rows written).
   * The route passes actor.user.id when the actor is a real user; daemon-
   * token callers can leave it unset or pass '__system__' explicitly.
   */
  actorUserId?: string
  /**
   * RFC-301 — trusted, task-owned root launch provenance. Required for every
   * root production launch; forbidden for call children, which read the exact
   * parent row inside the initial INSERT transaction instead.
   */
  launchProvenance?: TaskLaunchProvenance
  /**
   * RFC-159 — when the scheduled-task background loop fires a task it passes the
   * originating `scheduled_tasks.id` here; `startTask` stamps it onto the task row
   * (`tasks.scheduled_task_id`) atomically. Omitted for manual launches.
   */
  scheduledTaskId?: string
  /**
   * RFC-257 — webhook-trigger attribution (`tasks.webhook_trigger_id` /
   * `webhook_fire_id`), stamped atomically like scheduledTaskId. Set by the
   * executor facade from the `webhook` invoker; omitted everywhere else.
   */
  webhookTriggerId?: string
  webhookFireId?: string
  /**
   * RFC-292 — complete nested launch-source context shared by every authored
   * trigger-aware sink. It is internal execution input and MUST be serialized
   * into the initial task INSERT before scheduler can read/cache the row.
   * Undefined means a non-webhook launch; callers may not supply a flat map.
   */
  triggerContext?: TriggerContext
  /** RFC-303: root Webhook launch snapshot; child launches inherit in the INSERT tx. */
  sourceTerminationSnapshot?: SourceTerminationSnapshot
  /** RFC-303: process-local pre-task owner for clone/fetch/materialization. */
  sourceTerminationLaunchSignal?: AbortSignal
  /** RFC-303: durable launch gate, also invoked inside the initial task INSERT tx. */
  sourceTerminationAdmission?: () => void
  /**
   * RFC-164: workgroup launch payload. `snapshotJson` REPLACES the workflow
   * row's definition as the frozen workflow_snapshot (the builtin host row is
   * an FK anchor; the real per-launch structure is synthesized — design §2/§3).
   * Stamped atomically with the task INSERT like scheduledTaskId.
   */
  workgroupLaunch?: { workgroupId: string; configJson: string; snapshotJson: string; dw?: DwState }
  /**
   * RFC-243 §6.2 L: node-invoked CHILD launch payload. `frozenSnapshotJson`
   * (the child definition frozen in the PARENT's ref closure at parent launch,
   * D9) replaces the referenced workflow row's CURRENT definition as the
   * snapshot AND as the definition every launch gate evaluates — the resource
   * row serves only as the FK anchor. `refClosureJson` is the closure subset
   * handed down for grandchildren. Parent linkage columns are stamped
   * atomically with the task INSERT.
   */
  callLaunch?: {
    parentTaskId: string
    parentNodeRunId: string
    invocationDepth: number
    /**
     * Frozen child definition (call-workflow arm). NULL for the workgroup arm
     * — there the host snapshot is composed by the frozen launch face and
     * rides `workgroupLaunch.snapshotJson`; only the parent linkage columns
     * come from here.
     */
    frozenSnapshotJson: string | null
    refClosureJson: string | null
  }
  /**
   * RFC-165 §4: single-agent launch payload. `snapshotJson` (the synthesized
   * `__agent_host__` snapshot) replaces the FK-anchor row's stub definition
   * as the frozen workflow_snapshot; `agentName` lands in
   * `tasks.source_agent_name` (taskExecutionKind's 'agent' discriminator).
   * The launch transaction re-checks the agent still exists (F17) — a
   * concurrent delete between the service-level 404 gate and the INSERT
   * must fail the launch, not mint a task for a ghost agent.
   *
   * RFC-175 (§2e): `agentId` is the resolved stable id threaded from
   * `startAgentTask`. The in-tx re-check asserts the same-name agent still has
   * THIS id (belt-and-suspenders behind the launch reservation) and
   * `tasks.source_agent_id` is written from it — so a post-migration relaunch
   * can verify the subject on re-launch.
   */
  agentLaunch?: { agentName: string; agentId: string; snapshotJson: string }
  /**
   * RFC-199 T6.5 deterministic race seam. Production callers never set this;
   * backend regressions use it to linearize workflow delete/version writers
   * immediately before or after the task-row transaction without sleeps.
   */
  workflowLaunchCommitHook?: (event: WorkflowLaunchCommitHookEvent) => void | Promise<void>
  /** RFC-199 test seam for deterministic remove/ref/root cleanup failures. */
  workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
}

export interface WorkflowLaunchCommitHookEvent {
  stage: 'materialized-before-task-commit' | 'task-committed'
  workflowId: string
  capturedWorkflowVersion: number
  taskId: string
  spaceKind: MaterializedSpace['kind']
  worktreePath: string
  repoWorktrees: ReadonlyArray<{
    repoPath: string
    worktreePath: string
    branch: string
  }>
}

/**
 * RFC-020: a worktree the caller has already created (e.g. multipart upload
 * flow) so `startTask` can land its task row with the right paths without
 * shelling out to git twice.
 */
export interface PreCreatedWorktree {
  taskId: string
  worktreePath: string
  branch: string
  baseCommit: string | null
  /**
   * Explicit ownership handoff. `borrowed` is never recursively removed;
   * fusion hands off its ephemeral repo as `owned-root`; callers using
   * materializeWorktree hand off the exact linked-worktree provenance.
   */
  cleanup:
    | { kind: 'borrowed' }
    | { kind: 'owned-root'; path: string }
    | { kind: 'linked-worktree'; provenance: WorktreeCleanupProvenance }
}

/**
 * Create a worktree for a fresh task. Pulled out of `startTask` so the
 * multipart upload route can call it BEFORE the task row exists and write
 * uploaded files into the resulting directory.
 *
 * Returns `earlyError !== null` on failure with the worktree fields blank
 * (mirrors the failure path `startTask` baked in before this refactor).
 */
export async function materializeWorktree(opts: {
  /** Resolved local repoPath (cache dir for URL mode, user-supplied for path mode). */
  repoPath: string
  baseBranch: string | undefined
  taskId: string
  appHome: string
  /**
   * RFC-066: when provided, the worktree lands at this absolute path
   * instead of the default `{appHome}/worktrees/{repoSlug}/{taskId}` layout.
   * The multi-repo branch supplies per-repo paths under
   * `{appHome}/worktrees/multi/{taskId}/<basename>/`; the single-repo
   * branch leaves this undefined to inherit the legacy layout byte-for-byte.
   */
  overrideWorktreePath?: string
  /**
   * RFC-075: optional working branch (task-level, applied to this repo). When
   * set, createWorktree checks out this branch instead of the default
   * isolation branch; validation failures (`working-branch-*`) propagate as
   * thrown ValidationErrors (422 launch failure) rather than `earlyError`.
   */
  workingBranch?: string
  /** RFC-075/067: identity for the framework's merge commit on branch reuse. */
  gitUserName?: string | null
  gitUserEmail?: string | null
  /** RFC-248 D17: sparse 只检出该仓内子目录（非 cone）。 */
  sparseSubdir?: string
  /** RFC-248 D14: 显式分支名（同一源仓在组里出现多次时带序号）。 */
  branchName?: string
  /** RFC-199 deterministic create/post-add race seam; tests only. */
  lifecycleHook?: (event: WorktreeLifecycleHookEvent) => void | Promise<void>
  /** RFC-303 protected Webhook launch owner. */
  signal?: AbortSignal
}): Promise<{
  worktreePath: string
  branch: string
  baseCommit: string | null
  earlyError: string | null
  cleanup: WorktreeCleanupProvenance | null
  // RFC-034: surface submodule init outcome so caller can emit warning event.
  submoduleInitOk: boolean
  submoduleInitError: string | null
  hasSubmodules: boolean
}> {
  try {
    const wt = await createWorktree({
      repoPath: opts.repoPath,
      taskId: opts.taskId,
      ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
      appHome: opts.appHome,
      ...(opts.overrideWorktreePath !== undefined
        ? { overrideWorktreePath: opts.overrideWorktreePath }
        : {}),
      ...(opts.workingBranch !== undefined ? { workingBranch: opts.workingBranch } : {}),
      ...(opts.sparseSubdir !== undefined ? { sparseSubdir: opts.sparseSubdir } : {}),
      ...(opts.branchName !== undefined ? { branchName: opts.branchName } : {}),
      ...(opts.gitUserName != null ? { gitUserName: opts.gitUserName } : {}),
      ...(opts.gitUserEmail != null ? { gitUserEmail: opts.gitUserEmail } : {}),
      ...(opts.lifecycleHook !== undefined ? { lifecycleHook: opts.lifecycleHook } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    return {
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
      earlyError: null,
      cleanup: wt.cleanup,
      submoduleInitOk: wt.submoduleInitOk,
      submoduleInitError: wt.submoduleInitError,
      hasSubmodules: wt.hasSubmodules,
    }
  } catch (err) {
    // RFC-075: a user-requested working branch that can't be honored (invalid
    // name, in use, base fetch failed, merge conflict) is a hard launch
    // failure surfaced as 422 — let the typed error propagate instead of
    // degrading into a `failed` task row.
    if (err instanceof ConflictError && err.code === 'webhook-mr-launch-terminal') {
      throw err
    }
    if (
      err instanceof DomainError &&
      (err.code.startsWith('working-branch-') ||
        err.code === 'worktree-post-add-cleanup-incomplete')
    ) {
      throw err
    }
    return {
      worktreePath: '',
      branch: '',
      baseCommit: null,
      earlyError: err instanceof Error ? err.message : String(err),
      cleanup: null,
      submoduleInitOk: true,
      submoduleInitError: null,
      hasSubmodules: false,
    }
  }
}

export interface ResolvedRepoSource {
  repoPath: string
  baseBranch: string | undefined
  /** RAW source URL — may carry credentials. Redact before logging/persisting. */
  repoUrl: string | null
  /** RFC-204: the cached mirror this resolved to (deterministic ref key). */
  cachedRepoId: string | null
  /** RFC-068: path-mode opt-in fetch error message. null when feature was off or succeeded. */
  pathFetchError: string | null
  /** RFC-068: URL-mode FF warnings. Empty when nothing relevant. */
  ffWarnings: Array<{ branch: string; warning: string }>
}

/**
 * RFC-066: collapse a `StartTask` body into the canonical per-repo spec list
 * the rest of `startTask` walks. Legacy single-repo bodies (top-level
 * `repoPath` / `repoUrl` / `baseBranch` / `ref` fields) are converted to a
 * length-1 array so the downstream code path is uniform; v2 bodies that
 * already supplied `repos: [...]` pass through verbatim. `fetchBeforeLaunch`
 * is left on `input` (a single top-level flag covers every repo in a
 * multi-repo task by design — see RFC-068 §"多仓" interaction notes).
 */
/**
 * RFC-165: INTERNAL per-repo source spec — deliberately WIDER than the wire
 * `StartTaskRepo` (URL-only): path specs survive here for the framework's
 * internal local-path face (`deps.internalSource`, fusion, the test helper).
 * Nothing on any route constructs a path variant.
 */
export type RepoSourceSpec =
  | { repoUrl: string; ref?: string }
  /** RFC-204: reuse an existing mirror; the daemon resolves the real URL itself. */
  | { cachedRepoId: string; ref?: string }
  | { repoPath: string; baseBranch: string }

export function normalizeStartTaskRepos(input: StartTask): RepoSourceSpec[] {
  // RFC-204: an entry is `repoUrl` XOR `cachedRepoId` (refineRepoSourceFields),
  // but both are optional on the wire type — narrow to the discriminated
  // RepoSourceSpec here so nothing downstream has to re-guess.
  const withRef = <T extends object>(base: T, ref: string | undefined): T & { ref?: string } =>
    ref !== undefined ? { ...base, ref } : base
  // RFC-248: wire 上的 `repos[]` 已退役（顶层键进 RETIRED_START_TASK_KEYS 硬拒）。
  // 多仓一律由 `repoGroupId` 表达，展平后的成员规格在 materializeSpace 里直接从
  // 布局产出，不经过这里。这里只剩「单仓 / 框架内部路径规格」两种形态。
  if (typeof input.cachedRepoId === 'string' && input.cachedRepoId.length > 0) {
    return [withRef({ cachedRepoId: input.cachedRepoId }, input.ref)]
  }
  if (typeof input.repoUrl === 'string' && input.repoUrl.length > 0) {
    return [{ repoUrl: input.repoUrl, ...(input.ref !== undefined ? { ref: input.ref } : {}) }]
  }
  // Schema guarantees a source (scratch handled before this call); an empty
  // list only appears for hand-built inputs — materializeSpace guards it.
  return []
}

/**
 * RFC-024 + RFC-066: per-repo source resolution. Carved out of the original
 * `resolveRepoSource` so the multi-repo launcher can call it N times in a
 * loop without re-implementing the path/URL fork. Single-repo path is
 * byte-for-byte identical to the pre-RFC-066 inline implementation — that
 * baseline is locked by `tests/source/start-task-single-path-baseline.test.ts`.
 *
 * RFC-068 wiring is automatic: the path-mode opt-in fetch runs when
 * `input.fetchBeforeLaunch === true` (top-level flag, applies to every
 * repo entry in multi-repo mode), and URL-mode FF fires inside
 * `resolveCachedRepo` per (cacheDir, syncBranch) pair so each multi-repo
 * URL entry hits its own cached mirror with no cross-talk.
 */
export async function resolveRepoSourceSingle(
  spec: RepoSourceSpec,
  input: StartTask,
  deps: StartTaskDeps,
): Promise<ResolvedRepoSource> {
  if ('repoPath' in spec && spec.repoPath.length > 0) {
    // RFC-165: internal local-path face only (deps.internalSource / fusion /
    // test helper) — the public wire is URL-only, and the RFC-068 path-mode
    // opt-in fetch retired with it (URL mirrors always auto-fetch + FF).
    return {
      repoPath: spec.repoPath,
      baseBranch: spec.baseBranch,
      repoUrl: null,
      cachedRepoId: null,
      pathFetchError: null,
      ffWarnings: [],
    }
  }
  // RFC-204: a reuse-by-id source. The wire no longer carries the credentialed
  // URL, so the daemon looks it up itself and it never round-trips through the
  // client. 404 (not 422) and the same not-found shape as everything else so a
  // probe can't distinguish "not yours" from "doesn't exist".
  let sourceUrl: string
  let sourceCachedRepoId: string | null = null
  const specCachedRepoId = (spec as { cachedRepoId?: unknown }).cachedRepoId
  if (typeof specCachedRepoId === 'string' && specCachedRepoId.length > 0) {
    const row = deps.db
      .select()
      .from(cachedRepos)
      .where(eq(cachedRepos.id, specCachedRepoId))
      .limit(1)
      .all()[0]
    if (row === undefined) {
      throw new NotFoundError(
        'cached-repo-not-found',
        `cached repo '${specCachedRepoId}' not found`,
      )
    }
    const plain = unsealRepoUrl(row, deps.secretBox, deps.db)
    if (plain === null) {
      throw new DomainError(
        'cached-repo-credential-unavailable',
        `cached repo '${specCachedRepoId}' has no readable URL (sealed with a different secret.key?)`,
        409,
      )
    }
    sourceUrl = plain
    sourceCachedRepoId = row.id
  } else {
    // Value-based, not `'repoUrl' in spec`: internal-face callers hand us specs
    // that carry the key with an undefined value, which the key test accepts and
    // then explodes on `.length`.
    const specUrl = (spec as { repoUrl?: unknown }).repoUrl
    if (typeof specUrl !== 'string' || specUrl.length === 0) {
      throw new ValidationError('start-task-source-required', 'a repoUrl source is required')
    }
    sourceUrl = specUrl
  }
  const appHome = deps.appHome ?? Paths.root
  // `spec` here is the url-or-id shape; read `ref` defensively for the same
  // reason as above (internal callers may carry the key with no value).
  const specRefRaw = (spec as { ref?: unknown }).ref
  const specRef = typeof specRefRaw === 'string' && specRefRaw.length > 0 ? specRefRaw : undefined
  const syncCandidates = [specRef].filter((s): s is string => typeof s === 'string')
  const resolved = await resolveCachedRepo(
    {
      db: deps.db,
      appHome,
      syncBranches: syncCandidates,
      secretBox: deps.secretBox,
      ...(deps.cloneTimeoutMs !== undefined ? { cloneTimeoutMs: deps.cloneTimeoutMs } : {}),
      ...(deps.sourceTerminationLaunchSignal !== undefined
        ? { signal: deps.sourceTerminationLaunchSignal }
        : {}),
    },
    { url: sourceUrl },
  )
  if (!resolved.fetchOk) {
    throw new DomainError(
      'repo-fetch-failed',
      `repository fetch failed for ${resolved.cached.urlRedacted}; refusing to launch from a stale cache`,
      502,
      {
        url: resolved.cached.urlRedacted,
        stderr: resolved.fetchError,
      },
    )
  }
  const baseBranch = specRef ?? resolved.cached.defaultBranch ?? undefined
  let ffWarnings: Array<{ branch: string; warning: string }> = resolved.ffOutcomes
    .filter((o) => o.warning !== null)
    .map((o) => ({ branch: o.branch, warning: o.warning as string }))
  if (
    !resolved.cold &&
    syncCandidates.length === 0 &&
    typeof resolved.cached.defaultBranch === 'string' &&
    resolved.cached.defaultBranch.length > 0
  ) {
    const second = await resolveCachedRepo(
      {
        db: deps.db,
        appHome,
        syncBranches: [resolved.cached.defaultBranch],
        fetchOnReuse: false,
        secretBox: deps.secretBox,
        ...(deps.sourceTerminationLaunchSignal !== undefined
          ? { signal: deps.sourceTerminationLaunchSignal }
          : {}),
      },
      { url: sourceUrl },
    )
    ffWarnings = ffWarnings.concat(
      second.ffOutcomes
        .filter((o) => o.warning !== null)
        .map((o) => ({ branch: o.branch, warning: o.warning as string })),
    )
  }
  return {
    repoPath: resolved.cached.localPath,
    baseBranch,
    repoUrl: sourceUrl,
    cachedRepoId: sourceCachedRepoId ?? resolved.cached.id,
    pathFetchError: null,
    ffWarnings,
  }
}

interface MaterializedRepo {
  repoIndex: number
  repoPath: string
  repoUrl: string | null
  cachedRepoId: string | null
  baseBranch: string
  branch: string
  baseCommit: string | null
  worktreePath: string
  worktreeDirName: string
  /** RFC-248: 相对任务根的挂载路径；'' = 挂根。取代 worktreeDirName 成为规范 key。 */
  mountPath: string
  /** RFC-248 D17: '' = 整仓；否则该成员是 sparse 检出。 */
  subdir: string
  /** RFC-248 D11: 只读成员不快照 / 不进 diff / 不推送。 */
  readonly: boolean
  /** RFC-248 D1: 平台预置 commit 的 sha；null = 本仓没有嵌套子成员。 */
  gitignoreCommit: string | null
  submoduleInitOk: boolean
  submoduleInitError: string | null
  hasSubmodules: boolean
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
export function selectResumeRollbackTargets<
  R extends {
    id: string
    nodeId: string
    parentNodeRunId: string | null
    status: string
    childTaskId?: string | null
  },
>(runs: readonly R[]): R[] {
  const latestPerNode = new Map<string, R>()
  for (const r of runs) {
    if (r.parentNodeRunId !== null) continue
    const prev = latestPerNode.get(r.nodeId)
    if (prev === undefined || r.id > prev.id) latestPerNode.set(r.nodeId, r)
  }
  return [...latestPerNode.values()].filter(
    (r) =>
      (r.status === 'failed' || r.status === 'interrupted') &&
      // RFC-243 §4.2 — call rows have no canonical writes to roll back (the
      // child works in the call-node iso); their interrupted rows are handled
      // by the scheduler's adoption path (re-attach / merge_state-staged
      // replay), never by pre_snapshot rollback + re-mint.
      (r.childTaskId ?? null) === null,
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
export function selectSyncRollbackTargets<
  R extends { id: string; nodeId: string; parentNodeRunId: string | null; status: string },
>(
  runs: readonly R[],
  statuses: readonly string[],
  isWrapperNode: (nodeId: string) => boolean,
): R[] {
  const latestPerNode = new Map<string, R>()
  for (const r of runs) {
    if (r.parentNodeRunId !== null) continue
    const prev = latestPerNode.get(r.nodeId)
    if (prev === undefined || r.id > prev.id) latestPerNode.set(r.nodeId, r)
  }
  return [...latestPerNode.values()].filter((r) => {
    if (!statuses.includes(r.status)) return false
    if (r.status === 'canceled' && isWrapperNode(r.nodeId)) return false
    return true
  })
}

/**
 * RFC-103 T2 — single source for threading runtime config (auto commit&push +
 * global concurrency) from `StartTaskDeps` into `RunTaskOptions`. Used by
 * startTask / resumeTask / retryNode so the three kick sites can't drift: the
 * historical bug (01-LIFE-06) was retryNode dropping commit&push entirely, and
 * `maxConcurrentNodes` was never threaded from any HTTP entry (02-SCHED).
 */
export function runtimeConfigOpts(
  deps: Pick<
    StartTaskDeps,
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
    | 'defaultRuntime'
    | 'maxActiveChildTasks'
    | 'maxInvocationDepth'
    | 'scriptInterpreters'
    | 'scriptDepsInstallTimeoutMs'
  >,
): Partial<RunTaskOptions> {
  return {
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
    // 被漏斗丢弃的 launchRuntime 键（根任务即断线，见 StartTaskDeps 字段注释）。
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
    ...(deps.defaultNodeRetries !== undefined
      ? { defaultNodeRetries: deps.defaultNodeRetries }
      : {}),
    ...(deps.defaultRuntime !== undefined ? { defaultRuntime: deps.defaultRuntime } : {}),
  }
}

/**
 * RFC-165 (F3): the single space-materialization entry — one tagged result
 * covering scratch / single-repo / multi-repo launches. Guarantees:
 *   * resolve exactly once (a route-pre-resolved single source is reused
 *     verbatim, never re-fetched — RFC-107 D1-B) and materialize exactly
 *     once: the multipart route's failure handoff used to re-run BOTH;
 *   * the failure arm carries the per-repo partial state and has already
 *     completed its own cleanup (scratch dir removed); the caller mints ONE
 *     failed task row from it and never re-materializes;
 *   * scratch launches hold an in-process lease (`materializingSpaces`,
 *     keyed by taskId, registered BEFORE mkdir) that startTask's finally
 *     releases after the row committed — the scratch orphan scan skips
 *     leased dirs (F9).
 * Throws (ValidationError) only for the pre-existing 422 surfaces
 * (`repo-ref-not-found`) where no task row must be minted.
 */
export interface MaterializedSpace {
  kind: 'scratch' | 'single' | 'multi' | 'group'
  /** RFC-165: persisted `tasks.space_kind` value, decided at materialize time.
   *  RFC-243: 'inherited' = a child execution's synthesized space pointing into
   *  its parent's call-node iso (never produced by materializeSpace itself). */
  spaceKind: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
  taskId: string
  /** Multi: the container dir; single: the worktree; scratch: the repo dir; '' on failure. */
  worktreePath: string
  branch: string
  baseCommit: string | null
  earlyError: string | null
  resolvedSources: ResolvedRepoSource[]
  repos: MaterializedRepo[]
  /** RFC-249: frozen canonical directory paths; empty for non-group legacy handoffs. */
  nodePaths: string[]
  /** Explicit ownership lease consumed by startTask or the multipart route. */
  cleanup: MaterializedSpaceCleanup
}

export interface WorkspaceCleanupHookEvent {
  stage: 'worktree-remove' | 'branch-restore' | 'owned-root-remove'
  taskId: string
  path: string
  repoPath?: string
  branch?: string
}

export interface WorkspaceCleanupFailure extends WorkspaceCleanupHookEvent {
  message: string
}

export interface WorkspaceCleanupReport {
  taskId: string
  complete: boolean
  failures: WorkspaceCleanupFailure[]
}

export interface MaterializedSpaceCleanup {
  taskId: string
  /** Scratch/multi/fusion ephemeral root only; never a URL cache or user source. */
  ownedRoot: string | null
  /** Exact provenance emitted by createWorktree; never inferred after the fact. */
  worktrees: WorktreeCleanupProvenance[]
  state: 'owned' | 'committed' | 'cleaned'
  report: WorkspaceCleanupReport | null
}

function createMaterializedSpaceCleanup(
  taskId: string,
  ownedRoot: string | null,
  worktrees: WorktreeCleanupProvenance[] = [],
): MaterializedSpaceCleanup {
  return {
    taskId,
    ownedRoot,
    worktrees,
    state: 'owned',
    report: null,
  }
}

/**
 * Consume a materialization ownership lease after a launch failed before its
 * task row committed. Every Git ref mutation is CAS-safe in util/git.ts. The
 * report is cached on the lease so route + service double-catch is idempotent,
 * and an incomplete cleanup is surfaced rather than being logged as zero
 * residue. Shared repo/cache paths never appear as `ownedRoot`.
 */
async function cleanupMaterializedSpaceLease(
  ledger: MaterializedSpaceCleanup,
  hook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>,
): Promise<WorkspaceCleanupReport> {
  if (ledger.report !== null) return ledger.report
  if (ledger.state === 'committed') {
    return { taskId: ledger.taskId, complete: true, failures: [] }
  }

  const failures: WorkspaceCleanupFailure[] = []
  let worktreeCleanupFailed = false
  for (const entry of [...ledger.worktrees].reverse()) {
    const result = await cleanupCreatedWorktree(entry, {
      beforeStage: async (stage) => {
        await hook?.({
          stage,
          taskId: ledger.taskId,
          path: entry.worktreePath,
          repoPath: entry.repoPath,
          branch: entry.branch,
        })
      },
    })
    if (!result.worktreeRemoved) worktreeCleanupFailed = true
    for (const failure of result.failures) {
      failures.push({
        stage: failure.stage,
        taskId: ledger.taskId,
        path: entry.worktreePath,
        repoPath: entry.repoPath,
        branch: entry.branch,
        message: failure.message,
      })
    }
  }

  // A multi container contains only launch-owned sibling worktrees. Never
  // recursively erase it when unregistering one of those worktrees failed.
  if (ledger.ownedRoot !== null && !worktreeCleanupFailed) {
    try {
      await hook?.({
        stage: 'owned-root-remove',
        taskId: ledger.taskId,
        path: ledger.ownedRoot,
      })
      await rm(ledger.ownedRoot, { recursive: true, force: true })
    } catch (error) {
      // mkdir can fail because an ancestor is a file. In that case rm also
      // reports ENOTDIR even though the launch-owned root never existed; this
      // is genuinely zero residue, not an incomplete cleanup. Any surviving
      // root remains a hard, structured failure.
      if (existsSync(ledger.ownedRoot)) {
        failures.push({
          stage: 'owned-root-remove',
          taskId: ledger.taskId,
          path: ledger.ownedRoot,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const report: WorkspaceCleanupReport = {
    taskId: ledger.taskId,
    complete: failures.length === 0,
    failures,
  }
  ledger.state = 'cleaned'
  ledger.report = report
  if (!report.complete) {
    log.error('rfc199/start-task-cleanup-incomplete', { ...report })
  }
  return report
}

/** Multipart route cleanup before startTask accepts the ownership handoff. */
export async function cleanupMaterializedSpace(
  space: MaterializedSpace,
  hook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>,
): Promise<WorkspaceCleanupReport> {
  try {
    return await cleanupMaterializedSpaceLease(space.cleanup, hook)
  } finally {
    materializingSpaces.delete(space.taskId)
  }
}

function withWorkspaceCleanupReport(error: unknown, report: WorkspaceCleanupReport): Error {
  if (report.complete) return error instanceof Error ? error : new Error(String(error))
  if (error instanceof DomainError) {
    const details =
      typeof error.details === 'object' && error.details !== null && !Array.isArray(error.details)
        ? { ...error.details, workspaceCleanup: report }
        : { causeDetails: error.details, workspaceCleanup: report }
    return new DomainError(error.code, error.message, error.status, details)
  }
  return new DomainError(
    'task-launch-cleanup-incomplete',
    error instanceof Error ? error.message : String(error),
    500,
    { workspaceCleanup: report },
  )
}

function workflowLaunchVersionMismatch(
  workflowId: string,
  expectedVersion: number,
  currentVersion: number | null,
): ConflictError {
  const current = currentVersion === null ? 'deleted' : `v${currentVersion}`
  return new ConflictError(
    'workflow-version-mismatch',
    `workflow '${workflowId}' changed during launch (expected v${expectedVersion}, now ${current})`,
    { expectedVersion, currentVersion },
  )
}

function workflowLaunchHookEvent(
  stage: WorkflowLaunchCommitHookEvent['stage'],
  workflow: Workflow,
  space: MaterializedSpace,
): WorkflowLaunchCommitHookEvent {
  return {
    stage,
    workflowId: workflow.id,
    capturedWorkflowVersion: workflow.version,
    taskId: space.taskId,
    spaceKind: space.kind,
    worktreePath: space.worktreePath,
    repoWorktrees: space.repos.map((repo) => ({
      repoPath: repo.repoPath,
      worktreePath: repo.worktreePath,
      branch: repo.branch,
    })),
  }
}

/**
 * RFC-248 H9 —— 从一个既有任务的**冻结** `task_repos` 快照重建布局（重启）。
 *
 * 与 `resolveRepoGroupLayout` 返回同构的 `PlannedRepo[]`，因此下游物化管线
 * 一行不用改。三条关键语义：
 *
 *  - **不读组定义**：源任务当初属于哪个组、那个组现在长什么样，都与这里无关。
 *    组可能被改布局、被加减成员、被删除；重启要的是「再跑一次刚才那个」。
 *  - **必须能按镜像 id 重放**：快照里没有 `cached_repo_id` 的行（RFC-204 之前
 *    的存量、或纯框架内部路径任务）无法安全重放——URL 是脱敏存的，拿它去 clone
 *    会带着 `***` 认证失败。这种情况直接 422，让调用方改用别的来源，而不是
 *    悄悄少物化一个仓。
 *  - **顺序按 repo_index**：与当初物化时一致，分支后缀（D14 同源多份）才对得上。
 */
interface PlannedSpaceLayout {
  repos: PlannedRepo[]
  nodes: PlannedDirectoryNode[]
}

/** Old task snapshots only have repo mounts. Rebuild the smallest provable tree. */
function minimalNodePaths(mountPaths: readonly string[]): string[] {
  const paths = new Map<string, string>([['', '']])
  for (const mountPath of mountPaths) {
    let current = ''
    for (const segment of mountPath.split('/').filter(Boolean)) {
      current = current === '' ? segment : `${current}/${segment}`
      paths.set(current.toLowerCase(), current)
    }
  }
  return [...paths.values()].sort((a, b) => mountDepth(a) - mountDepth(b) || a.localeCompare(b))
}

function loadFrozenSpaceLayout(db: DbClient, sourceTaskId: string): PlannedSpaceLayout {
  const rows = db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, sourceTaskId))
    .orderBy(taskRepos.repoIndex)
    .all()
  if (rows.length === 0) {
    throw new ValidationError(
      'source-task-not-replayable',
      `task '${sourceTaskId}' has no frozen repo snapshot to relaunch from`,
    )
  }
  const missing = rows.filter((r) => (r.cachedRepoId ?? '') === '')
  if (missing.length > 0) {
    throw new ValidationError(
      'source-task-not-replayable',
      `task '${sourceTaskId}' has ${missing.length} repo(s) with no cached mirror id; ` +
        'its space cannot be replayed (relaunch by picking a repo or repo group instead)',
    )
  }
  const repos = rows.map((r) => ({
    cachedRepoId: r.cachedRepoId as string,
    repoUrlRedacted: r.repoUrl ?? '',
    ref: r.baseBranch,
    subdir: r.subdir,
    mountPath: r.mountPath,
    readonly: r.readonly,
    viaGroups: [],
  }))
  const frozenNodes = db
    .select({ path: taskSpaceNodes.nodePath })
    .from(taskSpaceNodes)
    .where(eq(taskSpaceNodes.taskId, sourceTaskId))
    .all()
  const nodePaths =
    frozenNodes.length > 0
      ? frozenNodes
          .map((row) => row.path)
          .sort((a, b) => mountDepth(a) - mountDepth(b) || a.localeCompare(b))
      : minimalNodePaths(repos.map((repo) => repo.mountPath))
  return {
    repos,
    nodes: nodePaths.map((path) => ({ path, origins: [] })),
  }
}

/**
 * Materialize explicit directories without following a symlink out of the
 * launch-owned group root. Missing segments are created one at a time so each
 * existing or newly-created component can be checked before descending.
 */
function ensureExplicitDirectoryNodes(groupRoot: string, nodePaths: readonly string[]): void {
  const rootStat = lstatSync(groupRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ValidationError(
      'repo-group-directory-occupied',
      `repo group root '${groupRoot}' is not a real directory`,
      { nodePath: '', occupiedPath: groupRoot },
    )
  }
  const realRoot = realpathSync(groupRoot)

  for (const nodePath of [...nodePaths].sort(
    (a, b) => mountDepth(a) - mountDepth(b) || a.localeCompare(b),
  )) {
    let current = groupRoot
    for (const segment of nodePath.split('/').filter(Boolean)) {
      current = join(current, segment)
      if (existsSync(current)) {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new ValidationError(
            'repo-group-directory-occupied',
            `directory node '${nodePath}' is occupied by a symlink or non-directory at '${current}'`,
            { nodePath, occupiedPath: current },
          )
        }
      } else {
        mkdirSync(current)
      }

      const actual = realpathSync(current)
      const fromRoot = relative(realRoot, actual)
      if (
        fromRoot === '..' ||
        fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(fromRoot)
      ) {
        throw new ValidationError(
          'repo-group-directory-occupied',
          `directory node '${nodePath}' resolves outside the repo group root`,
          { nodePath, occupiedPath: current },
        )
      }
    }
  }
}

/**
 * RFC-248 PR-3 —— 按仓库组的展平布局物化整个工作空间。
 *
 * 顺序约束是**硬的**（design §4.2）：
 *  1. 挂载深度升序建 worktree——内层要落进外层的工作树里，外层必须先在。
 *  2. 建完某一层之后、建下一层之前，给该层里**有直接子挂载点**的仓写
 *     `.gitignore` 预置 commit。反过来的话，`git add .gitignore` 会把已经落在
 *     那里的内层 worktree 当未跟踪目录一起吞进索引（proposal E2）。
 *
 * 回收按挂载深度**倒序**（design §4.3）。实测（proposal E9）正序也不会坏账
 * ——git 会把内层注册标 `prunable` 并在后续 remove 时自愈——但倒序不依赖那条
 * 自愈行为，且让「删除失败」仍可归因到具体某个仓。
 */
async function materializeGroupSpace(opts: {
  planned: readonly PlannedRepo[]
  nodePaths: readonly string[]
  resolvedSources: ResolvedRepoSource[]
  taskId: string
  appHome: string
  workingBranch?: string | undefined
  gitUserName: string | null
  gitUserEmail: string | null
  signal?: AbortSignal
}): Promise<MaterializedSpace> {
  const { planned, nodePaths, resolvedSources, taskId, appHome } = opts
  // `resolvedSources` 与 `planned` **同序**（它是按 repoSpecs 逐个 resolve 出来
  // 的），但物化要按挂载深度重排。先把两者**配对**再排序——只排 planned、然后
  // 用重排后的下标去索引 resolvedSources 会张冠李戴：sparse 成员会拿到别的仓的
  // 源，症状是「子目录明明存在却报 sparse-empty」。
  const paired = planned.map((p, i) => ({ p, src: resolvedSources[i]! }))
  const ordered = orderForMaterialize(paired.map((x) => x.p))
  const orderedPairs = orderForMaterialize(
    paired.map((x, i) => ({ ...x, mountPath: x.p.mountPath, _i: i })),
  )
  const allMounts = ordered.map((p) => p.mountPath)
  const branchNames = assignBranchNames(ordered, taskId, opts.workingBranch)
  const rootMounted = allMounts.includes('')
  const groupRoot = join(appHome, 'worktrees', 'group', taskId)
  // （原来这里有个 `multiRepo = ordered.length > 1`，只服务于排除计划的
  //   `includeUploadDir`。它已改成恒 true——组空间一律用保留上传目录，
  //   与展平出几个仓无关，见 writePresetCommitsForDepth 的注释。）

  const cleanup = createMaterializedSpaceCleanup(taskId, groupRoot)
  try {
    // 有仓挂根时根目录由它的 `worktree add` 自己创建——预先 mkdir 会让
    // `worktree add` 撞上「已存在」（proposal E7 显示空目录其实可以，但让 git
    // 自己建更贴近单仓 baseline）。
    if (!rootMounted) mkdirSync(groupRoot, { recursive: true })

    // ── 设计门二轮 H8：占用校验看 git tree，不是工作树 ──────────────────
    // sparse 只控制工作树、不删索引里的已跟踪路径，所以「工作树里没有那个目录」
    // 不代表该路径没被容器跟踪。先把冲突挡在建任何 worktree 之前。
    for (let i = 0; i < orderedPairs.length; i++) {
      const p = orderedPairs[i]!.p
      const kids = directChildren(p.mountPath, allMounts)
      if (kids.length === 0) continue
      const rels = kids.map((c) => (p.mountPath === '' ? c : c.slice(p.mountPath.length + 1)))
      const src = orderedPairs[i]!.src
      const ref = src.baseBranch ?? 'HEAD'
      const hit = await findTrackedPathUnderMounts(src.repoPath, ref, rels)
      if (hit !== null) {
        throw new ValidationError(
          'repo-group-mount-occupied',
          `mount path '${p.mountPath === '' ? hit.mountRel : `${p.mountPath}/${hit.mountRel}`}' is already tracked by the enclosing repo at ref '${ref}' (${hit.trackedPath})`,
          {
            mountPath: p.mountPath === '' ? hit.mountRel : `${p.mountPath}/${hit.mountRel}`,
            containerMountPath: p.mountPath,
            trackedPath: hit.trackedPath,
            ref,
          },
        )
      }
    }

    const repos: MaterializedRepo[] = []
    const byMount = new Map<string, MaterializedRepo>()
    let depth = -1
    for (let i = 0; i < orderedPairs.length; i++) {
      const p = orderedPairs[i]!.p
      const src = orderedPairs[i]!.src
      const d = mountDepth(p.mountPath)
      if (d !== depth) {
        // 进入新的一层：先给**上一层**里有子挂载点的仓写预置 commit。
        if (depth >= 0) await writePresetCommitsForDepth(depth)
        depth = d
      }
      const abs = p.mountPath === '' ? groupRoot : join(groupRoot, p.mountPath)
      if (p.mountPath !== '') mkdirSync(join(abs, '..'), { recursive: true })
      const wt = await materializeWorktree({
        repoPath: src.repoPath,
        baseBranch: src.baseBranch,
        taskId,
        appHome,
        overrideWorktreePath: abs,
        branchName: branchNames[i]!,
        ...(p.subdir !== '' ? { sparseSubdir: p.subdir } : {}),
        ...(opts.workingBranch !== undefined ? { workingBranch: opts.workingBranch } : {}),
        gitUserName: opts.gitUserName,
        gitUserEmail: opts.gitUserEmail,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
      if (wt.cleanup !== null) cleanup.worktrees.push(wt.cleanup)
      if (wt.earlyError !== null) {
        if (
          src.repoUrl !== null &&
          /worktree-base-invalid|cannot resolve base ref/i.test(wt.earlyError)
        ) {
          const available = await listAvailableRefs(src.repoPath, 10)
          throw new ValidationError(
            'repo-group-ref-not-found',
            `ref '${p.ref !== '' ? p.ref : '(default)'}' not found in ${redactGitUrl(src.repoUrl)}`,
            {
              url: redactGitUrl(src.repoUrl),
              ref: p.ref !== '' ? p.ref : null,
              availableRefs: available,
              mountPath: p.mountPath,
            },
          )
        }
        throw new ValidationError(
          'repo-group-materialize-failed',
          `mounting '${p.mountPath === '' ? '<root>' : p.mountPath}' failed: ${wt.earlyError}`,
          { mountPath: p.mountPath },
        )
      }
      // D17: sparse 成员检出后为空 ⇒ 用户指定的子目录在该 ref 上不存在。
      // 静默给一个空目录比报错糟糕得多——agent 会以为那个仓真的没内容。
      if (p.subdir !== '' && readdirSync(abs).filter((n) => n !== '.git').length === 0) {
        throw new ValidationError(
          'repo-group-sparse-empty',
          `subdir '${p.subdir}' does not exist at ref '${src.baseBranch ?? 'HEAD'}' for mount '${p.mountPath === '' ? '<root>' : p.mountPath}'`,
          { mountPath: p.mountPath, subdir: p.subdir },
        )
      }
      if (!wt.submoduleInitOk) {
        log.warn('[rfc034/submodule-init-failed] worktree submodule init failed', {
          taskId,
          worktreePath: wt.worktreePath,
          mountPath: p.mountPath,
          stderr: wt.submoduleInitError ?? '',
        })
      }
      const rec: MaterializedRepo = {
        repoIndex: i,
        repoPath: src.repoPath,
        repoUrl: src.repoUrl,
        cachedRepoId: src.cachedRepoId,
        baseBranch: src.baseBranch ?? '',
        branch: wt.branch,
        baseCommit: wt.baseCommit,
        worktreePath: wt.worktreePath,
        worktreeDirName: p.mountPath,
        mountPath: p.mountPath,
        subdir: p.subdir,
        readonly: p.readonly,
        gitignoreCommit: null,
        submoduleInitOk: wt.submoduleInitOk,
        submoduleInitError: wt.submoduleInitError,
        hasSubmodules: wt.hasSubmodules,
      }
      repos.push(rec)
      byMount.set(p.mountPath, rec)
    }
    // 最后一层的预置 commit（循环里只在**进入下一层**时写）。
    if (depth >= 0) await writePresetCommitsForDepth(depth)

    async function writePresetCommitsForDepth(d: number): Promise<void> {
      for (const rec of repos) {
        if (mountDepth(rec.mountPath) !== d) continue
        if (rec.gitignoreCommit !== null) continue
        const rels = exclusionPlanFor(rec.mountPath, allMounts, {
          // D12: 上传物落在任务根下的固定目录；有仓挂根时它就落在那个仓的
          // 工作树里，必须一并排除。
          //
          // **恒为 true**：走到 `materializeGroupSpace` 的都是组空间，上传一律
          // 用保留目录。曾经写的是 `multiRepo`（= 展平后 >1 个仓），于是「单成员
          // 但挂了 sparse 子目录」的组不排除该目录 ⇒ 上传物落进那个仓的工作树、
          // 进它的审计 diff、甚至被自动推送（Codex 实现门 P1）。
          includeUploadDir: true,
        })
        if (rels.length === 0) continue
        const preset = await commitGitignorePreset({
          worktreePath: rec.worktreePath,
          relMountPaths: rels,
          taskId,
          gitUserName: opts.gitUserName,
          gitUserEmail: opts.gitUserEmail,
        })
        if (preset.commitSha !== null) {
          rec.gitignoreCommit = preset.commitSha
          // D1: base_commit 指向预置 commit ⇒ 审计 diff 里没有 .gitignore 那一笔。
          rec.baseCommit = preset.commitSha
          // `worktree add` 时记下的 CAS 终值是原始 base commit；预置
          // commit 是平台自己对同一分支做的后续移动，回滚所有权也要
          // 跟着移到新 HEAD。否则此后任何失败都会因 expected SHA 过时
          // 而拒绝删除 launch-owned 临时分支。
          const provenance = cleanup.worktrees.find(
            (item) => item.worktreePath === rec.worktreePath,
          )
          if (provenance !== undefined) provenance.branchAfter = preset.commitSha
        }
      }
    }

    ensureExplicitDirectoryNodes(groupRoot, nodePaths)

    const head0 = repos[0]
    return {
      kind: 'group',
      spaceKind: resolvedSources.some((s) => s.repoUrl === null) ? 'local' : 'remote',
      taskId,
      // 有仓挂根时 cwd 就是那个仓的 worktree；否则是不属于任何仓的父目录。
      worktreePath: groupRoot,
      branch: head0?.branch ?? '',
      baseCommit: head0?.baseCommit ?? null,
      earlyError: null,
      resolvedSources,
      repos,
      nodePaths: [...nodePaths],
      cleanup,
    }
  } catch (error) {
    // lease 按创建顺序记录；统一 cleanup consumer 会自行倒序回收。
    // 这里不能再 reverse 一次，否则外层 worktree 会先被删除，内层
    // 注册随之变成 prunable，第二次 remove 就会误报清理不完整。
    const report = await cleanupMaterializedSpaceLease(cleanup)
    throw withWorkspaceCleanupReport(error, report)
  }
}

export async function materializeSpace(
  input: StartTask,
  deps: StartTaskDeps,
  appHome: string,
  /**
   * RFC-287 G7 第一刀：让调用方能**先定 id、后物化**。
   *
   * G7 要把仓库准备挪到任务行落库之后（启动接口不再同步阻塞到工作树就绪，失败
   * 也能留下记录）。那就要求任务行先落——而落行需要 id，id 却一直是在这里、在
   * 物化过程中才铸出来的。把它提成可选入参：不传 = 逐字维持旧行为（本函数自己
   * 铸），传了 = 用调用方给的那个。本刀**零行为变更**，只是把「谁铸 id」这个
   * 决定权交出去，为下一刀（占位落行 + runTask 第 0 步物化）让路。
   */
  presetTaskId?: string,
): Promise<MaterializedSpace> {
  const taskId = presetTaskId ?? ulid()

  // RFC-165 (F4): the internal local-path face is mutually exclusive with
  // every public space field — a programming error, not user input, so the
  // assertion is loud and unconditional.
  if (deps.internalSource !== undefined) {
    const hasPublicSource =
      input.scratch === true ||
      (typeof input.repoUrl === 'string' && input.repoUrl.length > 0) ||
      (typeof input.repoGroupId === 'string' && input.repoGroupId.length > 0)
    if (hasPublicSource) {
      throw new ValidationError(
        'internal-source-conflict',
        'internalSource is mutually exclusive with scratch/repoUrl/repoGroupId',
      )
    }
  }

  // ---- scratch: the workspace IS a brand-new git repo (RFC-165 §3). ----
  if (input.scratch === true) {
    const scratchDir = join(appHome, 'scratch', taskId)
    const cleanup = createMaterializedSpaceCleanup(taskId, scratchDir)
    materializingSpaces.set(taskId, { dir: scratchDir, startedAt: Date.now() })
    const init = await initScratchRepo({
      dir: scratchDir,
      gitUserName: input.gitUserName ?? null,
      gitUserEmail: input.gitUserEmail ?? null,
      ...(deps.sourceTerminationLaunchSignal !== undefined
        ? { signal: deps.sourceTerminationLaunchSignal }
        : {}),
    })
    if (init.ok) {
      return {
        kind: 'scratch',
        spaceKind: 'scratch',
        taskId,
        worktreePath: scratchDir,
        branch: 'main',
        baseCommit: init.rootCommit,
        earlyError: null,
        resolvedSources: [],
        nodePaths: [],
        cleanup,
        repos: [
          {
            repoIndex: 0,
            repoPath: scratchDir,
            repoUrl: null,
            cachedRepoId: null,
            baseBranch: 'main',
            branch: 'main',
            baseCommit: init.rootCommit,
            worktreePath: scratchDir,
            worktreeDirName: '',
            mountPath: '',
            subdir: '',
            readonly: false,
            gitignoreCommit: null,
            submoduleInitOk: true,
            submoduleInitError: null,
            hasSubmodules: false,
          },
        ],
      }
    }
    // Cleanup ownership = the materializing layer (design F9). A failed rm is
    // not equivalent to a pruned workspace: surface the structured residue
    // and release the process-local lease so the orphan scanner can recover
    // the predictable scratch/{taskId} path on a later pass.
    const report = await cleanupMaterializedSpaceLease(cleanup, deps.workspaceCleanupHook)
    materializingSpaces.delete(taskId)
    if (!report.complete) {
      throw new DomainError(
        'scratch-materialize-cleanup-incomplete',
        `scratch workspace initialization failed and cleanup was incomplete: ${init.error}`,
        500,
        {
          taskId,
          path: scratchDir,
          materializeError: init.error,
          workspaceCleanup: report,
        },
      )
    }
    return {
      kind: 'scratch',
      spaceKind: 'scratch',
      taskId,
      worktreePath: '',
      branch: '',
      baseCommit: null,
      earlyError: init.error,
      resolvedSources: [],
      repos: [],
      nodePaths: [],
      cleanup,
    }
  }

  // RFC-248: 用仓库组启动时，成员规格由**展平后的布局**给出，而不是 wire 上的
  // `repos[]`。展平在 services/repoGroup.ts 里做（校验错误已在那里转成 422）。
  // RFC-248（实现门 P1）：展平出 0 个仓的组**不能启动**。它可能来自 force 删掉
  // 最后一个仓、或者一个空的子组。放行的后果不是报错而是更糟：服务端建出一个
  // 没有任何 `task_repos` 的组根目录、`repoCount` 记成 1，然后任务在一个**不是
  // git 仓库**的目录里跑——agent 的每一条 git 命令都会失败，而失败原因与真正的
  // 起因（组是空的）隔了十万八千里。
  const assertNonEmptyLayout = (layout: PlannedSpaceLayout, source: string): PlannedSpaceLayout => {
    if (layout.repos.length === 0) {
      throw new ValidationError(
        'repo-group-empty',
        `${source} flattens to zero repos; a task needs at least one repo to run in`,
      )
    }
    return layout
  }

  const groupLayout: PlannedSpaceLayout | null = (() => {
    if (typeof input.repoGroupId === 'string' && input.repoGroupId.length > 0) {
      const layout = resolveRepoGroupLayout(deps.db, input.repoGroupId)
      return assertNonEmptyLayout(
        { repos: layout.repos, nodes: layout.nodes },
        `repo group ${input.repoGroupId}`,
      )
    }
    if (typeof input.sourceTaskId === 'string' && input.sourceTaskId.length > 0) {
      // RFC-249: replay BOTH frozen repos and explicit directories. Never read
      // the current repo-group definition, which may have changed or vanished.
      return assertNonEmptyLayout(
        loadFrozenSpaceLayout(deps.db, input.sourceTaskId),
        `source task ${input.sourceTaskId}`,
      )
    }
    return null
  })()
  const groupPlanned = groupLayout?.repos ?? null

  const repoSpecs =
    deps.internalSource !== undefined
      ? [{ repoPath: deps.internalSource.repoPath, baseBranch: deps.internalSource.baseBranch }]
      : groupPlanned !== null
        ? // 组成员一律按 cachedRepoId 复用已导入的镜像；`ref` 为空 ⇒ 该仓默认分支。
          groupPlanned.map((p) => ({
            cachedRepoId: p.cachedRepoId,
            ...(p.ref !== '' ? { ref: p.ref } : {}),
          }))
        : normalizeStartTaskRepos(input)

  // RFC-066: per-repo source resolution. Each spec independently runs
  // path-mode opt-in fetch (RFC-068) or URL-mode FF; warnings collected per
  // repo and surfaced after materialization.
  const resolvedSources: ResolvedRepoSource[] = []
  for (const [i, spec] of repoSpecs.entries()) {
    // RFC-107: reuse the route's pre-resolved source for the single repo so a
    // URL is cloned/resolved exactly once across the route → startTask handoff.
    const r =
      deps.preResolvedSource !== undefined && repoSpecs.length === 1 && i === 0
        ? deps.preResolvedSource
        : await resolveRepoSourceSingle(spec, input, deps)
    if (r.pathFetchError !== null) {
      log.warn('rfc068/path-fetch-failed', {
        repoPath: r.repoPath,
        error: r.pathFetchError,
      })
    }
    if (r.ffWarnings.length > 0) {
      log.warn('rfc068/ff-warnings', {
        // RFC-204: r.repoUrl is the RAW source URL (spec.repoUrl / the resolved
        // mirror URL), not the redacted column — logging it verbatim leaked
        // userinfo/query credentials into the daemon log.
        repoUrl: r.repoUrl !== null ? redactGitUrl(r.repoUrl) : null,
        warnings: r.ffWarnings,
      })
    }
    resolvedSources.push(r)
  }

  // RFC-248: 仓库组路径。展平后**恰好一个成员且挂根**时落回单仓分支——
  // 那是「单仓是多仓的特例」这条产品判断的实现兑现（AC-10 要求路径 / `tasks.*`
  // 列 / cwd 与今天字节级一致），所以这里只在 >1 或非根挂载时才走组物化。
  if (groupPlanned !== null && groupLayout !== null) {
    const onlyRootRepo =
      groupPlanned.length === 1 &&
      groupPlanned[0]!.mountPath === '' &&
      groupPlanned[0]!.subdir === '' &&
      groupLayout.nodes.length === 1 &&
      groupLayout.nodes[0]!.path === ''
    if (!onlyRootRepo) {
      return await materializeGroupSpace({
        planned: groupPlanned,
        nodePaths: groupLayout.nodes.map((node) => node.path),
        resolvedSources,
        taskId,
        appHome,
        ...(input.workingBranch !== undefined ? { workingBranch: input.workingBranch } : {}),
        gitUserName: input.gitUserName ?? null,
        gitUserEmail: input.gitUserEmail ?? null,
        ...(deps.sourceTerminationLaunchSignal !== undefined
          ? { signal: deps.sourceTerminationLaunchSignal }
          : {}),
      })
    }
  }

  // RFC-066: single-path byte-baseline branch — pre-RFC-066 behavior
  // preserved bit-for-bit (RFC-165 moved it verbatim into materializeSpace).
  // The G1/G3 source guards in tests/source-text-rfc066-guards.test.ts pin
  // this comment so a future refactor cannot silently delete the branch.
  if (repoSpecs.length === 1) {
    const source = resolvedSources[0]!
    const wt = await materializeWorktree({
      repoPath: source.repoPath,
      baseBranch: source.baseBranch,
      taskId,
      appHome,
      // RFC-075: working branch (task-level) + identity for the merge commit.
      ...(input.workingBranch !== undefined ? { workingBranch: input.workingBranch } : {}),
      gitUserName: input.gitUserName ?? null,
      gitUserEmail: input.gitUserEmail ?? null,
      ...(deps.sourceTerminationLaunchSignal !== undefined
        ? { signal: deps.sourceTerminationLaunchSignal }
        : {}),
    })

    if (wt.earlyError === null && !wt.submoduleInitOk) {
      log.warn('[rfc034/submodule-init-failed] worktree submodule init failed', {
        taskId,
        worktreePath: wt.worktreePath,
        stderr: wt.submoduleInitError ?? '',
      })
    }

    if (
      wt.earlyError !== null &&
      source.repoUrl !== null &&
      /worktree-base-invalid|cannot resolve base ref/i.test(wt.earlyError)
    ) {
      const available = await listAvailableRefs(source.repoPath, 10)
      throw new ValidationError(
        'repo-ref-not-found',
        `ref '${input.ref ?? source.baseBranch ?? '(default)'}' not found in ${redactGitUrl(source.repoUrl)}`,
        { url: redactGitUrl(source.repoUrl), ref: input.ref ?? null, availableRefs: available },
      )
    }
    const cleanup = createMaterializedSpaceCleanup(
      taskId,
      null,
      wt.cleanup === null ? [] : [wt.cleanup],
    )
    return {
      kind: 'single',
      spaceKind:
        deps.internalSource !== undefined
          ? 'internal'
          : source.repoUrl !== null
            ? 'remote'
            : 'local',
      taskId,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
      earlyError: wt.earlyError,
      resolvedSources,
      nodePaths: groupLayout?.nodes.map((node) => node.path) ?? [],
      cleanup,
      repos: [
        {
          repoIndex: 0,
          repoPath: source.repoPath,
          repoUrl: source.repoUrl,
          cachedRepoId: source.cachedRepoId,
          baseBranch: source.baseBranch ?? '',
          branch: wt.branch !== '' ? wt.branch : `agent-workflow/${taskId}`,
          baseCommit: wt.baseCommit,
          worktreePath: wt.worktreePath,
          worktreeDirName: '',
          mountPath: '',
          subdir: '',
          readonly: false,
          gitignoreCommit: null,
          submoduleInitOk: wt.submoduleInitOk,
          submoduleInitError: wt.submoduleInitError,
          hasSubmodules: wt.hasSubmodules,
        },
      ],
    }
  }

  // RFC-248 T26: RFC-066 的多仓 materialize 分支（`worktrees/multi/{taskId}` +
  // basename 平铺 + `resolveMultiRepoDirName` 的 `-2`/`-3` 后缀）**已删除**。
  // wire 上的 `repos[]` 退役后（顶层键进 RETIRED_START_TASK_KEYS 硬拒），
  // `repoSpecs.length > 1` 已不可达——多仓一律经 `repoGroupId` 走上面的
  // `materializeGroupSpace`，它支持挂根、任意嵌套、sparse、只读与同仓多份，
  // 是旧分支的严格超集。
  //
  // 存量任务的 `tasks.worktree_path` 是绝对路径存量值，继续指向老 `multi/`
  // 目录即可；GC 按 `worktree_path` 删，天然覆盖，无需目录迁移。
  throw new ValidationError(
    'start-task-source-required',
    'multi-repo launches must use repoGroupId (RFC-248); the legacy repos[] path is retired',
  )
}

/**
 * RFC-165 (F4): the framework-internal LOCAL-PATH launch face — a thin
 * adapter that moves `{repoPath, baseBranch}` off the body and into
 * `deps.internalSource` before delegating to startTask. Consumers: the test
 * suite (the retired wire fields lived in ~300 fixtures) and any internal
 * caller that owns a pre-existing local repo. NOT reachable from any route;
 * the banned-lock allowlists exactly this symbol.
 */
export async function startTaskWithLocalRepo(
  input: StartTask & { repoPath: string; baseBranch: string },
  deps: StartTaskDeps,
): Promise<Task> {
  const { repoPath, baseBranch, ...rest } = input
  return startTask(rest as StartTask, {
    ...deps,
    internalSource: { kind: 'local-path', repoPath, baseBranch },
    ...(deps.callLaunch === undefined && deps.launchProvenance === undefined
      ? {
          // This adapter is retained for backend fixtures only; every
          // production root is forced through startExecution/Fusion and
          // provides an explicit trusted provenance.
          launchProvenance: {
            kind: 'direct-json' as const,
            initiator: 'manual' as const,
          },
        }
      : {}),
  })
}

function rootLaunchOriginFromDeps(deps: StartTaskDeps): TaskLaunchOrigin | null {
  if (deps.callLaunch !== undefined) {
    if (deps.launchProvenance !== undefined) {
      throw new ValidationError(
        'task-launch-provenance-conflict',
        'call child launch must inherit its parent origin and may not carry root provenance',
      )
    }
    if (
      deps.scheduledTaskId !== undefined ||
      deps.webhookTriggerId !== undefined ||
      deps.webhookFireId !== undefined
    ) {
      throw new ValidationError(
        'task-launch-child-metadata-invalid',
        'call child launch may inherit trigger context but may not carry root schedule/webhook attribution ids',
      )
    }
    return null
  }

  if (deps.launchProvenance === undefined) {
    throw new ValidationError(
      'task-launch-provenance-missing',
      'root task launch requires trusted launch provenance',
    )
  }
  const issue = taskLaunchAdmissionIssue(deps.launchProvenance, {
    scheduledTaskId: deps.scheduledTaskId,
    webhookTriggerId: deps.webhookTriggerId,
    webhookFireId: deps.webhookFireId,
    hasTriggerContext: deps.triggerContext !== undefined,
  })
  if (issue !== null) throw new ValidationError(issue.code, issue.message)
  return deriveTaskLaunchOrigin(deps.launchProvenance)
}

interface StartTaskOwnership {
  cleanup: MaterializedSpaceCleanup | null
  taskRowCommitted: boolean
}

function cleanupFromPreCreated(pre: PreCreatedWorktree): MaterializedSpaceCleanup {
  switch (pre.cleanup.kind) {
    case 'borrowed':
      return createMaterializedSpaceCleanup(pre.taskId, null)
    case 'owned-root':
      return createMaterializedSpaceCleanup(pre.taskId, pre.cleanup.path)
    case 'linked-worktree':
      return createMaterializedSpaceCleanup(pre.taskId, null, [pre.cleanup.provenance])
  }
}

/**
 * Own the cleanup handoff before any workflow/version/validation read. This is
 * essential for multipart and fusion callers: those callers materialize first,
 * so even an initial exact-version mismatch must release their workspace.
 */
export async function startTask(input: StartTask, deps: StartTaskDeps): Promise<Task> {
  const ownership: StartTaskOwnership = {
    cleanup:
      deps.materializedSpace?.cleanup ??
      (deps.preCreatedWorktree === undefined
        ? null
        : cleanupFromPreCreated(deps.preCreatedWorktree)),
    taskRowCommitted: false,
  }
  try {
    return await startTaskImpl(input, deps, ownership)
  } catch (error) {
    if (!ownership.taskRowCommitted && ownership.cleanup !== null) {
      const report = await cleanupMaterializedSpaceLease(
        ownership.cleanup,
        deps.workspaceCleanupHook,
      )
      throw withWorkspaceCleanupReport(error, report)
    }
    throw error
  } finally {
    if (ownership.cleanup !== null) materializingSpaces.delete(ownership.cleanup.taskId)
  }
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
): (typeof taskRepos.$inferInsert)[] {
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
    worktreeDirName: r.worktreeDirName,
    mountPath: r.mountPath,
    subdir: r.subdir,
    readonly: r.readonly,
    readonlyDirtyCount: null,
    gitignoreCommit: r.gitignoreCommit,
    hasSubmodules: r.hasSubmodules,
    submoduleInitOk: r.submoduleInitOk,
    submoduleInitError: r.submoduleInitError,
    schemaVersion: 1,
  }))
}

async function startTaskImpl(
  input: StartTask,
  deps: StartTaskDeps,
  ownership: StartTaskOwnership,
): Promise<Task> {
  deps.sourceTerminationAdmission?.()
  if (deps.sourceTerminationLaunchSignal?.aborted === true) {
    throw new ConflictError(
      'webhook-mr-launch-terminal',
      'the MR/PR stream became terminal before launch preparation',
    )
  }
  // RFC-301: validate closed root provenance before workflow reads, repository
  // resolution, or filesystem materialization. Child origin stays unresolved
  // until the parent is read inside the task-row transaction below.
  const rootLaunchOrigin = rootLaunchOriginFromDeps(deps)

  // Resolve workflow.
  const workflow = await getWorkflow(deps.db, input.workflowId)
  if (workflow === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${input.workflowId}' not found`)
  }
  // RFC-243 §6.2 L: a child launch executes the definition FROZEN at the
  // parent's launch, never the resource row's current one (D9) — every gate
  // below (execution policy, multi-repo, static validation, inputs) evaluates
  // the definition that will actually run. The resource row stays the FK
  // anchor (agent/workgroup host precedent).
  let effectiveDefinition = workflow.definition
  if (deps.callLaunch !== undefined && deps.callLaunch.frozenSnapshotJson !== null) {
    try {
      const parsed = WorkflowDefinitionSchema.safeParse(
        JSON.parse(deps.callLaunch.frozenSnapshotJson),
      )
      if (!parsed.success) throw new Error('schema')
      effectiveDefinition = migrateWorkflowDefinitionToLatest(parsed.data)
    } catch {
      throw new ValidationError(
        'workflow-call-ref-missing',
        `frozen child definition for workflow '${input.workflowId}' is unreadable`,
      )
    }
  }
  // RFC-175 (§2c): immediate-submit OCC guard for relaunch. When present, reject
  // if the workflow we're about to snapshot has a different `version` than the
  // one the relaunch normalized its inputs against — so inputs validated against
  // vN can't be silently stored into a concurrently-PUT vN+1 (reopening the
  // stale-input path §4.8 closes). Compared against the SAME workflow object we
  // snapshot below. Immediate-launch only (never persisted into a scheduled
  // payload — §2d; a schedule intentionally re-snapshots the latest def at fire).
  if (
    input.expectedWorkflowVersion !== undefined &&
    workflow.version !== input.expectedWorkflowVersion
  ) {
    throw workflowLaunchVersionMismatch(
      input.workflowId,
      input.expectedWorkflowVersion,
      workflow.version,
    )
  }

  // RFC-165: scratch tasks have no repo source at all — skip spec
  // normalization/resolution and materialize a fresh scratch repo instead.
  const isScratch = input.scratch === true
  // RFC-066: collapse legacy and v2 bodies into a uniform per-repo spec list.
  // RFC-165: an internal launch (fusion / framework helpers) carries its repo
  // via deps.internalSource, NOT the wire body — mirror materializeSpace's
  // derivation or the preCreatedWorktree branch below sees zero specs.
  const repoSpecs = isScratch
    ? []
    : deps.internalSource !== undefined
      ? [{ repoPath: deps.internalSource.repoPath, baseBranch: deps.internalSource.baseBranch }]
      : normalizeStartTaskRepos(input)

  // RFC-066: multi-repo gates. Reject up-front BEFORE the static workflow
  // validation step (which may itself reject the workflow for unrelated
  // reasons) so the failure code unambiguously points at the multi-repo
  // mismatch. The workflow snapshot is the source of truth; workflow edits
  // after this point cannot retroactively introduce a wrapper-git / upload
  // node into an already-started task. Single-repo launches keep their
  // existing behavior (workflows containing wrapper-git / upload are still
  // launchable as today, gated by the static validation rules only).
  // RFC-248 D9/D12: RFC-066 当年在这里拦掉了多仓 + wrapper-git 与多仓 + 上传输入
  // 两种组合，理由是包裹器只会对单一 worktree 取快照、上传物不知道该落到哪个仓。
  // 两条都已解除：
  //   - wrapper-git 现在逐仓快照、逐仓 diff，路径用挂载路径前缀化后合并成一个
  //     `list<path>`（scheduler.ts runGitWrapperNode）。不解除的话仓库组永远
  //     用不了平台的 Code → Audit → Fix 主链路。
  //   - 上传输入落到任务根下的固定目录 `.agent-workflow-inputs/`，不属于任何仓；
  //     有仓挂根时该目录进它的 `.gitignore` 预置 commit（services/task.ts 物化）。

  // Static validation gate (proposal.md §静态校验): "校验失败不阻止保存，但阻止启动 task".
  // Run the same 5-rule check the editor uses, against the live agent/skill set,
  // and refuse to launch if it surfaces any error-severity issues. Warnings pass.
  // RFC-243 §3.1 / RFC-271 T6f2：闭包在**校验之前**冻结，校验与执行读同一份。
  // 根启动此前是「validator 查 live 解析一次、freeze 按启动者再解析一次」——两
  // 条判据本就不同（validator 不收 Actor、查所有同名行），决策 28 把启动改成
  // id-hint 优先之后差异更大，能真的分叉成「校验的是 W1、执行的是 W2」。
  // 子启动直接用父任务传下来的子集，绝不重查 live（父冻结 G1、随后行改成 G2 时，
  // 重查会去校验一个 scheduler 根本不会执行的定义）。
  const frozenClosureJson =
    deps.callLaunch !== undefined
      ? deps.callLaunch.refClosureJson
      : await prepareWorkflowTriggerLaunch({
          deps,
          workflowId: workflow.id,
          definition: effectiveDefinition,
        })

  // RFC-292: root + frozen call closure must agree with the launch source
  // before repository/upload materialization and before the task INSERT.
  if (deps.callLaunch !== undefined) {
    assertTriggerPreflight({
      root: effectiveDefinition,
      closureJson: frozenClosureJson,
      source: triggerSourceFromContext(deps.triggerContext),
    })
  }

  const validation = validateWorkflowDef(
    effectiveDefinition,
    // RFC-243 实现门 P1-2 — the service funnel enforces 4f/4g on the exact
    // definition it will execute (frozen child included).
    await buildWorkflowValidationContext(deps.db, {
      definition: effectiveDefinition,
      currentWorkflow: { id: workflow.id, name: workflow.name },
      frozenClosureJson,
    }),
  )
  if (!validation.ok) {
    const errors = validation.issues.filter((i) => (i.severity ?? 'error') === 'error')
    throw new ValidationError(
      'workflow-invalid',
      `workflow '${input.workflowId}' failed static validation (${errors.length} error${errors.length === 1 ? '' : 's'}); fix issues before starting a task`,
      { issues: validation.issues },
    )
  }
  // Browser-side required/picker gates are advisory: JSON API callers and
  // scheduled fires reach this service directly. Validate the packed map here
  // before any repo resolution/materialization so a missing required input
  // cannot silently execute as an empty string. Agent/workgroup launches own
  // different synthesized-host contracts and validate them in their launch
  // services before entering this generic workflow funnel.
  if (deps.agentLaunch === undefined && deps.workgroupLaunch === undefined) {
    // RFC-243: child launches validate against the FROZEN definition's inputs
    // (identical map semantics — the call node wired them from its ports).
    assertWorkflowLaunchInputs(effectiveDefinition.inputs, input.inputs)
  }

  const appHome = deps.appHome ?? Paths.root

  // RFC-020/165: three handoffs into a materialized space —
  //   (1) `deps.materializedSpace`: a route already resolved+materialized
  //       (multipart; carries success OR failure) — consumed verbatim so
  //       resolve/materialize run exactly once end-to-end (design F3);
  //   (2) `deps.preCreatedWorktree`: legacy fusion handoff (single path-mode
  //       repo; migrates to internalSource with RFC-165 T5);
  //   (3) materialize here (JSON-body flow).
  let space: MaterializedSpace
  /** RFC-287 G7：延后准备时先铸的 id，供 runTask 第 0 步物化时复用。 */
  let deferredTaskId: string | null = null
  if (deps.materializedSpace !== undefined) {
    space = deps.materializedSpace
  } else if (deps.preCreatedWorktree !== undefined) {
    if (input.scratch === true) {
      throw new ValidationError(
        'scratch-precreated-unsupported',
        'multipart uploads into a scratch space must use the materializedSpace handoff',
      )
    }
    // RFC-248 D12: 多仓 + 上传的禁令已解除；上传物落任务根下的固定目录，
    // 不属于任何成员仓（applyUploadsToWorktree 的 inputsSubdir）。
    const source =
      deps.preResolvedSource ??
      (await resolveRepoSourceSingle(
        deps.internalSource !== undefined
          ? { repoPath: deps.internalSource.repoPath, baseBranch: deps.internalSource.baseBranch }
          : repoSpecs[0]!,
        input,
        deps,
      ))
    // RFC-165 (F4): internalSource + preCreatedWorktree must agree on the repo.
    if (deps.internalSource !== undefined && deps.internalSource.repoPath !== source.repoPath) {
      throw new ValidationError(
        'internal-source-conflict',
        'internalSource.repoPath must match the pre-created worktree source',
      )
    }
    const pre = deps.preCreatedWorktree
    space = {
      kind: 'single',
      spaceKind:
        deps.internalSource !== undefined
          ? 'internal'
          : source.repoUrl !== null
            ? 'remote'
            : 'local',
      taskId: pre.taskId,
      worktreePath: pre.worktreePath,
      branch: pre.branch,
      baseCommit: pre.baseCommit,
      earlyError: null,
      resolvedSources: [source],
      nodePaths: [],
      cleanup: ownership.cleanup ?? cleanupFromPreCreated(pre),
      repos: [
        {
          repoIndex: 0,
          repoPath: source.repoPath,
          repoUrl: source.repoUrl,
          cachedRepoId: source.cachedRepoId,
          baseBranch: source.baseBranch ?? '',
          branch: pre.branch,
          baseCommit: pre.baseCommit,
          worktreePath: pre.worktreePath,
          worktreeDirName: '',
          mountPath: '',
          subdir: '',
          readonly: false,
          gitignoreCommit: null,
          submoduleInitOk: true,
          submoduleInitError: null,
          hasSubmodules: false,
        },
      ],
    }
  } else if (deps.deferRepoPreparation === true && input.scratch !== true) {
    // RFC-287 G7：JSON-body 启动把仓库准备**推迟到任务行落库之后**。
    //
    // 今天物化在落行之前，于是「克隆超时 / 远端不可达」这类失败**不留任何记录**
    // ——用户点了启动，转半天圈，最后得到一个 HTTP 错误，任务列表里什么都没有。
    // 改为先落 `pending` 行（G7 明确**不新增状态**），准备在后台推进，失败转
    // `failed` 且 git 原文可见。
    //
    // 只有 JSON-body 这一条走：multipart 要把上传物写进工作树、preCreated 是
    // 调用方已经建好的树，两者都必须保持预物化语义（proposal §G7）。
    //
    // **scratch 同样排除**（实现门自审补）：临时空间没有远端要克隆——G7 要解决的
    // 「拉不动远端时什么都不留」在它身上根本不存在，延后零收益。而占位行必须先
    // 认领一个 spaceKind，写 'remote' 对 scratch 就是**错的**，直到回填才纠正。
    // 今天下游恰好不敏感（gc 只处理终态任务、taskDelete 的分支不涉及），但那是
    // 运气不是保证：任何将来按 spaceKind 分流的非终态读点都会踩中这段窗口。
    // 与其给一个零收益的路径留一段错值窗口，不如从判据上把它排除。
    deferredTaskId = ulid()
    space = {
      kind: 'single',
      spaceKind: 'remote',
      taskId: deferredTaskId,
      // 「尚未物化」与「物化失败」共用空串，但由 earlyError 区分：失败态 earlyError
      // 非空、本态为 null。落行时据此仍写 `pending`。
      worktreePath: '',
      branch: '',
      baseCommit: null,
      earlyError: null,
      resolvedSources: [],
      repos: [],
      nodePaths: [],
      // 尚未物化 ⇒ 没有已占用的目录，空租约（ownedRoot=null、零 worktree）。
      // 真正的租约在 runTask 第 0 步物化成功后由 materializeSpace 产出。
      cleanup: createMaterializedSpaceCleanup(deferredTaskId, null),
    }
  } else {
    space = await materializeSpace(input, deps, appHome)
  }
  const taskId = space.taskId
  const worktreePath = space.worktreePath
  const branch = space.branch
  const baseCommit = space.baseCommit
  const earlyError = space.earlyError
  const materializedRepos = space.repos
  const resolvedSources = space.resolvedSources
  ownership.cleanup = space.cleanup

  // RFC-067: trim and pair-validate the optional Git commit identity.
  // StartTaskSchema's superRefine already rejected the half-set case, but we
  // re-derive defensively here so even a hand-crafted bypass cannot land a
  // single-field row into the DB.
  const trimGitName = input.gitUserName?.trim() ?? ''
  const trimGitEmail = input.gitUserEmail?.trim() ?? ''
  const persistedGitUserName =
    trimGitName.length > 0 && trimGitEmail.length > 0 ? trimGitName : null
  const persistedGitUserEmail =
    trimGitName.length > 0 && trimGitEmail.length > 0 ? trimGitEmail : null

  // RFC-066: `tasks.*` legacy columns mirror `materializedRepos[0]` for back-
  // compat. When materialize failed early (only possible in multi-repo path —
  // single-repo failures still produce a `materializedRepos[0]` so the
  // legacy "failed task row with worktree path empty" surface is preserved),
  // fall back to the resolved-source view so we never write `undefined`.
  const head: MaterializedRepo | undefined = materializedRepos[0]
  const fallbackSource: ResolvedRepoSource | undefined = resolvedSources[0]
  const headRepoPath = head?.repoPath ?? fallbackSource?.repoPath ?? ''
  const headRepoUrl = head?.repoUrl ?? fallbackSource?.repoUrl ?? null
  // RFC-204: the deterministic mirror ref. repo_url is stored REDACTED (RFC-054
  // W3-4) so it can never drive a relaunch; this id is what does.
  const headCachedRepoId = head?.cachedRepoId ?? fallbackSource?.cachedRepoId ?? null
  // RFC-248: 组身份快照。与 D8「启动时快照」一致——`task_repos` 本就是布局
  // 快照，这里只再存一份 id+名字供溯源、记忆注入与详情页 chip 使用。
  const repoGroupSnapshot =
    typeof input.repoGroupId === 'string' && input.repoGroupId.length > 0
      ? {
          id: input.repoGroupId,
          name: resolveRepoGroupLayout(deps.db, input.repoGroupId).groupName,
        }
      : null
  const headBaseBranch = head?.baseBranch ?? fallbackSource?.baseBranch ?? ''
  const headBranch = head?.branch ?? (branch !== '' ? branch : `agent-workflow/${taskId}`)
  const headBaseCommit = head?.baseCommit ?? baseCommit

  const now = Date.now()
  try {
    await deps.workflowLaunchCommitHook?.(
      workflowLaunchHookEvent('materialized-before-task-commit', workflow, space),
    )
    deps.sourceTerminationAdmission?.()

    // RFC-165 (F17-r3): the task row + its per-repo rows + the launch
    // collaborator rows + the single-agent existence RE-check land in ONE
    // dbTxSync transaction — atomicity replaces the old best-effort manual
    // rollback (which, per Codex P1, could even delete a PRE-EXISTING task
    // when a handed-off taskId collided). Synchronous surface only inside.
    dbTxSync(deps.db, (tx) => {
      // This read and the initial INSERT share SQLite's transaction boundary:
      // terminal revoke wins first, or the later effect must observe the task.
      deps.sourceTerminationAdmission?.()
      // RFC-199 T6.5: the workflow row captured before materialization is not
      // sufficient to authorize the final task insert. Re-read inside the
      // SAME transaction that writes the FK. Delete-first linearizes here as
      // a structured mismatch (rather than a raw SQLite FK 500); when the
      // editor supplied an exact version, a materialization-time writer is
      // fenced here as well. If this transaction wins first, deleteWorkflow's
      // in-transaction reference check necessarily observes the task row.
      const liveWorkflow = tx
        .select({ version: workflows.version })
        .from(workflows)
        .where(eq(workflows.id, workflow.id))
        .get()
      if (liveWorkflow === undefined) {
        throw workflowLaunchVersionMismatch(
          workflow.id,
          input.expectedWorkflowVersion ?? workflow.version,
          null,
        )
      }
      if (
        input.expectedWorkflowVersion !== undefined &&
        liveWorkflow.version !== input.expectedWorkflowVersion
      ) {
        throw workflowLaunchVersionMismatch(
          workflow.id,
          input.expectedWorkflowVersion,
          liveWorkflow.version,
        )
      }

      // RFC-243 child-launch fence: cancellation can abort a controller after
      // startTask materialized the inherited space but before this final task
      // INSERT. Check the parent inside the SAME synchronous transaction as
      // the child row: child-first commits before cancel's child-set freeze;
      // cancel-first makes this launch fail with no post-terminal child.
      let launchOrigin = rootLaunchOrigin
      let sourceTerminationSnapshot = deps.sourceTerminationSnapshot ?? null
      if (deps.callLaunch !== undefined) {
        const parent = tx
          .select({
            status: tasks.status,
            launchOrigin: tasks.launchOrigin,
            sourceTerminationBinding: tasks.sourceTerminationBinding,
            sourceTerminationLaunchRev: tasks.sourceTerminationLaunchRev,
            sourceTerminationFence: tasks.sourceTerminationFence,
            sourceTerminationEffectRev: tasks.sourceTerminationEffectRev,
          })
          .from(tasks)
          .where(eq(tasks.id, deps.callLaunch.parentTaskId))
          .get()
        if (parent === undefined) {
          throw new NotFoundError(
            'parent-task-not-found',
            `parent task '${deps.callLaunch.parentTaskId}' disappeared during child launch`,
          )
        }
        if (parent.status !== 'running') {
          throw new ConflictError(
            'parent-task-not-running',
            `parent task '${deps.callLaunch.parentTaskId}' is '${parent.status}'; refusing to mint child '${taskId}'`,
          )
        }
        const sourceFenceError = sourceTerminationRevivalError(parent.sourceTerminationFence)
        if (sourceFenceError !== null) {
          throw new ConflictError(sourceFenceError, sourceFenceError)
        }
        launchOrigin = parent.launchOrigin
        sourceTerminationSnapshot =
          parent.sourceTerminationBinding === null || parent.sourceTerminationLaunchRev === null
            ? null
            : {
                binding: parent.sourceTerminationBinding,
                launchRevision: parent.sourceTerminationLaunchRev,
                fence: parent.sourceTerminationFence,
                effectRevision: parent.sourceTerminationEffectRev,
              }
      }
      if (launchOrigin === null) {
        throw new Error('task launch origin remained unresolved before initial INSERT')
      }

      // F17: a concurrent agent delete between the service-level 404 gate and
      // this insert must fail the launch — never mint a task for a ghost.
      //
      // RFC-223 (PR-3a, R3-3): re-verify by the CANONICAL id (source_agent_id is
      // written from `agentLaunch.agentId` below, and the snapshot node freezes
      // the same id). Matching by id — not name — means a same-named replacement
      // created in the tiny window can never satisfy this gate (it has a
      // different id), so the frozen id always names the agent the launcher
      // actually resolved. The launch reservation already blocks delete/rename
      // mid-launch; this is the belt-and-suspenders behind it.
      if (deps.agentLaunch !== undefined) {
        const live = tx
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.id, deps.agentLaunch.agentId))
          .get()
        if (live === undefined) {
          throw new NotFoundError(
            'agent-not-found',
            `agent '${deps.agentLaunch.agentName}' was deleted during launch`,
          )
        }
      }
      tx.insert(tasks)
        .values({
          id: taskId,
          // RFC-037: required name (StartTaskSchema already trimmed + length-validated).
          name: input.name,
          workflowId: workflow.id,
          workflowSnapshot:
            deps.callLaunch?.frozenSnapshotJson ??
            deps.workgroupLaunch?.snapshotJson ??
            deps.agentLaunch?.snapshotJson ??
            JSON.stringify(workflow.definition),
          workflowVersion: workflow.version, // RFC-109: record the version this snapshot froze
          repoPath: headRepoPath,
          // RFC-054 W3-4 KNOWN_GAP fix: never persist the credentialed URL.
          // gitRepoCache has already used the cleartext form to clone (line
          // 197 above); from this point onward the daemon only needs the
          // redacted form (for display, WS broadcast, error messages). The
          // cleartext URL is reachable only ephemerally via the cache key
          // hash, so even DB-level access can't reconstruct it.
          repoUrl: headRepoUrl !== null ? redactGitUrl(headRepoUrl) : null,
          cachedRepoId: headCachedRepoId,
          // RFC-248: 组溯源 + 记忆注入的 scope 来源。名字是**快照**（设计门 G5）
          // ——组被删除后任务详情的 chip 仍要能渲染名字，而不是悬空 id。
          repoGroupId: repoGroupSnapshot?.id ?? null,
          repoGroupName: repoGroupSnapshot?.name ?? null,
          worktreePath,
          baseBranch: headBaseBranch,
          branch: headBranch !== '' ? headBranch : `agent-workflow/${taskId}`,
          baseCommit: headBaseCommit,
          status: earlyError === null ? 'pending' : 'failed',
          inputs: JSON.stringify(input.inputs),
          maxDurationMs: input.maxDurationMs ?? null,
          maxTotalTokens: input.maxTotalTokens ?? null,
          // RFC-067: per-task Git commit identity (NULL when omitted or only
          // half-set; runner.ts skips env injection when these are NULL).
          gitUserName: persistedGitUserName,
          gitUserEmail: persistedGitUserEmail,
          // RFC-075: user-specified working branch (NULL → isolation branch) +
          // the auto commit&push toggle (false → legacy, no commit/push).
          workingBranch: input.workingBranch ?? null,
          autoCommitPush: input.autoCommitPush ?? false,
          // RFC-066: count of `task_repos` rows. Single-repo path always = 1;
          // multi-repo populates with the materialized count (zero only when the
          // first repo failed before any task_repos row was minted).
          repoCount: Math.max(1, materializedRepos.length),
          startedAt: now,
          finishedAt: earlyError === null ? null : now,
          errorSummary: earlyError !== null ? `worktree creation failed: ${earlyError}` : null,
          errorMessage: earlyError,
          // RFC-036: launcher identity (NULL = legacy / __system__ fallback).
          ownerUserId: deps.actorUserId ?? null,
          // RFC-301: immutable launch-tree source. Roots derive from trusted
          // provenance; children read the exact parent in this transaction.
          launchOrigin,
          // RFC-159: the scheduled_tasks row that auto-launched this task (NULL =
          // manual). Stamped atomically with the row so the schedule's run history is
          // durable regardless of any later bookkeeping write.
          scheduledTaskId: deps.scheduledTaskId ?? null,
          // RFC-257: webhook-trigger attribution, same atomic-stamp discipline.
          webhookTriggerId: deps.webhookTriggerId ?? null,
          webhookFireId: deps.webhookFireId ?? null,
          // RFC-269: publish trigger inputs in this same task-row INSERT. The
          // scheduler starts only after this transaction commits and reads the
          // task row once, so a later UPDATE is observably too late.
          triggerContextJson:
            deps.triggerContext === undefined ? null : JSON.stringify(deps.triggerContext),
          sourceTerminationBinding: sourceTerminationSnapshot?.binding ?? null,
          sourceTerminationLaunchRev: sourceTerminationSnapshot?.launchRevision ?? null,
          sourceTerminationFence: sourceTerminationSnapshot?.fence ?? null,
          sourceTerminationEffectRev: sourceTerminationSnapshot?.effectRevision ?? null,
          // RFC-164: workgroup link + runtime config copy (NULL = not a workgroup task).
          workgroupId: deps.workgroupLaunch?.workgroupId ?? null,
          workgroupConfigJson: deps.workgroupLaunch?.configJson ?? null,
          // RFC-165 §4: single-agent soft link (taskExecutionKind 'agent' discriminator).
          sourceAgentName: deps.agentLaunch?.agentName ?? null,
          // RFC-175 (§2e): the resolved stable agent id (re-verified above), so a
          // post-migration relaunch can carry an `expectedAgentId` OCC guard.
          sourceAgentId: deps.agentLaunch?.agentId ?? null,
          // RFC-165: execution-space kind. 'local' is transitional (path mode, until
          // its public retirement lands within this PR); 'internal' is stamped via
          // the internalSource dep (fusion) once that migration lands.
          spaceKind: space.spaceKind,
          // RFC-243: parent linkage for node-invoked children + the frozen
          // reference closure (parents freeze it above; children carry the
          // handed-down subset). All NULL/0 on ordinary launches.
          parentTaskId: deps.callLaunch?.parentTaskId ?? null,
          parentNodeRunId: deps.callLaunch?.parentNodeRunId ?? null,
          invocationDepth: deps.callLaunch?.invocationDepth ?? 0,
          // RFC-271 T6f2：`frozenClosureJson` 已经在校验之前算好，两条分支同源
          // —— 根是刚冻结的那份，子是继承下来的那份，落库的与校验用的逐字同一。
          refClosureJson: frozenClosureJson,
          // RFC-165 (R3-2-r4): a materialize-failure row has NO revivable workspace —
          // stamp the tombstone atomically with the row so retry / sync-workflow can
          // never CAS it back to pending against a missing directory.
          // RFC-287 G7 / AC-15：**延后准备态不得打墓碑**。判据是 earlyError——它非空
          // 才是「物化失败、没有可复活的工作区」；延后态 earlyError 为 null，工作树
          // 只是「还没建」，打了墓碑会让 retryNode 再也 CAS 不回 pending，于是
          // 「重试准备仓库」这条 G7 的核心语义直接失效。
          workspacePrunedAt: earlyError !== null && worktreePath === '' ? now : null,
        })
        .run()

      // RFC-066: persist per-repo metadata. Single-repo tasks land one row at
      // repo_index=0 mirroring the legacy columns above; multi-repo tasks land
      // N rows sorted by repo_index. The list view's `repoCount` chip is driven
      // by `tasks.repo_count`; the detail page's `Task.repos[]` array is hydrated
      // from this table by `getTask`.
      if (materializedRepos.length > 0) {
        tx.insert(taskRepos)
          .values(taskRepoRowsFor(taskId, materializedRepos, input.workingBranch ?? null))
          .run()
      }

      // RFC-249: freeze the explicit directory tree atomically with task +
      // repo rows. Repository metadata stays in task_repos; these rows retain
      // pure directories that cannot be reconstructed from mount paths.
      if (space.nodePaths.length > 0) {
        tx.insert(taskSpaceNodes)
          .values(
            space.nodePaths.map((nodePath) => ({
              taskId,
              nodePath,
              schemaVersion: 1,
            })),
          )
          .run()
      }

      // RFC-217 T2 — workgroup runtime state row, atomically with the task
      // row. gate starts 'idle'; a dynamic_workflow launch seeds the complete
      // DwState checkpoint (phase 'generating') here instead of smuggling it
      // inside workgroup_config_json.
      if (deps.workgroupLaunch) {
        insertWorkgroupTaskStateTx(tx, taskId, deps.workgroupLaunch.dw ?? null)
      }

      // RFC-067 NOTE: an earlier draft of this RFC also wrote `user.name` /
      // `user.email` into the worktree's local `.git/config` as a defense-in-
      // depth fallback for git invocations that bypass the runner's spawn env.
      // We dropped that path: by default `git config <key> <value>` inside a
      // worktree writes to the PARENT repo's shared `.git/config`, so two
      // concurrent tasks against the same source repo race-overwrite each
      // other's identity. Per-worktree config via `extensions.worktreeConfig=
      // true` would have to be enabled on the parent repo (a global flag we do
      // not own). Pure spawn-env injection (in services/runner.ts) is therefore
      // the single source of truth for task identity; agents that bypass the
      // runner fall back to the parent repo's default user, matching
      // pre-RFC-067 behaviour.

      // RFC-036/RFC-099: record owner + collaborators (assignments removed,
      // D6) inside the SAME transaction — a validation throw (inactive user)
      // rolls back the task + task_repos rows atomically.
      if (deps.actorUserId) {
        const userRows = tx.select({ id: users.id, status: users.status }).from(users).all()
        const collabRows = buildLaunchCollabRows(
          {
            taskId,
            ownerUserId: deps.actorUserId,
            collaboratorUserIds: input.collaboratorUserIds ?? [],
            now,
          },
          userRows,
        )
        if (collabRows.length > 0) {
          tx.insert(taskCollaborators).values(collabRows).run()
        }
      }
    })
    ownership.taskRowCommitted = true
    space.cleanup.state = 'committed'

    // Observer-only half of the deterministic race seam. A test callback must
    // not be able to strand a committed pending row before scheduler kickoff;
    // surface its own assertion through captured state and keep launch moving.
    try {
      await deps.workflowLaunchCommitHook?.(
        workflowLaunchHookEvent('task-committed', workflow, space),
      )
    } catch (error) {
      log.warn('rfc199/start-task-post-commit-hook-failed', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  } catch (err) {
    // The outer ownership wrapper cleans every pre-commit failure, including
    // errors thrown before this transaction for handed-off multipart/fusion
    // spaces. Keeping one owner avoids route/service cleanup drift.
    log.debug('rfc199/start-task-precommit-failure-deferred-to-owner', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  const task = (await getTask(deps.db, taskId)) as Task

  tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
    type: 'task.created',
    task: {
      id: task.id,
      name: task.name, // RFC-037
      workflowId: task.workflowId,
      workflowName: task.workflowName,
      repoPath: task.repoPath,
      repoUrl: task.repoUrl,
      cachedRepoId: task.cachedRepoId,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      errorSummary: task.errorSummary,
      // RFC-066: source of truth is the freshly-loaded Task (which read
      // `tasks.repo_count` directly). Single-repo = 1; multi-repo = N.
      repoCount: task.repoCount,
      // RFC-165: execution-space kind + single-agent soft link.
      spaceKind: task.spaceKind,
      sourceAgentName: task.sourceAgentName ?? null,
    },
  })

  if (earlyError !== null) {
    return task
  }

  // Kick the scheduler. HTTP route returns immediately; tests can await.
  const controller = new AbortController()
  // RFC-287 G7：AbortController 必须在**行落库之后、准备开始之前**注册——准备是
  // 后台推进的第一步，若此刻还没注册，用户在「正在准备仓库」阶段点取消就取消不到
  // 任何东西（而那恰恰是最想取消的阶段：一个拉不动的大仓）。
  if ((await tryAttachTaskDriver(deps.db, taskId, controller)) !== 'attached') {
    return (await getTask(deps.db, taskId)) as Task
  }
  let preparedTask: Task | null = null
  /**
   * G7 的仓库准备（第 0 步）。抽成闭包是为了让它能**在请求路径之外**跑——见下面
   * 的分叉：延后准备的启动到「任务行落库」为止就返回，准备与调度在后台推进。
   *
   * 返回 false = 准备失败且已记账（合成行 failed、任务 failed、租约已释放），
   * 调用方不得再往下走调度。
   */
  const runRepoPreparation = async (): Promise<boolean> => {
    // 闭包化之后外层的 `if (deferredTaskId !== null)` 守卫不再为它做流收窄，
    // 这里显式取一次。null 分支不可达——本闭包只在延后准备时被调用。
    const prepTaskId = deferredTaskId
    if (prepTaskId === null) return true
    // 第 0 步：仓库准备。失败不抛给 HTTP（此刻请求早已返回），而是把任务转
    // `failed` 并把 git 原文留在行上——这正是 G7 要的「失败可见」。
    //
    // 合成一条 `__repo_prep__` node_run（同 `__commit_push__` 先例）：它不是工作流
    // 里的节点，而是框架自己的一步，但用户必须能在时间线上看到它——否则看到的就是
    // 一个「pending 了很久然后 failed」的任务，不知道卡在克隆、更不知道该重试什么。
    // 有了这一行，「重试准备仓库」直接复用既有的 retryNode，不必造第二套重试语义。
    // 先 pending 再转 running：RFC-098 修订 #10 的护栏禁止顶层行「born-running」
    // ——那样的行对 frontier 不可见，恢复扫描也认不出来。合成行不能例外。
    const prepRunId = await mintNodeRun(deps.db, {
      taskId,
      nodeId: REPO_PREP_NODE_ID,
      status: 'pending',
      cause: 'initial',
      retryIndex: 0,
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
        prepared = await materializeSpace(
          input,
          { ...deps, sourceTerminationLaunchSignal: controller.signal },
          appHome,
          prepTaskId,
        )
      } catch (err) {
        prepared = {
          ...space,
          earlyError: err instanceof Error ? err.message : String(err),
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
      if (controller.signal.aborted) break
      await new Promise<void>((resolve) => {
        const settle = (): void => {
          controller.signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = (): void => {
          clearTimeout(timer)
          settle()
        }
        const timer = setTimeout(settle, Math.min(backoffMs, remaining))
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      backoffMs = Math.min(backoffMs * 2, 15_000)
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
      try {
        // 合成行先落 failed，且 errorMessage 是 git 的原话——时间线上点开这一步能
        // 看到「fatal: unable to access …」，而不是一句无从下手的「启动失败」。
        await setNodeRunStatus({
          db: deps.db,
          nodeRunId: prepRunId,
          to: 'failed',
          allowedFrom: ['running'],
          reason: 'repo-prep-failed',
          extra: { finishedAt: Date.now(), errorMessage: prepared.earlyError },
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
        const cur = (
          await deps.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))
        )[0]
        finalStatus = (cur?.status as TaskStatus | undefined) ?? 'failed'
        log.warn('task left prep window before failure could be recorded; keeping current status', {
          taskId,
          status: finalStatus,
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        taskDriverRegistry.release(taskId, controller)
      }
      preparedTask = { ...task, status: finalStatus }
      return false
    }
    // 所有权租约换成真的：占位态给的是空租约（ownedRoot=null、零 worktree），
    // 物化成功后必须换成 materializeSpace 产出的那份，否则清理/回滚协议管不到
    // 刚建出来的工作树——任务删除时会留下孤儿目录。
    ownership.cleanup = prepared.cleanup
    // 回填：占位落行时 `task_repos` / `task_space_nodes` 是空的（那时还没物化）。
    // 与任务行的路径回写放进**同一个事务**——多仓任务的 repos 与 tasks.worktreePath
    // 必须同时可见，否则一个恰好落在中间的读者（诊断接口、structural diff、前端
    // 详情页）会看到「有工作树但没有成员仓」这种不存在的状态。
    //
    // RFC-066 还要求 tasks 上的 legacy 仓库列逐字镜像 task_repos[0]，repoCount
    // 等于成员行数。延后准备的占位 INSERT 不可能提前知道这些值，所以这里必须把
    // **整份兼容投影**一起回填；只回填路径会让成功任务永久显示成 1 仓，且详情页
    // 丢失远端 URL / cache id / base branch。
    const preparedHead = prepared.repos[0]
    dbTxSync(deps.db, (tx) => {
      tx.update(tasks)
        .set({
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
          spaceKind: prepared.spaceKind,
        })
        .where(eq(tasks.id, taskId))
        .run()
      if (prepared.repos.length > 0) {
        tx.insert(taskRepos)
          .values(taskRepoRowsFor(taskId, prepared.repos, input.workingBranch ?? null))
          .run()
      }
      if (prepared.nodePaths.length > 0) {
        tx.insert(taskSpaceNodes)
          .values(
            prepared.nodePaths.map((nodePath) => ({
              taskId,
              nodePath,
              schemaVersion: 1,
            })),
          )
          .run()
      }
    })
    await setNodeRunStatus({
      db: deps.db,
      nodeRunId: prepRunId,
      to: 'done',
      allowedFrom: ['running'],
      reason: 'repo-prep-done',
      extra: { finishedAt: Date.now() },
    })
    // 响应体重读一次：它是在准备之前、用占位值构造的，直接返回会让调用方拿到空
    // worktreePath——前端据此显示空路径，脚本据此写文件会写到错地方（实测：HTTP
    // 契约测试往空路径写文件，diff 自然为空）。回填已落库，重读即得真实值，比在
    // 这里手抄一份投影更不容易走散。
    preparedTask = (await getTask(deps.db, taskId)) as Task
    return true
  }

  /**
   * 调度器点火。**同步启动与后台续跑共用这一份**——两条路各抄一遍必然走散
   * （错误兜底、租约释放、工作区收尾都在这里，漏一样就是一类泄漏）。
   */
  const kickScheduler = (): Promise<void> =>
    runTask({
      taskId,
      db: deps.db,
      appHome,
      ...(deps.binaryOverride ? { binaryOverride: deps.binaryOverride } : {}),
      ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
      ...(deps.subagentLiveCapture !== undefined
        ? { subagentLiveCapture: deps.subagentLiveCapture }
        : {}),
      // RFC-075 + RFC-103 T2: thread commit&push + maxConcurrentNodes runtime
      // config through to the scheduler (single source, see runtimeConfigOpts).
      ...runtimeConfigOpts(deps),
      log,
      signal: controller.signal,
    })
      .catch((err) => {
        log.error('runTask threw', {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        return releaseTaskDriverAndFinalizeWorkspace(deps.db, taskId, controller)
      })

  // ---------------------------------------------------------------------
  // G7 的**异步启动**分叉（proposal §2 G7：「任务行先落 pending，克隆/fetch/
  // 快进/多仓物化/建工作树在后台推进」）。
  //
  // 修复前整条 `await` 链都还在请求路径上（routes/tasks.ts → executor.ts →
  // startTask），所以「启动接口同步阻塞到工作树就绪」这条 G7 要消灭的现象原样
  // 还在——一个 500MB 的仓照旧把 POST /api/tasks 挂几分钟，G6 的重试窗口更是
  // 直接叠在请求上。（T14 实现门；当时的测试反而在**测量**这个阻塞时长，等于把
  // 错的行为锁死了。）
  //
  // `awaitScheduler` 那条路不动：它是测试与内联调用要的「跑完再回来」语义。
  if (deferredTaskId !== null && deps.awaitScheduler !== true) {
    void (async () => {
      try {
        if (!(await runRepoPreparation())) return // 失败已记账（行 + 任务 + 租约）
        await kickScheduler()
      } catch (err) {
        // 后台续跑没有调用方接错——漏掉这层会变成 unhandled rejection 打挂
        // daemon。任务侧的失败记账在 runRepoPreparation 内部已做。
        log.error('deferred repo preparation continuation threw', {
          taskId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
    // 请求路径到此为止：返回**刚落库的 pending 行**（worktreePath 仍为空——这正是
    // AC-10 把不变量从「有任务行就有工作树」改成「`__repo_prep__` 行 done 之后才有
    // 工作树」的原因）。
    return (await getTask(deps.db, taskId)) as Task
  }

  if (deferredTaskId !== null && !(await runRepoPreparation())) {
    // preparedTask 由闭包写入（失败态的真实状态），TS 的流分析看不见闭包赋值，
    // 故用 `??` 兜底而不是断言——真取到 task 也是对的（同一行的快照）。
    return preparedTask ?? task
  }
  const schedulerPromise = kickScheduler()

  if (deps.awaitScheduler === true) {
    await schedulerPromise
    return (await getTask(deps.db, taskId)) as Task
  }
  return preparedTask ?? task
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
 * for snapshot rollback, also used by the scheduler's in-process retry path
 * (audit S-2). Resume semantics (`resetOnEmptySnapshot: false`) are preserved
 * exactly: empty/missing shas are skipped, a multi-repo row whose
 * `preSnapshotReposJson` is NULL (predates PR-B) falls through to the legacy
 * single-string rollback, and an unparseable map degrades to a per-repo no-op
 * (NOT a single-repo fallback — see nodeRollback.ts for the real control flow
 * the old comment here misdescribed).
 */
async function rollbackNodeRunForResume(
  task: Task,
  run: { id: string; preSnapshot: string | null; preSnapshotReposJson: string | null },
  log: ReturnType<typeof createLogger>,
  opts?: { checkOnly?: boolean },
): Promise<RollbackOutcome> {
  return await rollbackNodeRunWorktrees(
    { repoCount: task.repoCount, worktreePath: task.worktreePath, repos: task.repos },
    run,
    { resetOnEmptySnapshot: false, ...(opts?.checkOnly ? { checkOnly: true } : {}) },
    log,
  )
}

/**
 * RFC-108 T6 (AR-15): fail CLEAN with 410 if a resumable task's worktree is
 * gone (e.g. `worktreeAutoGc` reclaimed a still-`failed`/`interrupted` task —
 * the gc.ts blindspot) BEFORE the ownership CAS flips the row to pending.
 * Otherwise resumeKick CAS-flips to pending then warn-and-continues into a
 * scheduler kick whose cwd no longer exists (a generic 500). Mirrors
 * getTaskDiff's worktree-missing guard (single vs multi-repo).
 */
function assertWorktreePresentForResume(task: Task, verb: string): void {
  const gone = (msg: string): never => {
    throw new DomainError(
      'task-worktree-missing',
      `${msg}; cannot ${verb} — the worktree was likely reclaimed by worktree GC`,
      410,
    )
  }
  // AR-15's concern is `worktreeAutoGc` REMOVING the worktree (removeWorktree
  // deletes the dir), so an existence check is the right gate — and it does not
  // false-fire on tasks whose worktree dir is present but not (yet) a git repo
  // (a per-repo "source moved" edge that the diff path handles separately).
  if (!existsSync(task.worktreePath)) {
    gone(`worktree '${task.worktreePath}' does not exist`)
  }
  // Multi-repo: the container survived but every per-repo worktree was reclaimed.
  if (
    task.repoCount > 1 &&
    task.repos.length > 0 &&
    !task.repos.some((r) => existsSync(r.worktreePath))
  ) {
    gone(`task '${task.id}' has no remaining repo worktree (all reclaimed by gc)`)
  }
}

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
  db: DbClient,
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
  await recordRecoveryEvent(db, {
    taskId,
    nodeRunId: run.id,
    kind: 'snapshot-lost',
    reason: detail,
    before: { status: 'pending' },
    after: { status: 'failed' },
  })
  const failed = await getTask(db, taskId)
  if (failed !== null) emitTaskStatus(failed)
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
  db: DbClient,
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
  await recordRecoveryEvent(db, {
    taskId,
    nodeRunId: run.id,
    kind: 'live-child-survived',
    reason: `child reap unproven: ${killOutcome}; pid ${run.pid ?? '?'}`,
    before: { status: 'pending' },
    after: { status: 'failed' },
  })
  const failed = await getTask(db, taskId)
  if (failed !== null) emitTaskStatus(failed)
  throw new ConflictError(
    'live-child-survived',
    `cannot ${reason === 'resumeTask' ? 'resume' : 'retry'}: node_run ${run.id} child reap is unproven (${killOutcome}, pid ${run.pid ?? '?'}); the worktree cannot be safely reset while it may still be writing`,
  )
}

async function reapRunBeforeWorktreeReset(
  db: DbClient,
  taskId: string,
  run: {
    id: string
    nodeId: string
    pid: number | null
    startedAt: number | null
    spawnBinaryPath: string | null
  },
  reason: 'resumeTask' | 'retryNode' | 'syncTaskWorkflow',
  deps: StartTaskDeps,
  log: Logger,
): Promise<void> {
  const heldNativeLease = db
    .select({ sessionId: runtimeSessionLeases.sessionId })
    .from(runtimeSessionLeases)
    .where(eq(runtimeSessionLeases.leaseNodeRunId, run.id))
    .get()
  const killOutcome = await (deps.killStaleRunProcessTree ?? killStaleRunProcessTree)(run)
  if (killOutcome === 'killed') {
    log.warn(`${reason}: stale runtime child group-killed before rollback`, {
      nodeRunId: run.id,
      pid: run.pid,
    })
  }
  if (heldNativeLease !== undefined) {
    if (killOutcome !== 'not-alive' && killOutcome !== 'killed') {
      await escalateLiveChildSurvived(db, taskId, run, reason, killOutcome)
    }
    // A proven-dead terminal holder must be neutralized/discarded before the
    // scheduler can admit a replacement. The helper validates terminal state
    // and preserves reset/identity-invalid fail-closed semantics.
    if (repairRuntimeSessionLeasesAfterOrphanReap(db, true, run.id) !== 1) {
      await escalateLiveChildSurvived(db, taskId, run, reason, 'kill-failed')
    }
  } else if (killOutcome === 'kill-failed') {
    await escalateLiveChildSurvived(db, taskId, run, reason, killOutcome)
  }
}

async function reapHeldRuntimeSessionOwnersForTask(
  db: DbClient,
  taskId: string,
  reason: 'resumeTask' | 'retryNode' | 'syncTaskWorkflow',
  deps: StartTaskDeps,
  log: Logger,
): Promise<void> {
  const ownerIds = [
    ...new Set(
      db
        .select({ nodeRunId: runtimeSessionLeases.leaseNodeRunId })
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.taskId, taskId),
            isNotNull(runtimeSessionLeases.leaseNodeRunId),
          ),
        )
        .all()
        .flatMap((row) => (row.nodeRunId === null ? [] : [row.nodeRunId])),
    ),
  ]
  for (const nodeRunId of ownerIds) {
    const run = db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get()
    if (run === undefined) {
      await escalateLiveChildSurvived(
        db,
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

// RFC-202 T3: aligned with the shared lifecycle table's `cancel` event —
// awaiting_review / awaiting_human ARE cancelable (a user who does not want
// to answer an agent's questions must have an exit; audit P1 F-15). The old
// pending/running-only gate predated the awaiting statuses.
const CANCELABLE_TASK_STATUSES = [
  'pending',
  'running',
  'awaiting_review',
  'awaiting_human',
] as const

export async function cancelTask(
  db: DbClient,
  id: string,
  opts: {
    /**
     * RFC-243 §4.3 — set when this cancel is a parent-cascade. Lands a durable
     * `canceled-by-parent-cascade` errorMessage marker so a parent resuming
     * after a crash can still distinguish "my own cascade" (call node follows
     * the parent's canceled outcome) from "someone canceled my child"
     * (call node fails with `child-canceled`).
     */
    cascadeFromParent?: boolean
  } = {},
): Promise<Task> {
  // Bun SQLite can do this preflight synchronously, preserving the legacy
  // rejected-Promise API while allowing the no-controller path to register
  // its FIFO mutation slot before this function first yields.
  const initial = db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, id))
    .limit(1)
    .all()[0]
  if (initial === undefined) {
    throw new NotFoundError('task-not-found', `task '${id}' not found`)
  }
  if (!(CANCELABLE_TASK_STATUSES as readonly string[]).includes(initial.status)) {
    throw new ConflictError(
      'task-not-cancelable',
      `task '${id}' is already terminal (${initial.status}); nothing to cancel`,
    )
  }

  const controller = taskDriverRegistry.controllerOf(id)
  if (controller !== undefined) {
    controller.abort()
    // Wait OUTSIDE the review/cancel coordinator. The scheduler may currently
    // be inside dispatchReviewNode and must be allowed to finish that critical
    // section before its cancelTaskRow can acquire the same coordinator and
    // land the terminal CAS + synchronous human-gate sweep.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const reread = await getTask(db, id)
      if (
        reread !== null &&
        !(CANCELABLE_TASK_STATUSES as readonly string[]).includes(reread.status)
      ) {
        break
      }
      // The registered driver settled without a terminal write (for example,
      // it parked just before seeing abort). There is nothing left to wait for;
      // the locked fallback below is now the authoritative closer.
      if (taskDriverRegistry.controllerOf(id) !== controller) break
      await Bun.sleep(50)
    }
  }

  const committed = await withTaskReviewMutationLock(id, async () => {
    // Re-read only after acquiring the linearization point. A decision,
    // dispatch, scheduler cancel or competing terminal writer may have won
    // while the controller was settling; never overwrite that winner.
    let current = await getTask(db, id)
    if (current === null) {
      throw new NotFoundError('task-not-found', `task '${id}' not found`)
    }
    if ((CANCELABLE_TASK_STATUSES as readonly string[]).includes(current.status)) {
      // A controller can be attached after the lock-external snapshot (for
      // example decision-resume racing cancel). Abort it, but do not wait while
      // holding the coordinator: the terminal CAS makes its later writes lose.
      taskDriverRegistry.controllerOf(id)?.abort()
      // A non-coordinator lifecycle writer can still move between two
      // cancelable states in setTaskStatus's read→CAS window. Do not interpret
      // that CAS loss as cancellation success: re-read and retry until the row
      // is terminal, or fail explicitly under pathological continuous churn.
      let attempts = 0
      while ((CANCELABLE_TASK_STATUSES as readonly string[]).includes(current.status)) {
        if (attempts++ >= 8) {
          throw new ConflictError(
            'cancel-transition-starved',
            `task '${id}' kept changing between cancelable states while canceling; retry`,
          )
        }
        await trySetTaskStatus({
          db,
          taskId: id,
          to: 'canceled',
          allowedFrom: CANCELABLE_TASK_STATUSES,
          extra: {
            finishedAt: Date.now(),
            errorSummary: 'canceled by user',
            errorMessage:
              opts.cascadeFromParent === true
                ? 'canceled-by-parent-cascade'
                : 'no active scheduler at cancel time',
          },
          reason: 'cancelTask-fallback',
        })
        current = await getTask(db, id)
        if (current === null) {
          throw new NotFoundError('task-not-found', `task '${id}' not found`)
        }
      }
    }
    // RFC-243 §4.3 — scheduler settlement can also have landed canceled.
    // Stamp the cascade provenance inside the same critical section.
    if (opts.cascadeFromParent === true && current.status === 'canceled') {
      await db
        .update(tasks)
        .set({ errorMessage: 'canceled-by-parent-cascade' })
        .where(and(eq(tasks.id, id), eq(tasks.status, 'canceled')))
      current = (await getTask(db, id)) as Task
    }
    // Freeze the direct-child impact set while the parent transition and its
    // terminal sweep are still isolated. Recursion happens only after this
    // parent lock is released, so an active child can settle through its own
    // coordinator without an ancestor/descendant wait cycle.
    const childIds = (
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(eq(tasks.parentTaskId, id), inArray(tasks.status, [...CANCELABLE_TASK_STATUSES])),
        )
    ).map((child) => child.id)
    return { task: current, childIds }
  })

  // Broadcasters invoke listeners synchronously. Emit only after releasing
  // the task mutation coordinator so a listener that starts a same-task
  // review/cancel mutation cannot re-enter (or extend) this critical section.
  emitTaskStatus(committed.task)

  // RFC-243 §4.3 — recursively cascade into the frozen child set. Depth is
  // bounded by maxInvocationDepth; already-terminal children are idempotent.
  for (const childId of committed.childIds) {
    try {
      await cancelTask(db, childId, { cascadeFromParent: true })
    } catch (err) {
      if (
        (err instanceof ConflictError && err.code === 'task-not-cancelable') ||
        err instanceof NotFoundError
      ) {
        continue
      }
      throw err
    }
  }
  return committed.task
}

/**
 * Resume a failed or interrupted task (P-3-08). Thin shell over `resumeKick`
 * (RFC-109 D5 — abstract once, don't fork). Behaviour is byte-identical to the
 * pre-RFC-109 implementation: the `{kind:'resume'}` event derives the same
 * allowed-from set (failed/interrupted/awaiting_review/awaiting_human) and
 * rollback targets (failed/interrupted) as before.
 */
export async function resumeTask(db: DbClient, id: string, deps: StartTaskDeps): Promise<Task> {
  return resumeKick(db, id, deps, {
    event: { kind: 'resume' },
    selectRollback: (runs) => selectResumeRollbackTargets(runs),
    reason: 'resumeTask',
    conflictCode: 'task-not-resumable',
    verb: 'resume',
    worktreePreflight: true, // RFC-108 T6 (AR-15)
  })
}

/**
 * Resume while committing synchronous companion rows inside the same task
 * ownership CAS transaction. Gate decisions use this instead of "write gate,
 * then fire-and-forget resume": if preflight/CAS/companion writes fail, every
 * row remains unchanged and the user can retry the decision.
 */
export async function resumeTaskWithAtomicSideEffects(
  db: DbClient,
  id: string,
  deps: StartTaskDeps,
  onClaimTx: (tx: DbTxSync, transition: { from: TaskStatus; to: TaskStatus }) => void,
): Promise<Task> {
  return resumeKick(db, id, deps, {
    event: { kind: 'resume' },
    selectRollback: (runs) => selectResumeRollbackTargets(runs),
    reason: 'resumeTask',
    conflictCode: 'task-not-resumable',
    verb: 'resume',
    worktreePreflight: true,
    onClaimTx,
  })
}

/**
 * RFC-167 — the dynamic-workflow confirm gate's resume core: write the
 * decision's durable state ATOMICALLY within the resume ownership CAS, then
 * re-kick the scheduler. approve passes BOTH columns (swap the confirmed DAG
 * into `workflow_snapshot` + flip dw.phase='executing'); reject passes only
 * `workgroupConfigJson` (phase='generating' + the feedback) — either way a
 * failed resume (lost CAS / 410 worktree preflight) leaves the task exactly
 * as it was, so the gate stays open and the decision can be retried (Codex
 * impl-gate P1: no torn phase-vs-status stranding). Thin shell over
 * `resumeKick`, mirroring syncTaskWorkflow.
 */
export async function resumeDynamicWorkflowExecution(
  db: DbClient,
  id: string,
  deps: StartTaskDeps,
  swap: { workflowSnapshot?: string; dw: DwState },
): Promise<Task> {
  return resumeKick(db, id, deps, {
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
    // ownership CAS: a lost CAS / failed worktree preflight leaves the gate
    // open and the decision retryable; a standalone phase write would strand
    // the task in 'executing'/'generating' while still awaiting_review.
    onClaimTx: (tx) => setDwStateTx(tx, id, swap.dw),
  })
}

/**
 * RFC-292 task-row authority for resume/retry/sync-style operations. The
 * webhook context is always re-read from durable task state; an operation may
 * supply a candidate root+closure, but never a replacement trigger source.
 */
async function assertFrozenTaskTriggerPreflight(
  db: DbClient,
  taskId: string,
  candidate?: { workflowSnapshot: string; refClosureJson: string | null },
): Promise<void> {
  const frozen = (
    await db
      .select({
        workflowSnapshot: tasks.workflowSnapshot,
        refClosureJson: tasks.refClosureJson,
        triggerContextJson: tasks.triggerContextJson,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (frozen === undefined) return

  const source = parseTriggerContextJson(frozen.triggerContextJson)
  if (source.kind === 'invalid') {
    throw new ValidationError(
      'trigger-context-invalid',
      'the frozen task trigger context is invalid',
    )
  }
  const selected = candidate ?? frozen
  try {
    const root = migrateWorkflowDefinitionToLatest(
      WorkflowDefinitionSchema.parse(JSON.parse(selected.workflowSnapshot)),
    )
    assertTriggerPreflight({ root, closureJson: selected.refClosureJson, source })
  } catch (error) {
    // Historical corrupt workflow snapshots retain their existing recovery
    // behavior. Trigger failures from a valid snapshot are authoritative and
    // must occur before any lifecycle or scheduler side effect.
    if (error instanceof ValidationError && error.code.startsWith('trigger-')) throw error
  }
}

/**
 * RFC-109 — shared "reanimate a parked/terminal task and continue from the
 * breakpoint" core, extracted from resumeTask. Both resumeTask and
 * syncTaskWorkflow drive it; the ONLY differences are the transition event
 * (which fixes the allowed-from set via the shared `nextTaskStatus` table), the
 * optional `extra` columns written ATOMICALLY inside the ownership CAS (sync
 * swaps `workflow_snapshot` + `workflow_version` here), and the rollback-target
 * selector.
 *
 * The pending CAS (RFC-097 audit S-8) IS the ownership lock and moves BEFORE any
 * git rollback, so a concurrent resume/retry/sync loses with zero side effects.
 */
async function resumeKick(
  db: DbClient,
  id: string,
  deps: StartTaskDeps,
  opts: {
    event: TaskTransitionEvent
    extra?: TaskStatusUpdateExtra
    selectRollback: (
      runs: Array<typeof nodeRuns.$inferSelect>,
    ) => Array<typeof nodeRuns.$inferSelect>
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
      tx: DbTxSync,
      transition: {
        from: TaskStatus
        to: TaskStatus
      },
    ) => void
  },
): Promise<Task> {
  const task = await getTask(db, id)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${id}' not found`)
  }
  const allowedFrom = allowedFromForTaskEvent(opts.event)
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

  // RFC-292: re-check the exact execution snapshot before the ownership CAS.
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

  // RFC-108 T6 (AR-15): 410 before the ownership CAS when the worktree is gone
  // (gc reclaimed a resumable task) — never flip to pending then 500 on a
  // missing cwd. Gated per-caller (resumeTask opts in).
  if (opts.worktreePreflight === true) {
    assertWorktreePresentForResume(task, opts.verb)
  }

  // RFC-097 ownership lock — the pending CAS moves BEFORE the git rollback so a
  // concurrent resume/retry/sync loses here with zero side effects. RFC-109:
  // routed through the shared event table; `extra` carries sync's atomic
  // snapshot+version swap (one CAS UPDATE — a lost race never tears the row).
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
      ...(opts.onClaimTx !== undefined ? { onTransitionTx: opts.onClaimTx } : {}),
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
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))
  const toRollback = opts.selectRollback(runs)

  // RFC-108 T7 (AR-17): cross-node-run all-or-nothing pre-pass. The within-row
  // rollback is fail-closed, but the reset loop below touches rows one at a
  // time — if a LATER row's pre_snapshot was gc-pruned, earlier rows are already
  // reset (and their children killed) when escalateSnapshotLost fires, leaving a
  // half-rolled-back worktree. Verify EVERY row's snapshot still resolves to a
  // commit (side-effect-free `checkOnly`) BEFORE killing/resetting anything.
  for (const r of toRollback) {
    const probe = await rollbackNodeRunForResume(task, r, log, { checkOnly: true })
    if (probe.failures.some((f) => f.code === 'snapshot-missing')) {
      await escalateSnapshotLost(db, id, r, probe, opts.reason) // throws 409
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
    const outcome = await rollbackNodeRunForResume(task, r, log)
    // RFC-098 WP-9: a gc-pruned pre-snapshot is NOT warn-and-continue — the
    // fail-closed rollback touched nothing, but the baseline is gone forever;
    // flip the task failed (errorSummary='snapshot-lost') and surface a 409.
    // Other failure codes keep the historical warn-and-continue net below.
    if (outcome.failures.some((f) => f.code === 'snapshot-missing')) {
      await escalateSnapshotLost(db, id, r, outcome, opts.reason)
    }
    // The scheduler creates a new node_run with retry_index = max+1 on its
    // own when it sees no pending run for the node, so we just leave the
    // failed row as historical. The task row already flipped pending above
    // (RFC-097 ownership lock); a rollback failure keeps it pending — same
    // warn-and-continue net as before, runTask kicks regardless. A daemon
    // crash mid-rollback leaves a pending orphan that boot reaping flips to
    // interrupted (reapOrphanRuns, RFC-097 crash-window compensation).
  }

  const next = (await getTask(db, id)) as Task
  emitTaskStatus(next)

  // Kick the scheduler — same plumbing as startTask but without re-creating
  // the worktree.
  const controller = new AbortController()
  if (taskDriverRegistry.has(id)) {
    // Should be unreachable (entry check + ownership CAS) — defensive only.
    log.error(`${opts.reason}: controller already registered for task`, { taskId: id })
  }
  if ((await tryAttachTaskDriver(db, id, controller)) !== 'attached') {
    return (await getTask(db, id)) as Task
  }
  const schedulerPromise = runTask({
    taskId: id,
    db,
    appHome: deps.appHome ?? Paths.root,
    ...(deps.binaryOverride ? { binaryOverride: deps.binaryOverride } : {}),
    ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
    ...(deps.subagentLiveCapture !== undefined
      ? { subagentLiveCapture: deps.subagentLiveCapture }
      : {}),
    // RFC-075 + RFC-103 T2: thread commit&push + maxConcurrentNodes runtime
    // config through to the scheduler (single source, see runtimeConfigOpts).
    ...runtimeConfigOpts(deps),
    log,
    signal: controller.signal,
  })
    .catch((err) => {
      log.error(`runTask threw on ${opts.verb}`, {
        taskId: id,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      return releaseTaskDriverAndFinalizeWorkspace(db, id, controller)
    })

  // Mirror startTask: tests opt into awaiting the scheduler; production callers
  // (HTTP routes) fire-and-forget and get the post-flip task immediately.
  if (deps.awaitScheduler === true) {
    await schedulerPromise
    return (await getTask(db, id)) as Task
  }
  return next
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
 * which `wrapper_progress_json` is a pure debug breadcrumb the scheduler never
 * re-reads. Mirrors `findResumableWrapperRun` exactly (scheduler.ts), which
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
  runs: ReadonlyArray<typeof nodeRuns.$inferSelect>,
  producedPortsByNode?: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, NodeRunSyncSummary> {
  const runIdToNode = new Map(runs.map((r) => [r.id, r.nodeId]))
  const completed = new Set<string>()
  const liveWrapper = new Set<string>()
  for (const r of runs) {
    if (r.parentNodeRunId === null && r.status === 'done') completed.add(r.nodeId)
    // Live wrapper state = state the scheduler would actually RE-READ on resume.
    // Codex impl-gate re-review P2: `wrapper_progress_json` is left in place after
    // a TERMINAL wrapper transition as a debug breadcrumb and is never read again
    // (scheduler.ts ~2736). Mirror findResumableWrapperRun's gate exactly — it
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

/**
 * RFC-109 — re-point a non-active task at the LATEST definition of its workflow
 * and continue from the breakpoint, instead of forcing a from-scratch relaunch.
 * Swaps the frozen `workflow_snapshot` (+ records the new version) ATOMICALLY
 * inside the ownership CAS via `resumeKick`'s `extra`, then lets the scheduler
 * re-derive the frontier from the new graph (new nodes dispatch, completed
 * done∧fresh nodes are preserved, failed nodes re-run under the new definition).
 *
 * Guards (Codex design-gate, design §9): worktree-missing (AC-10), workflow
 * deleted, version TOCTOU (F5), invalid def, same-def short-circuit (F7), and
 * the wrapper-structure-changed-with-live-state BLOCKER (F3). ACL + built-in
 * checks live in the route (mirrors resume — service is actor-agnostic).
 */
export async function syncTaskWorkflow(
  db: DbClient,
  id: string,
  deps: StartTaskDeps & { expectedVersion: number },
): Promise<Task> {
  const task = await getTask(db, id)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${id}' not found`)
  }
  // Fast-fail on a non-syncable status BEFORE loading the workflow / diffing.
  // Critical for the concurrent case: a racer that already swapped the snapshot
  // makes the diff `differs=false`, so without this gate a second sync would
  // report a misleading `workflow-sync-noop` instead of `task-not-syncable`.
  // resumeKick's CAS remains the real ownership gate (this is best-effort TOCTOU
  // fast-fail with the right error code).
  if (isTaskActive(id)) {
    throw new ConflictError(
      'task-not-syncable',
      `task '${id}' is actively running (scheduler attached); cannot sync`,
    )
  }
  const syncableFrom = allowedFromForTaskEvent({ kind: 'sync-workflow' })
  if (!syncableFrom.includes(task.status)) {
    throw new ConflictError(
      'task-not-syncable',
      `task '${id}' is ${task.status}; only [${syncableFrom.join('/')}] tasks can sync`,
    )
  }
  // AC-10: worktree already GC'd → clean 409 instead of a 500 mid-rollback.
  if (task.worktreePath === '') {
    throw new ConflictError(
      'worktree-missing',
      `task '${id}' has no worktree (likely GC'd); cannot sync`,
    )
  }

  const workflow = await getWorkflow(db, task.workflowId)
  if (workflow === null) {
    throw new ConflictError('workflow-deleted', `workflow '${task.workflowId}' no longer exists`)
  }
  // F5: the user confirmed a specific preview version; refuse if the live
  // workflow moved underneath them (another PUT bumped it after preview).
  if (workflow.version !== deps.expectedVersion) {
    throw new ConflictError(
      'workflow-sync-preview-stale',
      `workflow advanced to v${workflow.version} since the preview (v${deps.expectedVersion}); refresh and re-confirm`,
    )
  }
  // RFC-292: candidate root + candidate closure are frozen and checked as one
  // snapshot. Reusing the task's old closure would either miss new child
  // trigger dependencies or execute a child definition from the wrong root.
  const frozenClosureJson = await freezeClosureForLaunch(deps, workflow.id, workflow.definition)
  const taskContextRow = (
    await db
      .select({ triggerContextJson: tasks.triggerContextJson })
      .from(tasks)
      .where(eq(tasks.id, id))
      .limit(1)
  )[0]
  assertTriggerPreflight({
    root: workflow.definition,
    closureJson: frozenClosureJson,
    source: parseTriggerContextJson(taskContextRow?.triggerContextJson),
  })
  // Same static validation gate as launch — never sync an invalid definition in.
  const validation = validateWorkflowDef(
    workflow.definition,
    await buildWorkflowValidationContext(db, {
      definition: workflow.definition,
      currentWorkflow: { id: workflow.id, name: workflow.name },
      frozenClosureJson,
    }),
  )
  if (!validation.ok) {
    const errors = validation.issues.filter((i) => (i.severity ?? 'error') === 'error')
    throw new ValidationError(
      'workflow-invalid',
      `workflow '${task.workflowId}' failed static validation (${errors.length} error${errors.length === 1 ? '' : 's'}); fix it before syncing`,
      { issues: validation.issues },
    )
  }

  const oldDef = parseSnapshotDefinition(task.workflowSnapshot)
  const newDef = workflow.definition
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))
  // The service only needs `differs` (F7) + `blockers` (F3); both are
  // independent of producedPorts, so the run summary stays output-port-free.
  const diff = diffWorkflowForSync(oldDef, newDef, buildSyncRunSummary(runs))
  // F7: definitions are semantically identical → nothing to sync; don't churn
  // the task status (done → pending → running → done) for a no-op.
  if (!diff.differs) {
    throw new ConflictError(
      'workflow-sync-noop',
      `task '${id}' is already on the latest workflow definition`,
    )
  }
  // F3: a wrapper changed structure while holding live parked/shard state —
  // swapping it would corrupt resume. Block (the user can launch a fresh task).
  if (diff.blockers.length > 0) {
    throw new ConflictError(
      'wrapper-structure-changed-with-live-state',
      diff.blockers.map((b) => b.detail).join('; '),
    )
  }

  // Wrapper carve-out for the canceled rollback (selectSyncRollbackTargets):
  // keyed to the OLD definition only (Codex impl-gate F2) — a canceled row's
  // rollback decision depends on what the node WAS when it ran (its pre_snapshot
  // + write semantics come from the old graph). If the old node was an agent
  // write canceled mid-write, roll it back even if the new graph turns that id
  // into a wrapper; if it was a wrapper, spare it (RFC-095 revives in place). A
  // wrapper↔non-wrapper kind change WITH live state is already blocked above by
  // the F1 fingerprint, so this only governs the no-live-state cases.
  const oldWrapperNodeIds = new Set<string>()
  for (const n of oldDef.nodes) {
    if (WRAPPER_KINDS.has(n.kind)) oldWrapperNodeIds.add(n.id)
  }

  // F5 TOCTOU re-check (Codex impl-gate F3): validation + diff above are local DB
  // reads, but a concurrent workflow PUT could have bumped the version in that
  // window. Re-assert it immediately before the ownership CAS so we never write a
  // snapshot the user did not confirm. This closes the real (seconds-long)
  // preview→POST window; a sub-ms residual remains (this re-read → the CAS still
  // does its own task read), but it is BENIGN — sync only ever writes the
  // user-confirmed `expectedVersion`, so even if a PUT lands there the task gets
  // the confirmed definition and the next preview shows the new delta (banner
  // reappears, no corruption). Folding the workflow-version predicate into the
  // CAS UPDATE would be fully atomic but is deliberately NOT done: it would put
  // resumeKick's worktree reset + process spawn inside one DB transaction
  // (Codex re-review agreed this is not warranted). See design §10 F3.
  const recheck = await db
    .select({ version: workflows.version })
    .from(workflows)
    .where(eq(workflows.id, task.workflowId))
    .limit(1)
  if (recheck[0]?.version !== deps.expectedVersion) {
    throw new ConflictError(
      'workflow-sync-preview-stale',
      `workflow advanced since validation; refresh and re-confirm`,
    )
  }

  return resumeKick(db, id, deps, {
    event: { kind: 'sync-workflow' },
    extra: {
      workflowSnapshot: JSON.stringify(newDef),
      workflowVersion: workflow.version,
      refClosureJson: frozenClosureJson,
    },
    selectRollback: (rs) =>
      selectSyncRollbackTargets(rs, ['failed', 'interrupted', 'canceled'], (nodeId) =>
        oldWrapperNodeIds.has(nodeId),
      ),
    reason: 'syncTaskWorkflow',
    conflictCode: 'task-not-syncable',
    verb: 'sync',
  })
}

/**
 * RFC-109 — assemble the `workflow-sync-preview` for a task whose workflow is
 * resolved + visible (the route handles deleted / not-visible before calling).
 * Computes the version delta, the full node diff (with the data-loss warnings
 * that need the preserved runs' actual produced ports), and whether the live
 * definition currently fails static validation.
 */
export async function computeWorkflowSyncPreview(
  db: DbClient,
  task: Task,
  workflow: Workflow,
  actor?: Actor,
): Promise<WorkflowSyncPreview> {
  // RFC-104 built-in workflows are never manually executed (POST sync-workflow
  // would 403) — so the banner must not appear for them (Codex impl-gate F4).
  if (workflow.builtin) {
    return {
      syncable: false,
      reason: 'builtin-workflow',
      workflowId: task.workflowId,
      workflowName: task.workflowName,
      currentVersion: task.workflowVersion,
      latestVersion: workflow.version,
      differs: false,
      invalid: false,
      invalidIssues: [],
      diff: emptyWorkflowSyncDiff(),
    }
  }
  const oldDef = parseSnapshotDefinition(task.workflowSnapshot)
  const newDef = workflow.definition
  let candidateClosureJson: string | null = null
  const closureIssues: Array<{ code: string; message: string }> = []
  if (actor !== undefined) {
    try {
      candidateClosureJson = await freezeClosureForLaunch(
        { db, launchActor: actor },
        workflow.id,
        newDef,
      )
    } catch (error) {
      closureIssues.push({
        code: error instanceof DomainError ? error.code : 'workflow-call-ref-missing',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))

  // The freshest done top-level run per node + the output ports it produced —
  // the basis for the `dangling-input-port` warning (Codex F2).
  const freshestDoneRunIdByNode = new Map<string, string>()
  const runsByNode = new Map<string, Array<typeof nodeRuns.$inferSelect>>()
  for (const r of runs) {
    const list = runsByNode.get(r.nodeId)
    if (list === undefined) runsByNode.set(r.nodeId, [r])
    else list.push(r)
  }
  for (const [nodeId, rows] of runsByNode) {
    const fresh = pickFreshestRun(rows, { topLevelOnly: true, statusIn: ['done'] })
    if (fresh !== undefined) freshestDoneRunIdByNode.set(nodeId, fresh.id)
  }
  const runIds = [...freshestDoneRunIdByNode.values()]
  const outRows =
    runIds.length > 0
      ? await db.select().from(nodeRunOutputs).where(inArray(nodeRunOutputs.nodeRunId, runIds))
      : []
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
  const contextRow = (
    await db
      .select({ triggerContextJson: tasks.triggerContextJson })
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .limit(1)
  )[0]
  const triggerIssue = triggerPreflightIssue({
    root: newDef,
    closureJson: candidateClosureJson,
    source: parseTriggerContextJson(contextRow?.triggerContextJson),
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

  const syncableStatuses = allowedFromForTaskEvent({ kind: 'sync-workflow' })
  const worktreeMissing = task.worktreePath === ''
  const statusSyncable = syncableStatuses.includes(task.status)
  const syncable = statusSyncable && !worktreeMissing
  const reason: WorkflowSyncPreview['reason'] = syncable
    ? 'ok'
    : worktreeMissing
      ? 'worktree-missing'
      : 'task-active'

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
  db: DbClient,
  task: { id: string; parentTaskId?: string | null; parentNodeRunId?: string | null },
  verb: string,
): Promise<void> {
  const callRowId = task.parentNodeRunId ?? null
  if ((task.parentTaskId ?? null) === null || callRowId === null) return
  const row = await db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, callRowId))
    .get()
  if (row === undefined) return
  if (isTerminalNodeRunStatus(row.status as NodeRunStatus)) {
    throw new ConflictError(
      'call-row-finalized',
      `task '${task.id}' is a child execution whose call node run already settled ('${row.status}'); ${verb} the parent's call node instead`,
    )
  }
}

export async function retryNode(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
  opts: { cascade?: boolean; deps: StartTaskDeps },
): Promise<Task> {
  const cascade = opts.cascade !== false
  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  // RFC-097 (audit S-8): refuse while an in-process scheduler owns the task.
  if (isTaskActive(taskId)) {
    throw new ConflictError(
      'task-still-running',
      `task '${taskId}' has an active scheduler attached; cancel it first before retrying a node`,
    )
  }
  if (task.status === 'pending' || task.status === 'running') {
    throw new ConflictError(
      'task-still-running',
      `task '${taskId}' is ${task.status}; cancel it first before retrying a node`,
    )
  }
  // RFC-243 §4.2 — child-side gate (same rule as resumeKick).
  await assertChildTaskDrivable(db, task, 'retry')
  // RFC-099 audit (2026-07-15): validate the nodeRunId belongs to THIS task
  // BEFORE the CAS below. The CAS clears finishedAt/errorSummary/errorMessage/
  // failedNodeId and flips the task to pending, so a bogus / cross-task
  // nodeRunId must be rejected here — otherwise it would knock a finished task
  // into a scheduler-less pending zombie and wipe its completion metadata
  // before the 404 fires. This is a pure read (no side effects), so the CAS's
  // ownership-lock semantics are unaffected: a concurrent-retry loser still
  // loses cleanly at the CAS with zero side effects.
  const runRow = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1))[0]
  if (runRow === undefined || runRow.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }

  // RFC-292: a retry reuses the task's immutable webhook provenance. Keep the
  // RFC-099 ownership guard above authoritative for bogus/cross-task run ids,
  // then fail trigger preflight before the task ownership CAS, rollback, child
  // cancellation, impact-set writes, or placeholder minting.
  await assertFrozenTaskTriggerPreflight(db, taskId)

  // Freeze the retry impact set BEFORE taking the task ownership CAS. Besides
  // making the placeholder plan stable, this lets us collect every child task
  // anchored by a superseded CALL row (the target plus every cascaded
  // downstream node). No child is touched yet: a bad nodeRunId, preflight
  // failure, or concurrent CAS loser therefore has zero cancellation effects.
  const downstream = new Set<string>()
  const snap = parseSnapshot(task.workflowSnapshot)
  const kindOf = new Map<string, NodeKind>()
  {
    const nodes = Array.isArray(snap?.nodes) ? snap.nodes : []
    for (const n of nodes as Array<{ id?: string; kind?: string }>) {
      if (typeof n?.id === 'string' && typeof n?.kind === 'string') {
        kindOf.set(n.id, n.kind as NodeKind)
      }
    }
  }
  if (cascade) {
    const edges = Array.isArray(snap?.edges) ? snap.edges : []
    const adj = new Map<string, string[]>()
    for (const e of edges as Array<{
      source?: { nodeId?: string }
      target?: { nodeId?: string }
    }>) {
      const s = e?.source?.nodeId
      const t = e?.target?.nodeId
      if (typeof s !== 'string' || typeof t !== 'string') continue
      const list = adj.get(s) ?? []
      if (!list.includes(t)) list.push(t)
      adj.set(s, list)
    }
    const stack: string[] = [runRow.nodeId]
    while (stack.length > 0) {
      const cur = stack.pop()!
      for (const next of adj.get(cur) ?? []) {
        if (downstream.has(next)) continue
        downstream.add(next)
        stack.push(next)
      }
    }
  }

  // RFC-052 / RFC-053 PR-C: freeze the placeholder-mint subset from the same
  // snapshot. The affected-child set below is deliberately wider: every row
  // on target+downstream with a childTaskId is superseded, even if an old or
  // malformed snapshot no longer identifies that node as a call kind.
  const targetKind = kindOf.get(runRow.nodeId)
  const wrapperRevivalTarget =
    targetKind !== undefined &&
    WRAPPER_KINDS.has(targetKind) &&
    (runRow.status === 'canceled' || runRow.status === 'interrupted')
  const targets = new Set<string>()
  if (!wrapperRevivalTarget) targets.add(runRow.nodeId)
  for (const id of downstream) {
    if (wrapperRevivalTarget && id === runRow.nodeId) continue
    const k = kindOf.get(id)
    const behavior = k === undefined ? 'mint-placeholder' : NODE_KIND_BEHAVIORS[k].retryCascade
    if (behavior === 'mint-placeholder') targets.add(id)
  }

  const affectedNodeIds = new Set([runRow.nodeId, ...downstream])
  const affectedChildTaskIds = new Set<string>()
  const affectedRows = await db
    .select({ nodeId: nodeRuns.nodeId, childTaskId: nodeRuns.childTaskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
  for (const row of affectedRows) {
    if (affectedNodeIds.has(row.nodeId) && row.childTaskId !== null) {
      affectedChildTaskIds.add(row.childTaskId)
    }
  }

  // RFC-097: ownership lock — CAS the task to pending BEFORE the rollback and
  // placeholder minting so a concurrent retry/resume loses with zero side
  // effects (the old order let the loser pollute node_runs and the worktree).
  // from = the complement of {pending, running}; canceled→pending is the
  // RFC-095 revival path; done→pending is an explicit re-run of a finished
  // node. All four terminal sources are deliberate — allowTerminal.
  try {
    await setTaskStatus({
      db,
      taskId,
      to: 'pending',
      allowedFrom: [
        'done',
        'failed',
        'canceled',
        'interrupted',
        'awaiting_review',
        'awaiting_human',
      ],
      allowTerminal: true,
      extra: { finishedAt: null, errorSummary: null, errorMessage: null, failedNodeId: null },
      reason: 'retryNode',
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
        'task-still-running',
        `task '${taskId}' changed state concurrently; cancel/settle it before retrying a node`,
      )
    }
    throw err
  }

  await reapHeldRuntimeSessionOwnersForTask(db, taskId, 'retryNode', opts.deps, log)

  // RFC-243 D12 — only the retry CAS winner may supersede child invocations.
  // Cancel every frozen target/downstream child before rollback or placeholder
  // minting, so no old child can keep writing the inherited workspace while a
  // new generation starts. Terminal/deleted children are already settled and
  // therefore idempotent no-ops. An unexpected cancellation failure closes the
  // owned task back to failed and aborts the retry: never leave a scheduler-less
  // pending row and never reset/mint after a partially failed cancellation set.
  for (const childTaskId of affectedChildTaskIds) {
    try {
      await cancelTask(db, childTaskId, { cascadeFromParent: true })
    } catch (err) {
      if (
        (err instanceof ConflictError && err.code === 'task-not-cancelable') ||
        err instanceof NotFoundError
      ) {
        continue
      }
      const detail = err instanceof Error ? err.message : String(err)
      try {
        await setTaskStatus({
          db,
          taskId,
          to: 'failed',
          allowedFrom: ['pending'],
          extra: {
            finishedAt: Date.now(),
            errorSummary: 'retry-child-cancel-failed',
            errorMessage: `failed to cancel superseded child task '${childTaskId}': ${detail}`,
            failedNodeId: runRow.nodeId,
          },
          reason: 'retryNode:child-cancel-failed',
        })
      } catch (closeErr) {
        const current = await getTask(db, taskId)
        // A concurrent terminal winner is also fail-closed. If the row somehow
        // remains pending, surface the close failure because it is the stronger
        // invariant violation and must not be mistaken for a clean child error.
        if (current?.status === 'pending') throw closeErr
      }
      const failed = await getTask(db, taskId)
      if (failed !== null) emitTaskStatus(failed)
      throw new ConflictError(
        'retry-child-cancel-failed',
        `cannot retry node '${runRow.nodeId}': superseded child task '${childTaskId}' could not be canceled (${detail})`,
      )
    }
  }

  // Rollback to the snapshot before the node_run started. The single-node
  // retry uses THIS run's snapshot (not the latest, since the user picked
  // this specific historical attempt).
  // RFC-098 WP-8: same kill-then-proceed as resumeTask — group-kill the
  // target row's still-alive child (if any) before touching the worktree.
  await reapRunBeforeWorktreeReset(db, taskId, runRow, 'retryNode', opts.deps, log)
  // RFC-098 WP-9: snapshot-missing escalates to task failed + 409 (same
  // contract as resumeTask) — no placeholder rows are minted and no
  // scheduler is kicked when the promised baseline no longer exists.
  const rollbackOutcome = await rollbackNodeRunForResume(task, runRow, log)
  if (rollbackOutcome.failures.some((f) => f.code === 'snapshot-missing')) {
    await escalateSnapshotLost(db, taskId, runRow, rollbackOutcome, 'retryNode')
  }

  // Flip target + downstream node_runs from done → failed so the resumer
  // re-runs them. We do this by inserting a fresh failed row at retry_index
  // max+1, so the scheduler treats it as the "latest" and starts attempt+1.
  //
  // Carry forward (iteration, reviewIteration, shardKey, parentNodeRunId,
  // preSnapshot) from the prior run so the retried attempt resumes in the same
  // loop / review / shard frame. RFC-074 PR-C: the clarify generation is no
  // longer carried on the row — it is derived from prior-done id-order at
  // dispatch time, and the answered Q&A surfaces via the RFC-070 consumed-by
  // stamp regardless of which row this retry is. For the explicitly retried
  // target the source-of-truth is `runRow` (the row the
  // user picked); for cascaded downstream nodes we inherit from each node's
  // own latest row.
  // RFC-052 / RFC-053 PR-C: per-kind cascade behavior comes from
  // `NODE_KIND_BEHAVIORS[k].retryCascade` (shared/node-kind-behavior.ts).
  // The user-picked node (`runRow.nodeId`) is included unconditionally —
  // direct retry on a non-process node is a different operation the user
  // explicitly chose. Downstream nodes are filtered by the table: kinds
  // with retryCascade='mint-placeholder' get a placeholder row; kinds with
  // 'skip' don't (RFC-052 fix). Unknown kinds (snapshot missing / older
  // schema) default to 'mint-placeholder' to preserve the legacy
  // pre-RFC-052 behavior on stale data.
  // RFC-098 B3 (audit ⑥-11): when the user-picked TARGET row is a WRAPPER's
  // own canceled/interrupted row, do NOT mint the failed placeholder — that
  // row already IS the revival signal (isDispatchable treats canceled /
  // interrupted as dispatchable, RFC-095) and findResumableWrapperRun resumes
  // the SAME row (continue-from-persisted-progress). A failed placeholder
  // would become the node's latest row, make findResumableWrapperRun return
  // null, and restart the wrapper from iteration 0 / re-capture the git
  // baseline — exactly the continue-not-restart semantics RFC-095 promised.
  // Downstream cascade placeholders are kept (a downstream wrapper restarting
  // from 0 after its upstream changed is the correct semantics); other target
  // statuses (done / failed / awaiting_*) keep the placeholder mint —
  // findResumableWrapperRun treats done/failed as terminal, so the placeholder
  // is what re-arms dispatch there. See rfc095-wrapper-canceled-revival /
  // retry-cascade-kind-matrix.
  for (const nodeId of targets) {
    // RFC-096 (audit S-13 / 附录 C #2): the inheritance source is the freshest
    // TOP-LEVEL row by pure id — the old `desc(retryIndex)` pick had no
    // iteration / parent filter, so a placeholder could inherit a fan-out
    // child's parentNodeRunId (invisible to the frontier → cascade silently
    // dead) or a stale iteration. nextRetry stays the ALL-rows max+1
    // (conservative: legacy pathological rows minted by the old pickers may
    // carry inflated retryIndex on child/inherited rows — never collide).
    // prev === undefined (e.g. a fanout-inner node with only child rows) keeps
    // the `?? 0` fallback below: the placeholder lands as a fresh top-level
    // row that is inert for the top-level scope (inner nodes re-run via the
    // wrapper's own resume path).
    const existing = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
    const prev = pickFreshestRun(existing, { topLevelOnly: true })
    // RFC-284 T21：口径=全行集（刻意含 child rows），收编 nextRetryIndex。
    const nextRetry = nextRetryIndex(existing)
    const inherit = nodeId === runRow.nodeId ? runRow : prev
    await mintNodeRun(db, {
      taskId,
      nodeId,
      status: 'failed',
      cause: nodeId === runRow.nodeId ? 'retry-node' : 'retry-node-cascade',
      retryIndex: nextRetry,
      iteration: inherit?.iteration ?? 0,
      inheritFrom: inherit ?? null,
      overrides: { finishedAt: Date.now(), errorMessage: 'queued for retry' },
    })
  }

  // Task row already flipped pending above (RFC-097 ownership lock).
  const next = (await getTask(db, taskId)) as Task
  emitTaskStatus(next)

  const controller = new AbortController()
  if ((await tryAttachTaskDriver(db, taskId, controller)) !== 'attached') {
    return (await getTask(db, taskId)) as Task
  }
  void runTask({
    taskId,
    db,
    appHome: opts.deps.appHome ?? Paths.root,
    ...(opts.deps.binaryOverride ? { binaryOverride: opts.deps.binaryOverride } : {}),
    ...(opts.deps.configPath !== undefined ? { configPath: opts.deps.configPath } : {}),
    ...(opts.deps.subagentLiveCapture !== undefined
      ? { subagentLiveCapture: opts.deps.subagentLiveCapture }
      : {}),
    // RFC-103 T2 (01-LIFE-06): retryNode historically dropped commit&push +
    // maxConcurrentNodes; thread them like start/resume via the single source.
    ...runtimeConfigOpts(opts.deps),
    log,
    signal: controller.signal,
  })
    .catch((err) => {
      log.error('runTask threw on node retry', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      return releaseTaskDriverAndFinalizeWorkspace(db, taskId, controller)
    })
  return next
}

function parseSnapshot(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'object' && v !== null) return v as Record<string, unknown>
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

/**
 * Push a task-status update onto both broadcaster channels at once.
 * Scheduler + cancel path both call this after each state change.
 */
export function emitTaskStatus(t: Task): void {
  tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
    type: 'task.status',
    taskId: t.id,
    status: t.status,
  })
  taskBroadcaster.broadcast(TASK_CHANNEL(t.id), {
    id: -1,
    type: 'task.status',
    status: t.status,
    ...(t.errorSummary !== null ? { errorSummary: t.errorSummary } : {}),
  })
  if (
    t.status === 'done' ||
    t.status === 'failed' ||
    t.status === 'canceled' ||
    t.status === 'interrupted'
  ) {
    taskBroadcaster.broadcast(TASK_CHANNEL(t.id), {
      id: -1,
      type: 'task.done',
      status: t.status,
    })
  }
}

export async function getTask(db: DbClient, id: string): Promise<Task | null> {
  const rows = await db
    .select({ task: tasks, workflowName: workflows.name })
    .from(tasks)
    .leftJoin(workflows, eq(workflows.id, tasks.workflowId))
    .where(eq(tasks.id, id))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  // RFC-066: hydrate per-repo metadata. Defensive fallback when task_repos is
  // empty (legacy rows that landed before migration 0034 backfill, or the
  // ultra-rare mid-migration crash): synthesize a single repo entry from the
  // legacy `tasks.*` mirror columns so callers always see at least one entry.
  const repoRows = await db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, id))
    .orderBy(asc(taskRepos.repoIndex))
  const repos: TaskRepo[] =
    repoRows.length > 0 ? repoRows.map(mapTaskRepoRow) : [synthesizeRepoFromTaskRow(row.task)]
  const frozenNodeRows = await db
    .select({ path: taskSpaceNodes.nodePath })
    .from(taskSpaceNodes)
    .where(eq(taskSpaceNodes.taskId, id))
  const nodePaths =
    frozenNodeRows.length > 0
      ? frozenNodeRows
          .map((node) => node.path)
          .sort((a, b) => mountDepth(a) - mountDepth(b) || a.localeCompare(b))
      : minimalNodePaths(repos.map((repo) => repo.mountPath))
  const spaceNodes: PlannedDirectoryNode[] = nodePaths.map((path) => ({ path, origins: [] }))
  const parsedTriggerContext = parseTriggerContextJson(row.task.triggerContextJson)
  const webhookSourceLink =
    parsedTriggerContext.kind === 'ok' ? webhookTaskSourceLinkOf(parsedTriggerContext.value) : null
  const task = rowToTask(row.task, row.workflowName, repos, spaceNodes, webhookSourceLink)
  // RFC-203 T4: task-level failure-code projection (failed-run oracle).
  const codes = await loadTaskFailureCodes(db, [
    { id: row.task.id, status: row.task.status, failedNodeId: row.task.failedNodeId },
  ])
  const failureCode = codes.get(row.task.id)
  return failureCode !== undefined ? { ...task, failureCode } : task
}

export interface ListTasksFilters {
  status?: Task['status']
  workflowId?: string
  repoPath?: string
  /** RFC-159: filter to tasks launched by a given `scheduled_tasks` id (run history). */
  scheduledTaskId?: string
  /**
   * RFC-243 §8: parent/child list filters (PR-2 lands the query surface only —
   * the DEFAULT stays "everything flat" until PR-5 flips it together with the
   * nesting UI, so awaiting child executions never become invisible in a
   * window where the UI cannot reveal them).
   *   - topLevelOnly: only rows with parent_task_id IS NULL.
   *   - parentTaskId: only the direct children of the given task.
   */
  topLevelOnly?: boolean
  parentTaskId?: string
  limit?: number
  /**
   * RFC-036 visibility filter. When set, the SQL also requires either
   * `tasks.owner_user_id = visibility.actorUserId` OR an entry in
   * task_collaborators for that user. `scope: 'shared'` excludes self-owned
   * rows. Setting visibility=undefined disables the filter (admin scope=all
   * + legacy daemon-token callers).
   */
  visibility?: {
    actorUserId: string
    scope: 'mine' | 'shared'
  }
}

/**
 * The member-visibility predicate: owner OR task_collaborators membership
 * ('mine'), or strictly shared-with-me-but-not-mine ('shared'). Single source
 * shared by listTasks and /api/overview task stats (RFC-190) so the two can
 * never drift.
 */
export function taskVisibilityCondition(
  db: DbClient,
  visibility: { actorUserId: string; scope: 'mine' | 'shared' },
): SQL<unknown> {
  return taskOwnershipScopeCondition(
    db,
    defaultTaskAuthorizationRef(),
    visibility.actorUserId,
    visibility.scope,
  )
}

interface TaskSummaryRow {
  summary: TaskSummary
  ownerUserId: string | null
}

async function listTaskSummaryRows(
  db: DbClient,
  filters: ListTasksFilters = {},
): Promise<TaskSummaryRow[]> {
  const conditions = []
  if (filters.status !== undefined) conditions.push(eq(tasks.status, filters.status))
  if (filters.workflowId !== undefined) conditions.push(eq(tasks.workflowId, filters.workflowId))
  if (filters.repoPath !== undefined) conditions.push(eq(tasks.repoPath, filters.repoPath))
  if (filters.scheduledTaskId !== undefined)
    conditions.push(eq(tasks.scheduledTaskId, filters.scheduledTaskId))
  if (filters.topLevelOnly === true) conditions.push(isNull(tasks.parentTaskId))
  if (filters.parentTaskId !== undefined)
    conditions.push(eq(tasks.parentTaskId, filters.parentTaskId))
  if (filters.visibility) {
    conditions.push(taskVisibilityCondition(db, filters.visibility))
  }
  const where =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions)
  const rows = await db
    .select({ task: tasks, workflowName: workflows.name })
    .from(tasks)
    .leftJoin(workflows, eq(workflows.id, tasks.workflowId))
    .where(where)
    .orderBy(desc(tasks.startedAt))
    .limit(filters.limit ?? 100)
  // RFC-108 T22: one grouped query for the open-alert count of every listed
  // task, so the list can render a "stuck" badge without a per-row fetch.
  const taskIds = rows.map((r) => r.task.id)
  const alertCounts =
    taskIds.length === 0
      ? []
      : await db
          .select({ taskId: lifecycleAlerts.taskId, n: count() })
          .from(lifecycleAlerts)
          .where(and(inArray(lifecycleAlerts.taskId, taskIds), isNull(lifecycleAlerts.resolvedAt)))
          .groupBy(lifecycleAlerts.taskId)
  const openByTask = new Map(alertCounts.map((a) => [a.taskId, Number(a.n)]))
  // RFC-203 T4: one batched failure-code projection for the whole page.
  const failureCodes = await loadTaskFailureCodes(
    db,
    rows.map((r) => ({
      id: r.task.id,
      status: r.task.status,
      failedNodeId: r.task.failedNodeId,
    })),
  )
  return rows.map((r) => ({
    ownerUserId: r.task.ownerUserId ?? null,
    summary: {
      ...rowToSummary(r.task, r.workflowName),
      openAlertCount: openByTask.get(r.task.id) ?? 0,
      ...(failureCodes.has(r.task.id) ? { failureCode: failureCodes.get(r.task.id) ?? null } : {}),
    },
  }))
}

export async function listTasks(
  db: DbClient,
  filters: ListTasksFilters = {},
): Promise<TaskSummary[]> {
  return (await listTaskSummaryRows(db, filters)).map((row) => row.summary)
}

/**
 * RFC-243 follow-up — direct visible child counts for one page of list rows.
 *
 * ONE grouped query for the whole page (never a per-row probe), and it reuses
 * `taskVisibilityCondition` — the exact predicate the list itself ran under.
 * That shared predicate is the point: it makes `childCount > 0` mean "expanding
 * shows something" for THIS actor, so a child the viewer cannot see can never
 * produce an arrow that opens onto an empty list.
 */
async function loadChildCounts(
  db: DbClient,
  parentIds: readonly string[],
  visibility: ListTasksFilters['visibility'],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (parentIds.length === 0) return counts
  const conditions: SQL<unknown>[] = [inArray(tasks.parentTaskId, [...parentIds])]
  if (visibility) conditions.push(taskVisibilityCondition(db, visibility))
  const rows = await db
    .select({ parentTaskId: tasks.parentTaskId, n: count() })
    .from(tasks)
    .where(and(...conditions))
    .groupBy(tasks.parentTaskId)
  for (const row of rows) {
    if (row.parentTaskId !== null) counts.set(row.parentTaskId, row.n)
  }
  return counts
}

/** RFC-232 — list-only owner projection over the canonical summary pipeline. */
export async function listTaskItems(
  db: DbClient,
  filters: ListTasksFilters = {},
): Promise<TaskListItem[]> {
  const rows = await listTaskSummaryRows(db, filters)
  const owners = await loadOwnerIdentities(
    db,
    rows.map((row) => row.ownerUserId),
  )
  const childCounts = await loadChildCounts(
    db,
    rows.map((row) => row.summary.id),
    filters.visibility,
  )
  return rows.map(({ summary, ownerUserId }) => ({
    ...summary,
    ownerUserId,
    owner: ownerUserId === null ? null : (owners.get(ownerUserId) ?? null),
    childCount: childCounts.get(summary.id) ?? 0,
  }))
}

/**
 * RFC-075: defensively parse `node_runs.commit_push_json` into CommitPushMeta.
 * Returns null for regular rows (NULL column) and for any corrupt payload —
 * the column is framework-written, so corruption shouldn't happen, but a bad
 * row must not 5xx the whole task-detail response.
 */
function parseCommitPushJson(raw: string | null): CommitPushMeta | null {
  if (raw === null || raw === '') return null
  try {
    const parsed = CommitPushMetaSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * RFC-203 T4 — deterministic failed-run oracle: for failed tasks, project the
 * RFC-145 failure code of the FAILED NODE's freshest top-level run into the
 * task-level DTO (Task / TaskSummary.failureCode) so the list page and the
 * failure banner can localize copy without fetching node runs. One batched
 * query for any number of tasks; tasks without failedNodeId (scheduler-level
 * failures) resolve to null.
 */
export async function loadTaskFailureCodes(
  db: DbClient,
  rows: ReadonlyArray<{ id: string; status: string; failedNodeId: string | null }>,
): Promise<Map<string, FailureCode | null>> {
  const out = new Map<string, FailureCode | null>()
  const wanted = rows.filter((r) => r.status === 'failed' && r.failedNodeId !== null)
  if (wanted.length === 0) return out
  const runRows = await db
    .select({
      taskId: nodeRuns.taskId,
      nodeId: nodeRuns.nodeId,
      id: nodeRuns.id,
      parentNodeRunId: nodeRuns.parentNodeRunId,
      status: nodeRuns.status,
      failureCode: nodeRuns.failureCode,
    })
    .from(nodeRuns)
    .where(
      inArray(
        nodeRuns.taskId,
        wanted.map((r) => r.id),
      ),
    )
  for (const t of wanted) {
    const candidates = runRows.filter((r) => r.taskId === t.id && r.nodeId === t.failedNodeId)
    const fresh = pickFreshestRun(candidates, { topLevelOnly: true })
    out.set(t.id, (fresh?.failureCode ?? null) as FailureCode | null)
  }
  return out
}

/**
 * Returns all node_runs rows for a task plus their captured port outputs.
 * Ordering: started_at ascending so the frontend can render them as a
 * timeline. node_runs that haven't started yet (`pending`) tail the list
 * sorted by id.
 */
export async function getTaskNodeRuns(db: DbClient, taskId: string): Promise<TaskNodeRuns> {
  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  const runRows = await db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
    .orderBy(asc(nodeRuns.startedAt), asc(nodeRuns.id))

  // RFC-078: group the task's doc_versions by review node_run so we can derive
  // each review row's content-anchored "this round started" timestamp instead
  // of surfacing its pinned (slot-first-open) started_at. One extra query; no
  // N+1. Non-review runs simply have no doc_versions → timing derives to null.
  // RFC-158: project the extra columns selectCurrentReviewRound needs
  // (decidedBy for the human-vs-system check; itemIndex / roundGeneration /
  // reviewIteration for the multi-doc round pick — reviewIteration here is the
  // PER-DOC value, distinct from node_run.review_iteration). The raw rows
  // structurally satisfy both ReviewVersionFacts (RFC-078 timing) and
  // CurrentReviewRoundRow (RFC-158 nav), so one grouping feeds both.
  const dvRows = await db
    .select({
      reviewNodeRunId: docVersions.reviewNodeRunId,
      createdAt: docVersions.createdAt,
      versionIndex: docVersions.versionIndex,
      decision: docVersions.decision,
      decidedAt: docVersions.decidedAt,
      decidedBy: docVersions.decidedBy,
      itemIndex: docVersions.itemIndex,
      roundGeneration: docVersions.roundGeneration,
      reviewIteration: docVersions.reviewIteration,
    })
    .from(docVersions)
    .where(eq(docVersions.taskId, taskId))
  const dvRowsByRun = new Map<string, (typeof dvRows)[number][]>()
  for (const dv of dvRows) {
    const list = dvRowsByRun.get(dv.reviewNodeRunId)
    if (list === undefined) dvRowsByRun.set(dv.reviewNodeRunId, [dv])
    else list.push(dv)
  }

  // RFC-161: task-detail canvas click target for clarify / cross-clarify node_runs.
  // Load the task's clarify_rounds and keep, per intermediary node_run, the
  // createdAt-max round's status — the SAME selection getClarifyRoundDetail renders
  // with (orderBy(desc(createdAt)).limit(1)). RFC-161's only safety requirement is
  // "clarifyNavKind != null ⟹ the run has a round ⟹ getClarifyRoundDetail won't 404";
  // it does not depend on which round wins a same-createdAt tie (a same-createdAt
  // duplicate only arises from concurrent idempotent replay of one un-answered emission,
  // whose rounds are equivalent — a pre-existing clarify-subsystem property RFC-161 does
  // not touch; see design §4.5). One extra query; no N+1.
  const crRows = await db
    .select({
      intermediaryNodeRunId: clarifyRounds.intermediaryNodeRunId,
      status: clarifyRounds.status,
      createdAt: clarifyRounds.createdAt,
    })
    .from(clarifyRounds)
    .where(eq(clarifyRounds.taskId, taskId))
  const latestRoundByRun = new Map<string, { status: ClarifyRoundStatus; createdAt: number }>()
  for (const cr of crRows) {
    const prev = latestRoundByRun.get(cr.intermediaryNodeRunId)
    if (prev === undefined || cr.createdAt > prev.createdAt) {
      latestRoundByRun.set(cr.intermediaryNodeRunId, {
        status: cr.status as ClarifyRoundStatus,
        createdAt: cr.createdAt,
      })
    }
  }
  // Orphaned awaiting suppression: cancelTaskRow/failTask only flip the task row and
  // leave the clarify round + node_run awaiting_human behind (scheduler.ts:541-543 /
  // :5596-5611), so a canceled/failed task must not advertise its clarify as answerable.
  // 'answered' is NOT gated — viewing history on any task is fine.
  const clarifyTaskDead = task.status === 'canceled' || task.status === 'failed'

  const runs: NodeRun[] = runRows.map((r) => {
    const dvForRun = dvRowsByRun.get(r.id) ?? []
    const reviewTiming = deriveReviewRoundTiming(r, dvForRun)
    // RFC-158: canvas click target for this review run. Gated on a renderable
    // current round (round !== null ⟺ has a doc_version ⟺ getReviewDetail won't
    // 404), then awaiting (live) vs decided (human conclusion). null for
    // non-review rows, empty-list reviews (zero doc_version), pending/system
    // current rounds. Same selectCurrentReviewRound getReviewDetail renders with.
    //
    // 'awaiting' additionally requires the current representative to be PENDING:
    // an awaiting_review run whose current round is an EMPTY list (dispatch
    // parks awaiting WITHOUT minting a new doc_version, review.ts:688-700) has
    // only OLD decided rows as its representative — clicking would open that
    // stale round, not the empty live one, so it must be null instead (impl-gate
    // reopened-empty regression; mirrors the first-round R5 zero-doc case).
    const round = selectCurrentReviewRound(dvForRun)
    let reviewNavKind: 'awaiting' | 'decided' | null = null
    if (round !== null) {
      if (r.status === 'awaiting_review') {
        if (round.representative.decision === 'pending') reviewNavKind = 'awaiting'
      } else if (isHumanReviewConclusion(round.representative)) {
        reviewNavKind = 'decided'
      }
    }
    // RFC-161: clarify / cross-clarify canvas nav. null for non-clarify runs (no
    // round in the map) and canceled/abandoned rounds; 'awaiting' suppressed on a
    // dead task (orphaned awaiting).
    let clarifyNavKind = clarifyNavKindForRoundStatus(latestRoundByRun.get(r.id)?.status)
    if (clarifyNavKind === 'awaiting' && clarifyTaskDead) clarifyNavKind = null
    return {
      id: r.id,
      taskId: r.taskId,
      nodeId: r.nodeId,
      parentNodeRunId: r.parentNodeRunId,
      iteration: r.iteration,
      shardKey: r.shardKey,
      retryIndex: r.retryIndex,
      // RFC-189 — the authoritative lw workgroup round ordinal (NULL elsewhere).
      wgRound: r.wgRound ?? null,
      // RFC-182 P1-3 — wire the mint cause for wg-aware history labels.
      rerunCause: r.rerunCause ?? null,
      reviewIteration: r.reviewIteration,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      pid: r.pid,
      exitCode: r.exitCode,
      errorMessage: r.errorMessage,
      // RFC-203 T4: RFC-145 machine-readable failure code, now surfaced so
      // the UI can localize failure copy instead of parsing errorMessage.
      failureCode: (r.failureCode ?? null) as FailureCode | null,
      // RFC-243: child task launched by this call node_run (link + live status).
      childTaskId: r.childTaskId ?? null,
      supersededByReview: (r.supersededByReview ?? null) as 'iterated' | 'rejected' | null,
      rolledBack: r.rolledBack ?? null,
      promptText: r.promptText,
      tokInput: r.tokInput,
      tokOutput: r.tokOutput,
      tokTotal: r.tokTotal,
      tokCacheCreate: r.tokCacheCreate,
      tokCacheRead: r.tokCacheRead,
      // RFC-026: surface opencode session id to the UI so a clarify-inline
      // chip can render + operators can copy it for local debugging.
      opencodeSessionId: r.opencodeSessionId,
      // RFC-046: parse the post-budget-clip memory snapshot the runner
      // persisted at inject time. Malformed payloads degrade to null + log
      // (the column is JSON written by the runner; nothing user-supplied,
      // so corruption should be impossible, but defensive at the API edge
      // beats a 5xx on the whole task detail page).
      injectedMemories: parseInjectedSnapshotJson(r.injectedMemoriesJson),
      // RFC-049: structured port-validation failures captured by the runner
      // (NULL for successful runs or runs that failed for any reason other
      // than port-content validation). Same defensive-parse contract as
      // injectedMemories — corrupted payloads degrade to null rather than
      // throw the whole task detail response.
      portValidationFailures: parsePortValidationFailuresJson(r.portValidationFailuresJson),
      // RFC-075: commit&push metadata on framework-synthesized commit rows
      // (NULL on every regular node_run). Defensive parse: corrupt payloads
      // degrade to null rather than 5xx the whole task-detail response.
      commitPush: parseCommitPushJson(r.commitPushJson),
      // RFC-078: review-round display anchor (see reviewRoundStart.ts). Null for
      // non-review rows; the UI falls back to startedAt when null.
      reviewRoundStartedAt: reviewTiming?.roundStartedAt ?? null,
      reviewDecidedAt: reviewTiming?.decidedAt ?? null,
      // RFC-158: task-detail canvas click target (see schemas/task.ts).
      reviewNavKind,
      // RFC-161: clarify / cross-clarify canvas click target (see schemas/task.ts).
      clarifyNavKind,
    }
  })

  // RFC-078: re-sort with review rows keyed on their round anchor (not their
  // pinned started_at), so a review lands after the content it reviews instead
  // of at the slot-first-open tick. Non-review rows keep asc(startedAt, id).
  runs.sort(compareNodeRunsForTimeline)

  let outputs: NodeRunOutput[] = []
  if (runs.length > 0) {
    const runIds = runs.map((r) => r.id)
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(inArray(nodeRunOutputs.nodeRunId, runIds))
    outputs = outRows.map((o) => ({
      nodeRunId: o.nodeRunId,
      port: o.portName,
      value: o.content,
      kind: o.kind, // RFC-072: surface resolved output kind for the Outputs tab
    }))
  }
  return { runs, outputs }
}

/**
 * Page events for one node_run. `since` is the event id cursor (exclusive);
 * returns up to `limit` events ordered by id ascending plus the new cursor.
 *
 * Caller is responsible for asserting that the task owns the node_run; we
 * just verify the node_run belongs to the task to avoid cross-task leakage.
 */
export async function getNodeRunEvents(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
  opts: { since?: number; limit?: number; logsDir?: string } = {},
): Promise<NodeRunEventsResponse> {
  const ownerRows = await db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const owner = ownerRows[0]
  if (owner === undefined || owner.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }
  const limit = Math.min(opts.limit ?? 500, 1000)
  const since = opts.since ?? 0
  const logsDir = opts.logsDir ?? Paths.logsDir

  // P-5-01: archived events (oldest) come first; live DB rows fill the
  // remainder up to `limit`. Skipping the archive read when since is past
  // the highest archived id is handled implicitly by `readArchivedEvents`
  // returning [] when nothing matches.
  const archived = await readArchivedEvents(logsDir, taskId, nodeRunId, since, limit)
  const events: NodeRunEvent[] = archived.map((a) => {
    let payload: unknown
    try {
      payload = JSON.parse(a.payload)
    } catch {
      payload = a.payload
    }
    return {
      id: a.id,
      nodeRunId,
      ts: a.ts,
      kind: a.kind as NodeRunEvent['kind'],
      payload,
    }
  })

  const remaining = limit - events.length
  if (remaining > 0) {
    const dbLowerBound = events.length > 0 ? events[events.length - 1]!.id : since
    const rows = await db
      .select()
      .from(nodeRunEvents)
      .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), gt(nodeRunEvents.id, dbLowerBound)))
      .orderBy(asc(nodeRunEvents.id))
      .limit(remaining)
    for (const r of rows) {
      let payload: unknown
      try {
        payload = JSON.parse(r.payload)
      } catch {
        payload = r.payload
      }
      events.push({
        id: r.id,
        nodeRunId: r.nodeRunId,
        ts: r.ts,
        kind: r.kind,
        payload,
      })
    }
  }
  const cursor = events.length > 0 ? (events[events.length - 1]?.id ?? null) : null
  return { events, cursor }
}

/**
 * Concatenated stdout for one node_run (P-3-13). Returns every event's
 * raw `payload` ordered by id ascending, joined with `\n`. Stderr events
 * are excluded — those live on the Events tab.
 */
export async function getNodeRunStdout(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
  opts: { logsDir?: string } = {},
): Promise<string> {
  const ownerRows = await db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const owner = ownerRows[0]
  if (owner === undefined || owner.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }
  // Archived (oldest) lines come first, live DB rows last. Stderr is dropped
  // from both sides — that channel lives on the Events tab.
  const logsDir = opts.logsDir ?? Paths.logsDir
  const archived = await readArchivedEvents(logsDir, taskId, nodeRunId, 0, Number.MAX_SAFE_INTEGER)
  const archivedTexts = archived.filter((a) => a.kind !== 'stderr').map((a) => a.payload)
  const rows = await db
    .select({ payload: nodeRunEvents.payload, kind: nodeRunEvents.kind })
    .from(nodeRunEvents)
    .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    .orderBy(asc(nodeRunEvents.id))
  const dbTexts = rows.filter((r) => r.kind !== 'stderr').map((r) => r.payload)
  return [...archivedTexts, ...dbTexts].join('\n')
}

/**
 * Cumulative diff in the worktree since the task started.
 *
 * Single-repo tasks (the legacy default and `task.repoCount === 1`): return
 * the unchanged 1 MiB-capped `worktreeDiff` of `task.worktreePath` against
 * `task.baseCommit`. Byte-baseline equivalent to pre-RFC-066 callers.
 *
 * Multi-repo tasks (RFC-066 PR-B T12, `task.repoCount > 1`): walk each
 * `task_repos` row in `repoIndex` order, compute the per-repo diff against
 * that repo's own `base_commit`, and concatenate the results with a
 * `# === Repo: <worktreeDirName> ===` header per repo. Empty diffs are
 * skipped (no header for repos that didn't change). The combined output is
 * capped at the same 1 MiB total budget; `truncated: true` is returned if a
 * later repo's diff would overflow, in which case the partial header + as
 * many bytes as fit are still emitted so the user sees what's there. The
 * top-level `baseCommit` field is null in multi-repo (no single commit
 * represents the whole task — the per-repo commits live inside the diff
 * text headers).
 *
 * Throws ValidationError if baseCommit wasn't captured (task failed before
 * worktree creation) or if the worktree directory has been removed. In
 * multi-repo mode the gate is per-repo: a missing parent dir still throws,
 * but an individual repo with `base_commit IS NULL` is skipped (its diff
 * would be undefined). At least one repo must have a usable base_commit
 * for the call to succeed.
 */
const TASK_DIFF_MAX_BYTES = 1024 * 1024 // 1 MiB — same cap as worktreeDiff.

export async function getTaskDiff(db: DbClient, taskId: string): Promise<TaskDiff> {
  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  if (task.repoCount === 1) {
    // RFC-066: single-path byte-baseline branch — pre-RFC-066 callers see
    // the same response shape, the same error codes, and the same order
    // of checks (baseCommit first → no-base-commit 409, then worktree
    // existence → worktree-missing 410). Reordering would shift a small
    // class of failure modes between the two error codes for failed-tasks
    // that never materialized a worktree.
    if (task.baseCommit === null) {
      throw new DomainError(
        'task-no-base-commit',
        `task '${taskId}' has no base commit recorded; cannot compute diff`,
        409,
      )
    }
    // `existsSync` is not enough: a worktree dir can outlive its source repo
    // (moved/deleted), leaving a directory git can't resolve. Probing it here
    // turns what was a cryptic 500 (`git diff` dumping its `--no-index` usage
    // block) into the same clean 410 the missing-dir case already returns.
    if (!(await isGitWorkTree(task.worktreePath))) {
      throw new DomainError(
        'task-worktree-missing',
        existsSync(task.worktreePath)
          ? `worktree '${task.worktreePath}' is no longer a valid git repository (its source repo was moved or deleted); cannot compute diff`
          : `worktree '${task.worktreePath}' does not exist; cannot compute diff`,
        410,
      )
    }
    const { diff, truncated } = await worktreeDiff(task.worktreePath, task.baseCommit)
    return { diff, baseCommit: task.baseCommit, truncated }
  }

  // RFC-066: multi-repo concat. The parent worktree directory must exist
  // (it's the cwd for opencode children); at least one per-repo entry must
  // have a usable base_commit so we have something to diff against.
  // Per-repo missing-base / missing-worktree entries are skipped so we
  // never short the whole call for one bad shard.
  if (!existsSync(task.worktreePath)) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute diff`,
      410,
    )
  }
  const candidates = task.repos.filter(
    (r) => r.baseCommit !== null && r.baseCommit !== '' && existsSync(r.worktreePath),
  )
  // A worktree dir can survive after its source repo is gone, so `existsSync`
  // alone isn't enough — `gitDiffSnapshot` would 500 below. Drop those here so
  // one broken repo never shorts the whole task diff (same skip-bad-shard
  // policy as the missing-base / missing-worktree filters above).
  const valid = await Promise.all(candidates.map((r) => isGitWorkTree(r.worktreePath)))
  const usable = candidates.filter((_, i) => valid[i])
  if (usable.length === 0) {
    throw new DomainError(
      'task-no-base-commit',
      `task '${taskId}' has no repo with a recorded base commit; cannot compute diff`,
      409,
    )
  }
  let out = ''
  let truncated = false
  // RFC-239 — canonical labels over the FULL repo list (single source with the
  // structural diff's `label/` prefixes; before this, the fallback here was the
  // full repoPath while the structural side used basename, so the frontend
  // could never join the two sides for fallback-labeled repos).
  //
  // RFC-248 D15：规范 key 换成**挂载路径**（`canonicalRepoKeysWire`，根仓写 `.`）。
  // basename 在嵌套布局下彻底丢失方位——agent 拿到 `utils-2` 不知道该去哪个目录；
  // 挂载路径与它在磁盘上看到的一致。同一份 key 也用于结构化 diff 的 id 前缀与
  // 扇出分片，三处同源。
  const repoLabels = canonicalRepoKeysWire(task.repos)
  const labelOf = new Map(task.repos.map((r, i) => [r, repoLabels[i] ?? '.']))
  for (const repo of usable) {
    // RFC-248 D11: 只读成员不进任务 diff。
    if (repo.readonly === true) continue
    const oneRaw = await gitDiffSnapshot(repo.worktreePath, repo.baseCommit as string)
    if (oneRaw === '') continue
    const header = `# === Repo: ${labelOf.get(repo) ?? '.'} ===\n`
    const remaining = TASK_DIFF_MAX_BYTES - out.length
    if (remaining <= 0) {
      truncated = true
      break
    }
    if (header.length >= remaining) {
      // Even the header doesn't fit — emit what we can and stop.
      out += header.slice(0, remaining)
      truncated = true
      break
    }
    out += header
    const bodyBudget = TASK_DIFF_MAX_BYTES - out.length
    if (oneRaw.length > bodyBudget) {
      out += oneRaw.slice(0, bodyBudget)
      truncated = true
      break
    }
    out += oneRaw
    if (!out.endsWith('\n')) out += '\n'
  }
  return { diff: out, baseCommit: null, truncated }
}

function rowToTask(
  row: typeof tasks.$inferSelect,
  workflowName: string | null,
  repos: TaskRepo[],
  spaceNodes: PlannedDirectoryNode[],
  webhookSourceLink: WebhookTaskSourceLink | null,
): Task {
  let snapshot: unknown
  try {
    snapshot = JSON.parse(row.workflowSnapshot)
  } catch {
    snapshot = null
  }
  let inputs: Record<string, string> = {}
  try {
    inputs = JSON.parse(row.inputs) as Record<string, string>
  } catch {
    inputs = {}
  }
  return {
    id: row.id,
    name: row.name, // RFC-037
    workflowId: row.workflowId,
    workflowName,
    workflowSnapshot: snapshot,
    workflowVersion: row.workflowVersion ?? null, // RFC-109

    repoPath: row.repoPath,
    // RFC-247 (design gate): `tasks.repo_url` can embed credentials —
    // StartTaskSchema only rejects them in the QUERY STRING, so a
    // `https://user:token@host/repo.git` launch URL is accepted and stored.
    // Sibling paths in this file already redact (see `:1194`); these four
    // `rowToTask` sites did not, so every task read handed the credential back.
    // Redacted for ALL channels, not just tokens: this is an existing leak
    // being closed, not a new token-only gate.
    repoUrl: row.repoUrl !== null && row.repoUrl !== undefined ? redactGitUrl(row.repoUrl) : null,
    cachedRepoId: row.cachedRepoId ?? null,
    worktreePath: row.worktreePath,
    workspaceState:
      row.workspacePrunedAt !== null
        ? 'pruned'
        : row.workspacePruningAt !== null
          ? 'pruning'
          : 'available',
    baseBranch: row.baseBranch,
    branch: row.branch,
    baseCommit: row.baseCommit,
    status: row.status,
    inputs,
    maxDurationMs: row.maxDurationMs,
    maxTotalTokens: row.maxTotalTokens,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorSummary: row.errorSummary,
    errorMessage: row.errorMessage,
    failedNodeId: row.failedNodeId,
    expiresAt: row.expiresAt,
    deletedAt: row.deletedAt,
    schemaVersion: row.schemaVersion,
    // RFC-067: per-task Git commit identity (NULL = no override → daemon default).
    gitUserName: row.gitUserName ?? null,
    gitUserEmail: row.gitUserEmail ?? null,
    // RFC-075: working branch (NULL → isolation branch) + auto commit&push.
    workingBranch: row.workingBranch ?? null,
    autoCommitPush: row.autoCommitPush,
    // RFC-066: per-task repo metadata. `repoCount` is sourced from the
    // denormalized column on `tasks` (cheap for list queries); `repos[]` is
    // hydrated by the caller from `task_repos` ordered by `repo_index`.
    repoCount: row.repoCount,
    // RFC-248: 组溯源。名字是快照——组删掉后详情页仍渲染名字（设计门 G5）。
    repoGroupId: row.repoGroupId ?? null,
    repoGroupName: row.repoGroupName ?? null,
    // RFC-159: link back to the scheduled_tasks row that launched this (NULL = manual).
    scheduledTaskId: row.scheduledTaskId ?? null,
    workgroupId: row.workgroupId ?? null,
    // RFC-164/RFC-223: frozen group name from the task's own config (same
    // source as rowToSummary) is display-only; the detail page links by the
    // frozen workgroupId instead of leaking the `__workgroup_host__` anchor.
    // NULL for non-groups.
    workgroupName: frozenWorkgroupName(row.workgroupConfigJson),
    // RFC-175 (§2): frozen goal from the task's own config (same task-scoped,
    // RFC-099-safe source as workgroupName). NULL for non-groups. Powers relaunch.
    goal: frozenWorkgroupGoal(row.workgroupConfigJson),
    // RFC-165: execution-space kind + single-agent soft link.
    spaceKind: row.spaceKind,
    // RFC-243: parent linkage for node-invoked child executions.
    parentTaskId: row.parentTaskId ?? null,
    parentNodeRunId: row.parentNodeRunId ?? null,
    invocationDepth: row.invocationDepth ?? 0,
    sourceAgentName: row.sourceAgentName ?? null,
    // RFC-175 (§2e): stable agent id (NULL for non-agent + pre-0091 tasks).
    sourceAgentId: row.sourceAgentId ?? null,
    // RFC-298: getTask derives this from the frozen context before entering
    // the generic row mapper. Never expose or parse the frozen source JSON here.
    webhookSourceLink,
    repos,
    spaceNodes,
  }
}

/**
 * RFC-164 follow-up: the owning group's display name for the /tasks list, read
 * from the task's OWN frozen `workgroup_config_json` — the SAME task-scoped
 * source the room serves (routes/workgroupTasks.ts `loadVisibleWorkgroupTask`),
 * NOT a live join on the `workgroups` resource. This keeps the name inside the
 * task's membership ACL (RFC-099): a task member already sees it in the room,
 * and we never surface live resource state (e.g. a post-launch rename) to a
 * collaborator without workgroup visibility. NULL for non-workgroup tasks and
 * for a corrupt/absent config (the list cell degrades to badge-only). The
 * label remains the launch-time name after a rename, while the destination is
 * the immutable `workgroup_id`; authorization still decides whether it opens.
 */
function frozenWorkgroupName(configJson: string | null): string | null {
  if (configJson === null || configJson === '') return null
  try {
    const parsed: unknown = JSON.parse(configJson)
    if (parsed !== null && typeof parsed === 'object' && 'workgroupName' in parsed) {
      const n = (parsed as { workgroupName?: unknown }).workgroupName
      return typeof n === 'string' && n.length > 0 ? n : null
    }
  } catch {
    // Corrupt frozen config must never 5xx the whole list; degrade to null.
  }
  return null
}

/**
 * RFC-175 (§2): the workgroup task's frozen `goal`, read from the task's OWN
 * `workgroup_config_json` — the SAME task-scoped, RFC-099-safe source as
 * `frozenWorkgroupName` (never a live join). NULL for non-workgroup tasks and
 * corrupt/absent config. Powers relaunch pre-filling the workgroup prompt.
 */
function frozenWorkgroupGoal(configJson: string | null): string | null {
  if (configJson === null || configJson === '') return null
  try {
    const parsed: unknown = JSON.parse(configJson)
    if (parsed !== null && typeof parsed === 'object' && 'goal' in parsed) {
      const g = (parsed as { goal?: unknown }).goal
      return typeof g === 'string' && g.length > 0 ? g : null
    }
  } catch {
    // Corrupt frozen config must never 5xx; degrade to null.
  }
  return null
}

function rowToSummary(row: typeof tasks.$inferSelect, workflowName: string | null): TaskSummary {
  return {
    id: row.id,
    name: row.name, // RFC-037
    workflowId: row.workflowId,
    workflowName,
    repoPath: row.repoPath,
    // RFC-247 (design gate): `tasks.repo_url` can embed credentials —
    // StartTaskSchema only rejects them in the QUERY STRING, so a
    // `https://user:token@host/repo.git` launch URL is accepted and stored.
    // Sibling paths in this file already redact (see `:1194`); these four
    // `rowToTask` sites did not, so every task read handed the credential back.
    // Redacted for ALL channels, not just tokens: this is an existing leak
    // being closed, not a new token-only gate.
    repoUrl: row.repoUrl !== null && row.repoUrl !== undefined ? redactGitUrl(row.repoUrl) : null,
    cachedRepoId: row.cachedRepoId ?? null,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorSummary: row.errorSummary,
    // RFC-066: source-of-truth `tasks.repo_count`. Migration 0034 defaulted
    // every existing row to 1; multi-repo launches set it explicitly.
    repoCount: row.repoCount,
    // RFC-248: 组名不进 summary DTO——列表页已有「N 仓」chip，再加一列组名会
    // 把行挤爆；组溯源在详情页展示（`rowToTask` 带）。
    // RFC-159: link back to the scheduled_tasks row that launched this (NULL = manual).
    scheduledTaskId: row.scheduledTaskId ?? null,
    workgroupId: row.workgroupId ?? null,
    workgroupName: frozenWorkgroupName(row.workgroupConfigJson),
    // RFC-165: execution-space kind + single-agent soft link.
    spaceKind: row.spaceKind,
    // RFC-243: parent linkage so the list can nest/badge child executions.
    parentTaskId: row.parentTaskId ?? null,
    invocationDepth: row.invocationDepth ?? 0,
    sourceAgentName: row.sourceAgentName ?? null,
    // RFC-177: frozen stable agent id so the list subject link resolves by id
    // (rename/reuse-safe); NULL for non-agent / pre-RFC-175 rows (by-name fallback).
    sourceAgentId: row.sourceAgentId ?? null,
  }
}

/**
 * RFC-066: project a `task_repos` row into the wire `TaskRepo` shape. Boolean
 * columns are stored as 0/1 integers in SQLite; drizzle's `mode: 'boolean'`
 * surfaces them as JS booleans, but we coerce nullable booleans defensively.
 */
function mapTaskRepoRow(row: typeof taskRepos.$inferSelect): TaskRepo {
  return {
    repoIndex: row.repoIndex,
    repoPath: row.repoPath,
    // RFC-247 (design gate): `tasks.repo_url` can embed credentials —
    // StartTaskSchema only rejects them in the QUERY STRING, so a
    // `https://user:token@host/repo.git` launch URL is accepted and stored.
    // Sibling paths in this file already redact (see `:1194`); these four
    // `rowToTask` sites did not, so every task read handed the credential back.
    // Redacted for ALL channels, not just tokens: this is an existing leak
    // being closed, not a new token-only gate.
    repoUrl: row.repoUrl !== null && row.repoUrl !== undefined ? redactGitUrl(row.repoUrl) : null,
    cachedRepoId: row.cachedRepoId ?? null,
    baseBranch: row.baseBranch,
    branch: row.branch,
    // RFC-075: per-repo working-branch mirror (NULL → isolation branch).
    workingBranch: row.workingBranch ?? null,
    baseCommit: row.baseCommit ?? null,
    worktreePath: row.worktreePath,
    worktreeDirName: row.worktreeDirName,
    // RFC-248: 读 DB 真值。写死 '' 会让**每一个**多仓任务的 diff 分段头退化成
    // `.`、结构化 diff 前缀丢失、`?repo=` 查不到——由 task-diff-multi-repo 的
    // 既有断言抓出来。
    mountPath: row.mountPath,
    subdir: row.subdir,
    readonly: row.readonly,
    // RFC-248 AC-19: 只读成员被丢弃的改动处数（null = 从未检查）。
    readonlyDirtyCount: row.readonlyDirtyCount ?? null,
    gitignoreCommit: row.gitignoreCommit ?? null,
    hasSubmodules: row.hasSubmodules ?? null,
    submoduleInitOk: row.submoduleInitOk ?? null,
    submoduleInitError: row.submoduleInitError ?? null,
  }
}

/**
 * RFC-066: defensive fallback when `getTask` finds zero `task_repos` rows
 * (only reachable for ultra-rare mid-migration crashes — every existing
 * task got a row backfilled by migration 0034 INSERT FROM ... SELECT).
 * Synthesizes a single entry from the legacy `tasks.*` mirror columns so
 * downstream consumers always see at least one repo.
 */
function synthesizeRepoFromTaskRow(row: typeof tasks.$inferSelect): TaskRepo {
  return {
    repoIndex: 0,
    repoPath: row.repoPath,
    // RFC-247 (design gate): `tasks.repo_url` can embed credentials —
    // StartTaskSchema only rejects them in the QUERY STRING, so a
    // `https://user:token@host/repo.git` launch URL is accepted and stored.
    // Sibling paths in this file already redact (see `:1194`); these four
    // `rowToTask` sites did not, so every task read handed the credential back.
    // Redacted for ALL channels, not just tokens: this is an existing leak
    // being closed, not a new token-only gate.
    repoUrl: row.repoUrl !== null && row.repoUrl !== undefined ? redactGitUrl(row.repoUrl) : null,
    cachedRepoId: row.cachedRepoId ?? null,
    baseBranch: row.baseBranch,
    branch: row.branch,
    // RFC-075: mirror the task-level working branch onto the synthesized repo.
    workingBranch: row.workingBranch ?? null,
    baseCommit: row.baseCommit ?? null,
    worktreePath: row.worktreePath,
    worktreeDirName: '',
    mountPath: '',
    subdir: '',
    readonly: false,
    readonlyDirtyCount: null,
    gitignoreCommit: null,
    hasSubmodules: null,
    submoduleInitOk: null,
    submoduleInitError: null,
  }
}
