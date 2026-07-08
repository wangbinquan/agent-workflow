// Task service — start / list / get.
// Cancel/resume/retry land in P-1-15 + M3 (P-3-08, P-3-09).

import type {
  NodeKind,
  NodeRun,
  NodeRunEvent,
  NodeRunEventsResponse,
  NodeRunOutput,
  StartTask,
  StartTaskRepo,
  Task,
  TaskDiff,
  TaskNodeRuns,
  TaskRepo,
  TaskSummary,
} from '@agent-workflow/shared'
import {
  CommitPushMetaSchema,
  NODE_KIND_BEHAVIORS,
  WorkflowDefinitionSchema,
  allowedFromForTaskEvent,
  diffWorkflowForSync,
  emptyWorkflowSyncDiff,
  isTerminalNodeRunStatus,
} from '@agent-workflow/shared'
import type {
  CommitPushMeta,
  NodeRunStatus,
  NodeRunSyncSummary,
  TaskTransitionEvent,
  Workflow,
  WorkflowDefinition,
  WorkflowSyncPreview,
} from '@agent-workflow/shared'
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, or } from 'drizzle-orm'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import {
  docVersions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  taskCollaborators,
  taskRepos,
  tasks,
  workflows,
} from '@/db/schema'
import { getWorkflow } from '@/services/workflow'
import { listAgents } from '@/services/agent'
import { listSkills } from '@/services/skill'
import { validateWorkflowDef } from '@/services/workflow.validator'
import { upsertRecentRepo } from '@/services/repo'
import { rollbackNodeRunWorktrees } from '@/services/nodeRollback'
import { WRAPPER_KINDS } from '@/services/dispatchFrontier'
import type { RollbackOutcome } from '@/services/nodeRollback'
import { killStaleRunProcessTree } from '@/util/process'
import { recordRecoveryEvent } from '@/services/recovery'
import { setTaskStatus, transitionTaskStatusByEvent, trySetTaskStatus } from '@/services/lifecycle'
import type { TaskStatusUpdateExtra } from '@/services/lifecycle'
import { mintNodeRun } from '@/services/nodeRunMint'
import { pickFreshestRun } from '@/services/freshness'
import { listAvailableRefs, resolveCachedRepo } from '@/services/gitRepoCache'
import { createWorktree, gitDiffSnapshot, isGitWorkTree, worktreeDiff } from '@/util/git'
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
import { createLogger } from '@/util/log'
import { parseInjectedSnapshotJson } from './memoryInject'
import { parsePortValidationFailuresJson } from './envelope'
import {
  compareNodeRunsForTimeline,
  deriveReviewRoundTiming,
  type ReviewVersionFacts,
} from './reviewRoundStart'
import type { DocVersionDecision } from '@agent-workflow/shared'

const log = createLogger('task')

/**
 * Process-local registry of in-flight task AbortControllers. Used by
 * cancelTask to interrupt the running scheduler/runner pipeline.
 *
 * Survives only within this daemon process. On daemon restart, in-flight
 * tasks are reconciled by the startup orphan scan (P-4-07) — out of scope
 * for M1.
 */
const activeTasks = new Map<string, AbortController>()

/** RFC-097 (audit S-8/S-23): is an in-process scheduler loop attached to this
 *  task right now? Used by resume/retry entry rejection and lifecycleRepair's
 *  scheduler-liveness preflight. */
export function isTaskActive(taskId: string): boolean {
  return activeTasks.has(taskId)
}

/**
 * P-4-06: abort every in-flight task. Used by daemon shutdown. The runner
 * SIGTERMs each opencode child via the controller's signal; the scheduler
 * then marks rows canceled/interrupted in the normal flow.
 */
export function abortAllActiveTasks(): string[] {
  const ids = [...activeTasks.keys()]
  for (const id of ids) activeTasks.get(id)?.abort()
  return ids
}

export interface StartTaskDeps {
  db: DbClient
  /** Override app home (tests). Defaults to `Paths.root`. */
  appHome?: string
  /** Default per-node timeout (ms). Defaults from settings; tests can pin. */
  defaultPerNodeTimeoutMs?: number
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
  /** Override opencode command (tests inject mock-opencode). */
  opencodeCmd?: string[]
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
   * RFC-036 — launcher user id. NULL falls back to the legacy single-user
   * behavior (ownerUserId stays NULL; no collab/assignment rows written).
   * The route passes actor.user.id when the actor is a real user; daemon-
   * token callers can leave it unset or pass '__system__' explicitly.
   */
  actorUserId?: string
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
}): Promise<{
  worktreePath: string
  branch: string
  baseCommit: string | null
  earlyError: string | null
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
      ...(opts.gitUserName != null ? { gitUserName: opts.gitUserName } : {}),
      ...(opts.gitUserEmail != null ? { gitUserEmail: opts.gitUserEmail } : {}),
    })
    return {
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
      earlyError: null,
      submoduleInitOk: wt.submoduleInitOk,
      submoduleInitError: wt.submoduleInitError,
      hasSubmodules: wt.hasSubmodules,
    }
  } catch (err) {
    // RFC-075: a user-requested working branch that can't be honored (invalid
    // name, in use, base fetch failed, merge conflict) is a hard launch
    // failure surfaced as 422 — let the typed error propagate instead of
    // degrading into a `failed` task row.
    if (err instanceof ValidationError && err.code.startsWith('working-branch-')) {
      throw err
    }
    return {
      worktreePath: '',
      branch: '',
      baseCommit: null,
      earlyError: err instanceof Error ? err.message : String(err),
      submoduleInitOk: true,
      submoduleInitError: null,
      hasSubmodules: false,
    }
  }
}

export interface ResolvedRepoSource {
  repoPath: string
  baseBranch: string | undefined
  repoUrl: string | null
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
export function normalizeStartTaskRepos(input: StartTask): StartTaskRepo[] {
  if (Array.isArray(input.repos) && input.repos.length > 0) {
    return input.repos
  }
  // Legacy single-repo body → length-1 array. Drop undefined fields so the
  // StartTaskRepoSchema's superRefine sees the same shape it would for v2.
  const entry: StartTaskRepo = {
    ...(input.repoPath !== undefined ? { repoPath: input.repoPath } : {}),
    ...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {}),
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
  }
  return [entry]
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
  spec: StartTaskRepo,
  input: StartTask,
  deps: StartTaskDeps,
): Promise<ResolvedRepoSource> {
  if (spec.repoPath) {
    let pathFetchError: string | null = null
    if (input.fetchBeforeLaunch === true) {
      const { fetchPathRepoBeforeLaunch } = await import('@/services/repo')
      const r = await fetchPathRepoBeforeLaunch(spec.repoPath)
      if (!r.ok) pathFetchError = r.error
    }
    return {
      repoPath: spec.repoPath,
      baseBranch: spec.baseBranch,
      repoUrl: null,
      pathFetchError,
      ffWarnings: [],
    }
  }
  if (!spec.repoUrl) {
    throw new ValidationError(
      'start-task-source-required',
      'one of repoPath or repoUrl is required',
    )
  }
  const appHome = deps.appHome ?? Paths.root
  const syncCandidates = [spec.ref].filter((s): s is string => typeof s === 'string')
  const resolved = await resolveCachedRepo(
    { db: deps.db, appHome, syncBranches: syncCandidates },
    { url: spec.repoUrl },
  )
  const baseBranch = spec.ref ?? resolved.cached.defaultBranch ?? undefined
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
      },
      { url: spec.repoUrl },
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
    repoUrl: spec.repoUrl,
    pathFetchError: null,
    ffWarnings,
  }
}

interface MaterializedRepo {
  repoIndex: number
  repoPath: string
  repoUrl: string | null
  baseBranch: string
  branch: string
  baseCommit: string | null
  worktreePath: string
  worktreeDirName: string
  submoduleInitOk: boolean
  submoduleInitError: string | null
  hasSubmodules: boolean
}

/**
 * RFC-066: compute the per-repo sub-directory basename for a multi-repo
 * task, applying `-2`/`-3` collision suffixes when the raw basename is
 * already in use. Mirrors the frontend `computePreviewDirNames` behavior
 * so the launcher's preview chip matches what the daemon actually mounts.
 */
function resolveMultiRepoDirName(rawBasename: string, used: Set<string>): string {
  if (!used.has(rawBasename)) return rawBasename
  let suffix = 2
  while (used.has(`${rawBasename}-${suffix}`)) suffix += 1
  return `${rawBasename}-${suffix}`
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
  R extends { id: string; nodeId: string; parentNodeRunId: string | null; status: string },
>(runs: readonly R[]): R[] {
  const latestPerNode = new Map<string, R>()
  for (const r of runs) {
    if (r.parentNodeRunId !== null) continue
    const prev = latestPerNode.get(r.nodeId)
    if (prev === undefined || r.id > prev.id) latestPerNode.set(r.nodeId, r)
  }
  return [...latestPerNode.values()].filter(
    (r) => r.status === 'failed' || r.status === 'interrupted',
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
    | 'defaultPerNodeTimeoutMs'
    | 'defaultNodeRetries'
    | 'defaultRuntime'
  >,
): Partial<RunTaskOptions> {
  return {
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
    ...(deps.maxConcurrentNodes !== undefined
      ? { maxConcurrentNodes: deps.maxConcurrentNodes }
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

export async function startTask(input: StartTask, deps: StartTaskDeps): Promise<Task> {
  // Resolve workflow.
  const workflow = await getWorkflow(deps.db, input.workflowId)
  if (workflow === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${input.workflowId}' not found`)
  }

  // RFC-066: collapse legacy and v2 bodies into a uniform per-repo spec list.
  const repoSpecs = normalizeStartTaskRepos(input)

  // RFC-066: multi-repo gates. Reject up-front BEFORE the static workflow
  // validation step (which may itself reject the workflow for unrelated
  // reasons) so the failure code unambiguously points at the multi-repo
  // mismatch. The workflow snapshot is the source of truth; workflow edits
  // after this point cannot retroactively introduce a wrapper-git / upload
  // node into an already-started task. Single-repo launches keep their
  // existing behavior (workflows containing wrapper-git / upload are still
  // launchable as today, gated by the static validation rules only).
  if (repoSpecs.length > 1) {
    const wrapperGitNodes = (
      (workflow.definition.nodes as Array<{ id: string; kind: string }>) ?? []
    )
      .filter((n) => n.kind === 'wrapper-git')
      .map((n) => n.id)
    if (wrapperGitNodes.length > 0) {
      throw new ValidationError(
        'multi-repo-wrapper-git-unsupported',
        'wrapper-git nodes are not supported in multi-repo tasks (v1)',
        { wrapperGitNodes },
      )
    }
    const uploadInputs = (
      (workflow.definition.inputs as Array<{ key: string; kind: string }>) ?? []
    )
      .filter((i) => i.kind === 'upload')
      .map((i) => i.key)
    if (uploadInputs.length > 0) {
      throw new ValidationError(
        'multi-repo-upload-unsupported',
        'multipart upload inputs are not supported in multi-repo tasks (v1)',
        { uploadInputs },
      )
    }
  }

  // Static validation gate (proposal.md §静态校验): "校验失败不阻止保存，但阻止启动 task".
  // Run the same 5-rule check the editor uses, against the live agent/skill set,
  // and refuse to launch if it surfaces any error-severity issues. Warnings pass.
  const validation = validateWorkflowDef(workflow.definition, {
    agents: await listAgents(deps.db),
    skills: await listSkills(deps.db),
  })
  if (!validation.ok) {
    const errors = validation.issues.filter((i) => (i.severity ?? 'error') === 'error')
    throw new ValidationError(
      'workflow-invalid',
      `workflow '${input.workflowId}' failed static validation (${errors.length} error${errors.length === 1 ? '' : 's'}); fix issues before starting a task`,
      { issues: validation.issues },
    )
  }

  const appHome = deps.appHome ?? Paths.root

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
        repoUrl: r.repoUrl,
        warnings: r.ffWarnings,
      })
    }
    resolvedSources.push(r)
  }

  // RFC-020: multipart-upload flow creates the worktree before this call so
  // it can write user files into it. JSON-body flow takes the original path:
  // mint a fresh id, call materializeWorktree here.
  let taskId: string
  let worktreePath: string
  let branch: string
  let baseCommit: string | null
  let earlyError: string | null
  let materializedRepos: MaterializedRepo[]
  if (deps.preCreatedWorktree !== undefined) {
    // Multipart-upload flow is single-repo only. RFC-066 routes/tasks.ts
    // wires a multi-repo + upload combo to 422 via T6's gate well before
    // this code path runs; the assertion is belt-and-suspenders.
    if (repoSpecs.length !== 1) {
      throw new ValidationError(
        'multi-repo-upload-unsupported',
        'preCreatedWorktree path can only be used with single-repo bodies',
      )
    }
    taskId = deps.preCreatedWorktree.taskId
    worktreePath = deps.preCreatedWorktree.worktreePath
    branch = deps.preCreatedWorktree.branch
    baseCommit = deps.preCreatedWorktree.baseCommit
    earlyError = null
    const onlySource = resolvedSources[0]!
    materializedRepos = [
      {
        repoIndex: 0,
        repoPath: onlySource.repoPath,
        repoUrl: onlySource.repoUrl,
        baseBranch: onlySource.baseBranch ?? '',
        branch,
        baseCommit,
        worktreePath,
        worktreeDirName: '',
        submoduleInitOk: true,
        submoduleInitError: null,
        hasSubmodules: false,
      },
    ]
  } else if (repoSpecs.length === 1) {
    // RFC-066: single-path byte-baseline branch — pre-RFC-066 behavior
    // preserved bit-for-bit. The G1 grep guard in
    // tests/source/start-task-single-path-baseline.test.ts pins this
    // comment so a future multi-path refactor cannot silently delete the
    // single-repo path.
    taskId = ulid()
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
    })
    worktreePath = wt.worktreePath
    branch = wt.branch
    baseCommit = wt.baseCommit
    earlyError = wt.earlyError

    if (earlyError === null && !wt.submoduleInitOk) {
      const { createLogger } = await import('@/util/log')
      const log = createLogger('task')
      log.warn('[rfc034/submodule-init-failed] worktree submodule init failed', {
        taskId,
        worktreePath,
        stderr: wt.submoduleInitError ?? '',
      })
    }

    if (
      earlyError !== null &&
      source.repoUrl !== null &&
      /worktree-base-invalid|cannot resolve base ref/i.test(earlyError)
    ) {
      const available = await listAvailableRefs(source.repoPath, 10)
      throw new ValidationError(
        'repo-ref-not-found',
        `ref '${input.ref ?? source.baseBranch ?? '(default)'}' not found in ${redactGitUrl(source.repoUrl)}`,
        { url: redactGitUrl(source.repoUrl), ref: input.ref ?? null, availableRefs: available },
      )
    }
    materializedRepos = [
      {
        repoIndex: 0,
        repoPath: source.repoPath,
        repoUrl: source.repoUrl,
        baseBranch: source.baseBranch ?? '',
        branch: branch !== '' ? branch : `agent-workflow/${taskId}`,
        baseCommit,
        worktreePath,
        worktreeDirName: '',
        submoduleInitOk: wt.submoduleInitOk,
        submoduleInitError: wt.submoduleInitError,
        hasSubmodules: wt.hasSubmodules,
      },
    ]
  } else {
    // RFC-066: multi-repo materialize branch. cwd is the parent dir; each
    // source repo becomes a per-basename sibling worktree under it. The
    // legacy `tasks.*` repo/worktree/branch columns mirror repos[0] for
    // back-compat with API consumers that haven't adopted `repos[]` yet.
    taskId = ulid()
    const parentWorktree = join(appHome, 'worktrees', 'multi', taskId)
    mkdirSync(parentWorktree, { recursive: true })
    worktreePath = parentWorktree
    earlyError = null
    materializedRepos = []
    const usedDirNames = new Set<string>()
    for (let i = 0; i < resolvedSources.length; i++) {
      const source = resolvedSources[i]!
      const rawName = basename(source.repoPath)
      const dirName = resolveMultiRepoDirName(rawName, usedDirNames)
      usedDirNames.add(dirName)
      const wt = await materializeWorktree({
        repoPath: source.repoPath,
        baseBranch: source.baseBranch,
        taskId,
        appHome,
        overrideWorktreePath: join(parentWorktree, dirName),
        // RFC-075: same working branch name applied to every repo in the task.
        ...(input.workingBranch !== undefined ? { workingBranch: input.workingBranch } : {}),
        gitUserName: input.gitUserName ?? null,
        gitUserEmail: input.gitUserEmail ?? null,
      })
      if (wt.earlyError !== null) {
        earlyError = `repo[${i}] (${dirName}) failed: ${wt.earlyError}`
        // URL mode: rewrap missing-ref into the legacy `repo-ref-not-found`
        // error shape so the launcher's existing helpful-list UI continues
        // to work for the first failing repo.
        if (
          source.repoUrl !== null &&
          /worktree-base-invalid|cannot resolve base ref/i.test(wt.earlyError)
        ) {
          const available = await listAvailableRefs(source.repoPath, 10)
          throw new ValidationError(
            'repo-ref-not-found',
            `ref '${repoSpecs[i]!.ref ?? source.baseBranch ?? '(default)'}' not found in ${redactGitUrl(source.repoUrl)}`,
            {
              url: redactGitUrl(source.repoUrl),
              ref: repoSpecs[i]!.ref ?? null,
              availableRefs: available,
              repoIndex: i,
            },
          )
        }
        break
      }
      if (!wt.submoduleInitOk) {
        const { createLogger } = await import('@/util/log')
        const log = createLogger('task')
        log.warn('[rfc034/submodule-init-failed] worktree submodule init failed', {
          taskId,
          worktreePath: wt.worktreePath,
          repoIndex: i,
          stderr: wt.submoduleInitError ?? '',
        })
      }
      materializedRepos.push({
        repoIndex: i,
        repoPath: source.repoPath,
        repoUrl: source.repoUrl,
        baseBranch: source.baseBranch ?? '',
        branch: wt.branch,
        baseCommit: wt.baseCommit,
        worktreePath: wt.worktreePath,
        worktreeDirName: dirName,
        submoduleInitOk: wt.submoduleInitOk,
        submoduleInitError: wt.submoduleInitError,
        hasSubmodules: wt.hasSubmodules,
      })
    }
    // Mirror repos[0] into the legacy `tasks.*` columns for API back-compat.
    if (materializedRepos.length > 0) {
      const head = materializedRepos[0]!
      branch = head.branch
      baseCommit = head.baseCommit
    } else {
      branch = ''
      baseCommit = null
    }
  }

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
  const headBaseBranch = head?.baseBranch ?? fallbackSource?.baseBranch ?? ''
  const headBranch = head?.branch ?? (branch !== '' ? branch : `agent-workflow/${taskId}`)
  const headBaseCommit = head?.baseCommit ?? baseCommit

  const now = Date.now()
  await deps.db.insert(tasks).values({
    id: taskId,
    // RFC-037: required name (StartTaskSchema already trimmed + length-validated).
    name: input.name,
    workflowId: workflow.id,
    workflowSnapshot: JSON.stringify(workflow.definition),
    workflowVersion: workflow.version, // RFC-109: record the version this snapshot froze
    repoPath: headRepoPath,
    // RFC-054 W3-4 KNOWN_GAP fix: never persist the credentialed URL.
    // gitRepoCache has already used the cleartext form to clone (line
    // 197 above); from this point onward the daemon only needs the
    // redacted form (for display, WS broadcast, error messages). The
    // cleartext URL is reachable only ephemerally via the cache key
    // hash, so even DB-level access can't reconstruct it.
    repoUrl: headRepoUrl !== null ? redactGitUrl(headRepoUrl) : null,
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
  })

  // RFC-066: persist per-repo metadata. Single-repo tasks land one row at
  // repo_index=0 mirroring the legacy columns above; multi-repo tasks land
  // N rows sorted by repo_index. The list view's `repoCount` chip is driven
  // by `tasks.repo_count`; the detail page's `Task.repos[]` array is hydrated
  // from this table by `getTask`.
  if (materializedRepos.length > 0) {
    await deps.db.insert(taskRepos).values(
      materializedRepos.map((r) => ({
        taskId,
        repoIndex: r.repoIndex,
        repoPath: r.repoPath,
        repoUrl: r.repoUrl !== null ? redactGitUrl(r.repoUrl) : null,
        baseBranch: r.baseBranch,
        branch: r.branch,
        // RFC-075: the single working-branch name is applied to every repo
        // (NULL → this repo uses the isolation branch in `branch`).
        workingBranch: input.workingBranch ?? null,
        baseCommit: r.baseCommit,
        worktreePath: r.worktreePath,
        worktreeDirName: r.worktreeDirName,
        hasSubmodules: r.hasSubmodules,
        submoduleInitOk: r.submoduleInitOk,
        submoduleInitError: r.submoduleInitError,
        schemaVersion: 1,
      })),
    )
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

  // RFC-036/RFC-099: record owner + collaborators (assignments removed, D6).
  if (deps.actorUserId) {
    const { recordLaunchContext } = await import('@/services/taskCollab')
    try {
      await recordLaunchContext(deps.db, {
        taskId,
        ownerUserId: deps.actorUserId,
        collaboratorUserIds: input.collaboratorUserIds ?? [],
        now,
      })
    } catch (err) {
      // Roll back the task row so the caller sees a clean 422 with no
      // half-created row in /api/tasks.
      await deps.db.delete(tasks).where(eq(tasks.id, taskId))
      throw err
    }
  }

  // Mirror every path-mode repo into recent-repos — best-effort, never blocks.
  // RFC-024: only path-mode entries belong in `recent_repos` (URL-mode tasks
  // are tracked via `cached_repos` instead). RFC-066: in multi-repo tasks
  // this runs N times so each user-picked path shows up in the next launch's
  // dropdown.
  for (const r of materializedRepos) {
    if (r.repoUrl === null) {
      upsertRecentRepo(deps.db, r.repoPath).catch((err) => {
        log.warn('upsertRecentRepo failed', { error: (err as Error).message })
      })
    }
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
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      errorSummary: task.errorSummary,
      // RFC-066: source of truth is the freshly-loaded Task (which read
      // `tasks.repo_count` directly). Single-repo = 1; multi-repo = N.
      repoCount: task.repoCount,
    },
  })

  if (earlyError !== null) {
    return task
  }

  // Kick the scheduler. HTTP route returns immediately; tests can await.
  const controller = new AbortController()
  activeTasks.set(taskId, controller)
  const schedulerPromise = runTask({
    taskId,
    db: deps.db,
    appHome,
    ...(deps.opencodeCmd ? { opencodeCmd: deps.opencodeCmd } : {}),
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
      // RFC-097: identity-compare before delete.
      if (activeTasks.get(taskId) === controller) activeTasks.delete(taskId)
    })

  if (deps.awaitScheduler === true) {
    await schedulerPromise
    return (await getTask(deps.db, taskId)) as Task
  }
  return task
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
): Promise<never> {
  await setTaskStatus({
    db,
    taskId,
    to: 'failed',
    allowedFrom: ['pending'],
    extra: {
      finishedAt: Date.now(),
      errorSummary: 'live-child-survived',
      errorMessage: `node_run ${run.id} (node ${run.nodeId}) opencode child pid ${run.pid ?? '?'} is still alive and survived SIGTERM→SIGKILL; refusing to reset the worktree under a live writer`,
      failedNodeId: run.nodeId,
    },
    reason: `${reason}:live-child-survived`,
  })
  await recordRecoveryEvent(db, {
    taskId,
    nodeRunId: run.id,
    kind: 'live-child-survived',
    reason: `pid ${run.pid ?? '?'} survived SIGKILL`,
    before: { status: 'pending' },
    after: { status: 'failed' },
  })
  const failed = await getTask(db, taskId)
  if (failed !== null) emitTaskStatus(failed)
  throw new ConflictError(
    'live-child-survived',
    `cannot ${reason === 'resumeTask' ? 'resume' : 'retry'}: node_run ${run.id} child pid ${run.pid ?? '?'} is still alive and unkillable; the worktree cannot be safely reset under it`,
  )
}

export async function cancelTask(db: DbClient, id: string): Promise<Task> {
  const task = await getTask(db, id)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${id}' not found`)
  }
  if (task.status !== 'pending' && task.status !== 'running') {
    throw new ConflictError(
      'task-not-cancelable',
      `task '${id}' is already ${task.status}; nothing to cancel`,
    )
  }

  const controller = activeTasks.get(id)
  if (controller !== undefined) {
    controller.abort()
    // Wait for the scheduler to record the canceled state (best-effort 5s
    // poll). If the daemon was restarted, no controller exists; we just mark
    // the row canceled directly.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const reread = await getTask(db, id)
      if (reread !== null && reread.status !== 'pending' && reread.status !== 'running') {
        return reread
      }
      await Bun.sleep(50)
    }
  }

  // Fallback: scheduler didn't notice or no controller — flip the row.
  // RFC-097: CAS from {pending, running}; a loss means the scheduler (or a
  // racing failTask) landed a terminal status first — return the winner
  // instead of overwriting it.
  await trySetTaskStatus({
    db,
    taskId: id,
    to: 'canceled',
    allowedFrom: ['pending', 'running'],
    extra: {
      finishedAt: Date.now(),
      errorSummary: 'canceled by user',
      errorMessage: 'no active scheduler at cancel time',
    },
    reason: 'cancelTask-fallback',
  })
  const final = (await getTask(db, id)) as Task
  emitTaskStatus(final)
  return final
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
      reason: opts.reason,
    })
  } catch (err) {
    if (err instanceof ConflictError) {
      throw new ConflictError(
        opts.conflictCode,
        `task '${id}' changed state concurrently; only [${allowedFrom.join('/')}] tasks can ${opts.verb}`,
      )
    }
    throw err
  }

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
    const killOutcome = await killStaleRunProcessTree(r)
    if (killOutcome === 'killed') {
      log.warn(`${opts.verb}: stale opencode child group-killed before rollback`, {
        nodeRunId: r.id,
        pid: r.pid,
      })
    } else if (killOutcome === 'kill-failed') {
      await escalateLiveChildSurvived(db, id, r, opts.reason) // throws 409
    }
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
  if (activeTasks.has(id)) {
    // Should be unreachable (entry check + ownership CAS) — defensive only.
    log.error(`${opts.reason}: controller already registered for task`, { taskId: id })
  }
  activeTasks.set(id, controller)
  const schedulerPromise = runTask({
    taskId: id,
    db,
    appHome: deps.appHome ?? Paths.root,
    ...(deps.opencodeCmd ? { opencodeCmd: deps.opencodeCmd } : {}),
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
      // RFC-097: identity-compare before delete — never evict a successor's
      // controller.
      if (activeTasks.get(id) === controller) activeTasks.delete(id)
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
  return WorkflowDefinitionSchema.parse(snapshot)
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
  // Same static validation gate as launch — never sync an invalid definition in.
  const validation = validateWorkflowDef(workflow.definition, {
    agents: await listAgents(db),
    skills: await listSkills(db),
  })
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
  const validation = validateWorkflowDef(newDef, {
    agents: await listAgents(db),
    skills: await listSkills(db),
  })
  const invalidIssues = validation.ok
    ? []
    : validation.issues
        .filter((i) => (i.severity ?? 'error') === 'error')
        .map((i) => ({ code: i.code, message: i.message }))

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
    invalid: !validation.ok,
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
      throw new ConflictError(
        'task-still-running',
        `task '${taskId}' changed state concurrently; cancel/settle it before retrying a node`,
      )
    }
    throw err
  }
  const runRow = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1))[0]
  if (runRow === undefined || runRow.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }

  // Identify downstream nodeIds from the workflow snapshot's edges.
  // RFC-052: also build a nodeId → kind map so the cascade can skip non-process
  // kinds (input/output/review/clarify) when minting `retryIndex+1` placeholders.
  // Those kinds have no per-attempt process state — their runOneNode paths
  // are either no-ops or driven by external events — and the stale placeholder
  // rows were the source of dispatchReviewNode picking the wrong latest row
  // and resetting approved reviews back to awaiting_review.
  const downstream = new Set<string>()
  // RFC-098 B3 (audit ⑥-11): kindOf is built UNCONDITIONALLY (it used to live
  // inside the cascade branch) — the wrapper-revival carve-out below consults
  // the TARGET's kind even when cascade=false.
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

  // Rollback to the snapshot before the node_run started. The single-node
  // retry uses THIS run's snapshot (not the latest, since the user picked
  // this specific historical attempt).
  // RFC-098 WP-8: same kill-then-proceed as resumeTask — group-kill the
  // target row's still-alive child (if any) before touching the worktree.
  const retryKillOutcome = await killStaleRunProcessTree(runRow)
  if (retryKillOutcome === 'killed') {
    log.warn('retryNode: stale opencode child group-killed before rollback', {
      nodeRunId: runRow.id,
      pid: runRow.pid,
    })
  } else if (retryKillOutcome === 'kill-failed') {
    // RFC-108 T9 (AR-14): our child survived SIGKILL — do NOT git-reset under it.
    await escalateLiveChildSurvived(db, taskId, runRow, 'retryNode') // throws 409
  }
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
  const targetKind = kindOf.get(runRow.nodeId)
  const wrapperRevivalTarget =
    targetKind !== undefined &&
    WRAPPER_KINDS.has(targetKind) &&
    (runRow.status === 'canceled' || runRow.status === 'interrupted')
  const targets = new Set<string>()
  if (!wrapperRevivalTarget) targets.add(runRow.nodeId)
  for (const id of downstream) {
    if (wrapperRevivalTarget && id === runRow.nodeId) continue // defensive: never placeholder the revival row's node
    const k = kindOf.get(id)
    const cascade = k === undefined ? 'mint-placeholder' : NODE_KIND_BEHAVIORS[k].retryCascade
    if (cascade === 'mint-placeholder') {
      targets.add(id)
    }
  }
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
    const maxRetry = existing.reduce((mx, r) => (r.retryIndex > mx ? r.retryIndex : mx), -1)
    const nextRetry = maxRetry + 1
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
  activeTasks.set(taskId, controller)
  void runTask({
    taskId,
    db,
    appHome: opts.deps.appHome ?? Paths.root,
    ...(opts.deps.opencodeCmd ? { opencodeCmd: opts.deps.opencodeCmd } : {}),
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
      if (activeTasks.get(taskId) === controller) activeTasks.delete(taskId)
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
  return rowToTask(row.task, row.workflowName, repos)
}

export interface ListTasksFilters {
  status?: Task['status']
  workflowId?: string
  repoPath?: string
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

export async function listTasks(
  db: DbClient,
  filters: ListTasksFilters = {},
): Promise<TaskSummary[]> {
  const conditions = []
  if (filters.status !== undefined) conditions.push(eq(tasks.status, filters.status))
  if (filters.workflowId !== undefined) conditions.push(eq(tasks.workflowId, filters.workflowId))
  if (filters.repoPath !== undefined) conditions.push(eq(tasks.repoPath, filters.repoPath))
  if (filters.visibility) {
    const { actorUserId, scope } = filters.visibility
    const ownerEq = eq(tasks.ownerUserId, actorUserId)
    const collabExists = inArray(
      tasks.id,
      db
        .select({ id: taskCollaborators.taskId })
        .from(taskCollaborators)
        .where(eq(taskCollaborators.userId, actorUserId)),
    )
    if (scope === 'shared') {
      // Strict "shared with me but not mine" — exclude rows the actor owns.
      conditions.push(and(collabExists, ne(tasks.ownerUserId, actorUserId)))
    } else {
      // 'mine' — owner OR collaborator. Either alone satisfies the gate.
      conditions.push(or(ownerEq, collabExists)!)
    }
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
  return rows.map((r) => ({
    ...rowToSummary(r.task, r.workflowName),
    openAlertCount: openByTask.get(r.task.id) ?? 0,
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
  const dvRows = await db
    .select({
      reviewNodeRunId: docVersions.reviewNodeRunId,
      createdAt: docVersions.createdAt,
      versionIndex: docVersions.versionIndex,
      decision: docVersions.decision,
      decidedAt: docVersions.decidedAt,
    })
    .from(docVersions)
    .where(eq(docVersions.taskId, taskId))
  const versionsByRun = new Map<string, ReviewVersionFacts[]>()
  for (const dv of dvRows) {
    const list = versionsByRun.get(dv.reviewNodeRunId)
    const fact: ReviewVersionFacts = {
      createdAt: dv.createdAt,
      versionIndex: dv.versionIndex,
      decision: dv.decision as DocVersionDecision,
      decidedAt: dv.decidedAt,
    }
    if (list === undefined) versionsByRun.set(dv.reviewNodeRunId, [fact])
    else list.push(fact)
  }

  const runs: NodeRun[] = runRows.map((r) => {
    const reviewTiming = deriveReviewRoundTiming(r, versionsByRun.get(r.id) ?? [])
    return {
      id: r.id,
      taskId: r.taskId,
      nodeId: r.nodeId,
      parentNodeRunId: r.parentNodeRunId,
      iteration: r.iteration,
      shardKey: r.shardKey,
      retryIndex: r.retryIndex,
      reviewIteration: r.reviewIteration,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      pid: r.pid,
      exitCode: r.exitCode,
      errorMessage: r.errorMessage,
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
  for (const repo of usable) {
    const oneRaw = await gitDiffSnapshot(repo.worktreePath, repo.baseCommit as string)
    if (oneRaw === '') continue
    const header = `# === Repo: ${repo.worktreeDirName || repo.repoPath} ===\n`
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
    repoUrl: row.repoUrl ?? null,
    worktreePath: row.worktreePath,
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
    repos,
  }
}

function rowToSummary(row: typeof tasks.$inferSelect, workflowName: string | null): TaskSummary {
  return {
    id: row.id,
    name: row.name, // RFC-037
    workflowId: row.workflowId,
    workflowName,
    repoPath: row.repoPath,
    repoUrl: row.repoUrl ?? null,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorSummary: row.errorSummary,
    // RFC-066: source-of-truth `tasks.repo_count`. Migration 0034 defaulted
    // every existing row to 1; multi-repo launches set it explicitly.
    repoCount: row.repoCount,
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
    repoUrl: row.repoUrl ?? null,
    baseBranch: row.baseBranch,
    branch: row.branch,
    // RFC-075: per-repo working-branch mirror (NULL → isolation branch).
    workingBranch: row.workingBranch ?? null,
    baseCommit: row.baseCommit ?? null,
    worktreePath: row.worktreePath,
    worktreeDirName: row.worktreeDirName,
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
    repoUrl: row.repoUrl ?? null,
    baseBranch: row.baseBranch,
    branch: row.branch,
    // RFC-075: mirror the task-level working branch onto the synthesized repo.
    workingBranch: row.workingBranch ?? null,
    baseCommit: row.baseCommit ?? null,
    worktreePath: row.worktreePath,
    worktreeDirName: '',
    hasSubmodules: null,
    submoduleInitOk: null,
    submoduleInitError: null,
  }
}
