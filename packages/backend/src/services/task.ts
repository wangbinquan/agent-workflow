// Task service — start / list / get.
// Cancel/resume/retry land in P-1-15 + M3 (P-3-08, P-3-09).

import type {
  NodeKind,
  NodeRun,
  NodeRunEvent,
  NodeRunEventsResponse,
  NodeRunOutput,
  StartTask,
  Task,
  TaskDiff,
  TaskNodeRuns,
  TaskSummary,
} from '@agent-workflow/shared'
import { NODE_KIND_BEHAVIORS } from '@agent-workflow/shared'
import { and, asc, desc, eq, gt, inArray, ne, or } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import {
  attempts,
  logicalRuns,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  taskCollaborators,
  tasks,
  workflows,
} from '@/db/schema'
import { writeEvents, type NewEvent } from '@/services/writeEvents'
import { getWorkflow } from '@/services/workflow'
import { listAgents } from '@/services/agent'
import { listSkills } from '@/services/skill'
import { validateWorkflowDef } from '@/services/workflow.validator'
import { upsertRecentRepo } from '@/services/repo'
import { listAvailableRefs, resolveCachedRepo } from '@/services/gitRepoCache'
import { createWorktree, rollbackToSnapshot, worktreeDiff } from '@/util/git'
import { redactGitUrl } from '@agent-workflow/shared'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { readArchivedEvents } from '@/services/eventsArchive'
import {
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  taskBroadcaster,
  tasksListBroadcaster,
} from '@/ws/broadcaster'
import {
  runTaskActorViaProduction,
  type RunTaskActorViaProductionOptions,
} from '@/scheduler-v2/launcher'
import { Paths } from '@/util/paths'
import { createLogger } from '@/util/log'
import { parseInjectedSnapshotJson } from './memoryInject'
import { parsePortValidationFailuresJson } from './envelope'

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
   * RFC-036 — launcher user id. NULL falls back to the legacy single-user
   * behavior (ownerUserId stays NULL; no collab/assignment rows written).
   * The route passes actor.user.id when the actor is a real user; daemon-
   * token callers can leave it unset or pass '__system__' explicitly.
   */
  actorUserId?: string
  /**
   * RFC-061 transition: route the task through the new event-driven
   * actor + runner-v2 instead of legacy services/scheduler:runTask.
   * When true (or when env RFC_061_ACTOR_PATH=1), the actor path is
   * used; otherwise legacy. Each task picks exactly one path — no
   * dual-write. After T10 cutover removes legacy services this flag
   * becomes a no-op (the only path).
   */
  useActorPath?: boolean
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

/**
 * RFC-024: resolve `StartTask` to the local path + ref the worktree machinery
 * needs. Path mode is pass-through; URL mode triggers `resolveCachedRepo`
 * (clone-or-reuse) and folds in the cache's default branch when the caller
 * didn't specify a ref.
 */
async function resolveRepoSource(
  input: StartTask,
  deps: StartTaskDeps,
): Promise<{ repoPath: string; baseBranch: string | undefined; repoUrl: string | null }> {
  if (input.repoPath) {
    return {
      repoPath: input.repoPath,
      baseBranch: input.baseBranch,
      repoUrl: null,
    }
  }
  if (!input.repoUrl) {
    throw new ValidationError(
      'start-task-source-required',
      'one of repoPath or repoUrl is required',
    )
  }
  const appHome = deps.appHome ?? Paths.root
  const resolved = await resolveCachedRepo({ db: deps.db, appHome }, { url: input.repoUrl })
  return {
    repoPath: resolved.cached.localPath,
    baseBranch: input.ref ?? resolved.cached.defaultBranch ?? undefined,
    repoUrl: input.repoUrl,
  }
}

export async function startTask(input: StartTask, deps: StartTaskDeps): Promise<Task> {
  // Resolve workflow.
  const workflow = await getWorkflow(deps.db, input.workflowId)
  if (workflow === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${input.workflowId}' not found`)
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

  // RFC-024: resolve URL or path mode to a concrete local repoPath + ref.
  // URL mode may trigger a `git clone` here (caller is responsible for any
  // user-facing "cloning in progress" UI). For multipart (RFC-020) the
  // resolved repo info is reused via deps.preCreatedWorktree below.
  const source = await resolveRepoSource(input, deps)

  // RFC-020: multipart-upload flow creates the worktree before this call so
  // it can write user files into it. JSON-body flow takes the original path:
  // mint a fresh id, call materializeWorktree here.
  let taskId: string
  let worktreePath: string
  let branch: string
  let baseCommit: string | null
  let earlyError: string | null
  if (deps.preCreatedWorktree !== undefined) {
    taskId = deps.preCreatedWorktree.taskId
    worktreePath = deps.preCreatedWorktree.worktreePath
    branch = deps.preCreatedWorktree.branch
    baseCommit = deps.preCreatedWorktree.baseCommit
    earlyError = null
  } else {
    taskId = ulid()
    const wt = await materializeWorktree({
      repoPath: source.repoPath,
      baseBranch: source.baseBranch,
      taskId,
      appHome,
    })
    worktreePath = wt.worktreePath
    branch = wt.branch
    baseCommit = wt.baseCommit
    earlyError = wt.earlyError

    // RFC-034: worktree creation succeeded but post-`worktree add` submodule
    // init may have failed. We warn and continue — agents see empty submodule
    // dirs but task lifecycle is unaffected. UI surface lives in /repos page
    // for URL mode (via cached_repos.last_submodule_sync_*); path mode users
    // see warn logs only.
    if (earlyError === null && !wt.submoduleInitOk) {
      const { createLogger } = await import('@/util/log')
      const log = createLogger('task')
      log.warn('[rfc034/submodule-init-failed] worktree submodule init failed', {
        taskId,
        worktreePath,
        stderr: wt.submoduleInitError ?? '',
      })
    }

    // URL mode: a `worktree-base-invalid` from createWorktree usually means
    // the user-supplied ref doesn't exist in the cached mirror. Rewrap it
    // with the available refs so the launcher can render a helpful list.
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
  }

  const now = Date.now()
  await deps.db.insert(tasks).values({
    id: taskId,
    // RFC-037: required name (StartTaskSchema already trimmed + length-validated).
    name: input.name,
    workflowId: workflow.id,
    workflowSnapshot: JSON.stringify(workflow.definition),
    repoPath: source.repoPath,
    // RFC-054 W3-4 KNOWN_GAP fix: never persist the credentialed URL.
    // gitRepoCache has already used the cleartext form to clone (line
    // 197 above); from this point onward the daemon only needs the
    // redacted form (for display, WS broadcast, error messages). The
    // cleartext URL is reachable only ephemerally via the cache key
    // hash, so even DB-level access can't reconstruct it.
    repoUrl: source.repoUrl !== null ? redactGitUrl(source.repoUrl) : null,
    worktreePath,
    baseBranch: source.baseBranch ?? '',
    branch: branch !== '' ? branch : `agent-workflow/${taskId}`,
    baseCommit,
    status: earlyError === null ? 'pending' : 'failed',
    inputs: JSON.stringify(input.inputs),
    maxDurationMs: input.maxDurationMs ?? null,
    maxTotalTokens: input.maxTotalTokens ?? null,
    startedAt: now,
    finishedAt: earlyError === null ? null : now,
    errorSummary: earlyError !== null ? `worktree creation failed: ${earlyError}` : null,
    errorMessage: earlyError,
    // RFC-036: launcher identity (NULL = legacy / __system__ fallback).
    ownerUserId: deps.actorUserId ?? null,
  })

  // RFC-036: record collaborators + node assignments. ensureValidAssignments
  // has already been run by the caller against the user-provided payload.
  if (deps.actorUserId) {
    const { recordLaunchContext } = await import('@/services/taskCollab')
    try {
      await recordLaunchContext(deps.db, {
        taskId,
        ownerUserId: deps.actorUserId,
        assignments: input.assignments ?? [],
        collaboratorUserIds: input.collaboratorUserIds ?? [],
        now,
      })
    } catch (err) {
      // Roll back the task row so the caller sees a clean 422 with no
      // half-created row in /api/tasks. Use deletedAt soft-delete since
      // SQLite FKs may still hold partial node_assignments inserts.
      await deps.db.delete(tasks).where(eq(tasks.id, taskId))
      throw err
    }
  }

  // Mirror this repo into the recent-repos cache — best-effort, never blocks.
  // RFC-024: only path-mode tasks belong in `recent_repos` (URL-mode tasks
  // are tracked via `cached_repos` instead).
  if (source.repoUrl === null) {
    upsertRecentRepo(deps.db, source.repoPath).catch((err) => {
      log.warn('upsertRecentRepo failed', { error: (err as Error).message })
    })
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
    },
  })

  if (earlyError !== null) {
    return task
  }

  // RFC-061 T10 hard cut: all tasks now run through the event-driven
  // actor + runner-v2. Legacy services/scheduler:runTask deleted.
  const controller = new AbortController()
  activeTasks.set(taskId, controller)
  const schedulerPromise = kickActorPath(
    deps.db,
    taskId,
    workflow.definition,
    input.inputs,
    source.repoPath,
    worktreePath,
    appHome,
    controller,
    deps.opencodeCmd,
  ).finally(() => {
    activeTasks.delete(taskId)
  })

  if (deps.awaitScheduler === true) {
    await schedulerPromise
    return (await getTask(deps.db, taskId)) as Task
  }
  return task
}

/**
 * RFC-061: kick the actor + production runner path. Wraps
 * runTaskActorViaProduction in a try/catch matching the legacy runTask
 * shape so startTask's then/finally cleanup stays uniform.
 */
async function kickActorPath(
  db: DbClient,
  taskId: string,
  workflow: unknown,
  inputs: Record<string, unknown>,
  repoPath: string,
  worktreePath: string,
  appHome: string,
  controller: AbortController,
  opencodeCmd?: readonly string[],
): Promise<void> {
  void controller // cancel propagation TBD; the registry handles deregister
  try {
    const inputsMap: Record<string, string> = {}
    for (const [k, v] of Object.entries(inputs)) {
      if (typeof v === 'string') inputsMap[k] = v
      else inputsMap[k] = JSON.stringify(v)
    }
    const opts: RunTaskActorViaProductionOptions = {
      db,
      taskId,
      workflow: workflow as never,
      inputsMap,
      worktreePath,
      repoPath,
      appHome,
      ...(opencodeCmd !== undefined ? { opencodeCmd } : {}),
    }
    await runTaskActorViaProduction(opts)
  } catch (err) {
    log.error('actor-path threw', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Cancel an in-flight task. Aborts the in-process controller (runner SIGTERMs
 * the opencode child), then waits briefly for the scheduler to settle.
 *
 * Rejects if the task is already terminal.
 */
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
  await db
    .update(tasks)
    .set({
      status: 'canceled',
      finishedAt: Date.now(),
      errorSummary: 'canceled by user',
      errorMessage: 'no active scheduler at cancel time',
    })
    .where(eq(tasks.id, id))
  const final = (await getTask(db, id)) as Task
  emitTaskStatus(final)
  return final
}

/**
 * Resume a failed or interrupted task (P-3-08).
 *
 * Walks all node_runs in failed/interrupted state, rolls the worktree back
 * to each one's pre_snapshot (write nodes only — readers leave the
 * worktree alone), flips the surviving runs back to `pending`, then kicks
 * the scheduler. Done node_runs stay untouched so the resumed task picks
 * up where it left off.
 */
export async function resumeTask(db: DbClient, id: string, deps: StartTaskDeps): Promise<Task> {
  const task = await getTask(db, id)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${id}' not found`)
  }
  if (
    task.status !== 'failed' &&
    task.status !== 'interrupted' &&
    task.status !== 'awaiting_review' && // RFC-005: decision handler resumes after pause
    task.status !== 'awaiting_human' // RFC-023: clarify answer submit resumes after pause
  ) {
    throw new ConflictError(
      'task-not-resumable',
      `task '${id}' is ${task.status}; only failed/interrupted/awaiting_review/awaiting_human tasks can resume`,
    )
  }

  // RFC-061 follow-up: walk failed logical_runs and roll the worktree back
  // to each one's last attempt's pre_snapshot. The legacy "skip the actual
  // rerun" comment below stays true under the actor model — the actor wakes
  // on the task.status flip, scans projections, and re-dispatches whatever
  // is pending. The actor's rescan is what produces the fresh attempt; this
  // function only owns the worktree rollback + status flip.
  const failedLrs = await db
    .select()
    .from(logicalRuns)
    .where(and(eq(logicalRuns.taskId, id), eq(logicalRuns.status, 'failed')))
  for (const lr of failedLrs) {
    const attRows = await db
      .select({ preSnapshot: attempts.preSnapshot })
      .from(attempts)
      .where(eq(attempts.logicalRunId, lr.id))
      .orderBy(desc(attempts.attemptSeq))
      .limit(1)
    const preSnapshot = attRows[0]?.preSnapshot ?? null
    if (preSnapshot !== null && preSnapshot !== '' && task.worktreePath !== '') {
      try {
        await rollbackToSnapshot(task.worktreePath, preSnapshot)
      } catch (err) {
        log.warn('resume rollback failed', {
          logicalRunId: lr.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  await db
    .update(tasks)
    .set({
      status: 'pending',
      finishedAt: null,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
    })
    .where(eq(tasks.id, id))

  const next = (await getTask(db, id)) as Task
  emitTaskStatus(next)

  // RFC-061 T10: resume rejoins the actor (seedInitialEventsIfMissing idempotent).
  const controller = new AbortController()
  activeTasks.set(id, controller)
  const workflowDef = parseSnapshot(task.workflowSnapshot) as Record<string, unknown>
  const inputsMap: Record<string, unknown> = task.inputs as Record<string, unknown>
  void kickActorPath(
    db,
    id,
    workflowDef,
    inputsMap,
    task.repoPath,
    task.worktreePath,
    deps.appHome ?? Paths.root,
    controller,
    deps.opencodeCmd,
  ).finally(() => {
    activeTasks.delete(id)
  })
  return next
}

/**
 * Retry one logical_run, optionally cascading to all downstream nodes
 * that depended on it. Under RFC-061 this is implemented entirely via
 * events: we emit `logical-run-iter-bumped` for the picked node + each
 * cascaded downstream node, which the eventApplier turns into a fresh
 * pending logical_run row at iter+1. The actor's next wake picks them
 * up and dispatches.
 *
 * Cascade rule: NODE_KIND_BEHAVIORS[kind].retryCascade decides whether
 * a downstream node gets bumped ('mint-placeholder') or left alone
 * ('skip'). Kinds with no execution side-effects (input / output /
 * clarify / review) get 'skip' under the legacy table; we keep the
 * same matrix so user-facing retry semantics are preserved across the
 * cutover.
 *
 * The 5 collapsed counters (retry/iteration/clarify/review/cross-
 * clarify) are GONE — there's only `iter`. Every retry simply bumps
 * iter by 1; the agent's prompt reconstruction (promptFromEvents)
 * picks up the relevant resolution events from history.
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
  if (task.status === 'pending' || task.status === 'running') {
    throw new ConflictError(
      'task-still-running',
      `task '${taskId}' is ${task.status}; cancel it first before retrying a node`,
    )
  }

  // nodeRunId is now a logical_run.id (the projection shim returns
  // logical_run.id as NodeRun.id). Validate it belongs to this task.
  const lrRows = await db
    .select()
    .from(logicalRuns)
    .where(eq(logicalRuns.id, nodeRunId))
    .limit(1)
  const lr = lrRows[0]
  if (lr === undefined || lr.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }

  // Walk the workflow snapshot for the cascade set + nodeId → kind map.
  const downstream = new Set<string>()
  const kindOf = new Map<string, NodeKind>()
  if (cascade) {
    const snap = parseSnapshot(task.workflowSnapshot)
    const nodes = Array.isArray(snap?.nodes) ? snap.nodes : []
    for (const n of nodes as Array<{ id?: string; kind?: string }>) {
      if (typeof n?.id === 'string' && typeof n?.kind === 'string') {
        kindOf.set(n.id, n.kind as NodeKind)
      }
    }
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
    const stack: string[] = [lr.nodeId]
    while (stack.length > 0) {
      const cur = stack.pop()!
      for (const next of adj.get(cur) ?? []) {
        if (downstream.has(next)) continue
        downstream.add(next)
        stack.push(next)
      }
    }
  }

  // Rollback to the snapshot taken before the picked logical_run's last
  // attempt started. Look up the latest attempt for the picked lr.
  const pickedAttempts = await db
    .select({ preSnapshot: attempts.preSnapshot })
    .from(attempts)
    .where(eq(attempts.logicalRunId, lr.id))
    .orderBy(desc(attempts.attemptSeq))
    .limit(1)
  const pickedSnapshot = pickedAttempts[0]?.preSnapshot ?? null
  if (pickedSnapshot !== null && pickedSnapshot !== '' && task.worktreePath !== '') {
    try {
      await rollbackToSnapshot(task.worktreePath, pickedSnapshot)
    } catch (err) {
      log.warn('node retry rollback failed', {
        logicalRunId: lr.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Build the bump set: the picked node + cascaded downstream with
  // retryCascade='mint-placeholder'. Skip kinds the matrix marks 'skip'.
  const bumpTargets = new Set<string>([lr.nodeId])
  for (const id of downstream) {
    const k = kindOf.get(id)
    const c = k === undefined ? 'mint-placeholder' : NODE_KIND_BEHAVIORS[k].retryCascade
    if (c === 'mint-placeholder') bumpTargets.add(id)
  }

  // For each target node, emit a logical-run-iter-bumped event at the
  // top-level scope (loopIter=0, shardKey=''). Only target nodes that
  // already have at least one logical_run get bumped; nodes with no
  // existing row will be minted by the actor's scanFreshDownstream once
  // the upstream done events propagate through ready check.
  const bumpEvents: NewEvent<'logical-run-iter-bumped'>[] = []
  for (const nodeId of bumpTargets) {
    const myLatest = await db
      .select()
      .from(logicalRuns)
      .where(
        and(
          eq(logicalRuns.taskId, taskId),
          eq(logicalRuns.nodeId, nodeId),
          eq(logicalRuns.loopIter, 0),
          eq(logicalRuns.shardKey, ''),
        ),
      )
      .orderBy(desc(logicalRuns.iter))
      .limit(1)
    const prev = myLatest[0]
    if (prev === undefined) continue
    bumpEvents.push({
      taskId,
      kind: 'logical-run-iter-bumped',
      payload: { triggerEventId: prev.lastEventId, triggerKind: 'user-retry' },
      actor: 'user:retry',
      nodeId,
      loopIter: 0,
      shardKey: '',
      iter: prev.iter + 1,
    })
  }
  if (bumpEvents.length > 0) {
    await writeEvents(db, bumpEvents)
  }

  await db
    .update(tasks)
    .set({
      status: 'pending',
      finishedAt: null,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
    })
    .where(eq(tasks.id, taskId))
  const next = (await getTask(db, taskId)) as Task
  emitTaskStatus(next)

  // RFC-061 T10: retry rejoins the actor.
  const controller = new AbortController()
  activeTasks.set(taskId, controller)
  const task2 = (await getTask(db, taskId))!
  const workflowDef = parseSnapshot(task2.workflowSnapshot) as Record<string, unknown>
  const inputsMap: Record<string, unknown> = task2.inputs as Record<string, unknown>
  void kickActorPath(
    db,
    taskId,
    workflowDef,
    inputsMap,
    task2.repoPath,
    task2.worktreePath,
    opts.deps.appHome ?? Paths.root,
    controller,
    opts.deps.opencodeCmd,
  ).finally(() => {
    activeTasks.delete(taskId)
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
  return row ? rowToTask(row.task, row.workflowName) : null
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
  return rows.map((r) => rowToSummary(r.task, r.workflowName))
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

  const runs: NodeRun[] = runRows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    nodeId: r.nodeId,
    parentNodeRunId: r.parentNodeRunId,
    iteration: r.iteration,
    shardKey: r.shardKey,
    retryIndex: r.retryIndex,
    reviewIteration: r.reviewIteration,
    clarifyIteration: r.clarifyIteration,
    // RFC-056: surface cross-clarify rerun iteration counter (orthogonal to
    // clarifyIteration; see §C8 cascade isolation).
    crossClarifyIteration: r.crossClarifyIteration,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    pid: r.pid,
    exitCode: r.exitCode,
    errorMessage: r.errorMessage,
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
  }))

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
 * Throws ValidationError if baseCommit wasn't captured (task failed before
 * worktree creation) or if the worktree directory has been removed.
 */
export async function getTaskDiff(db: DbClient, taskId: string): Promise<TaskDiff> {
  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  if (task.baseCommit === null) {
    throw new DomainError(
      'task-no-base-commit',
      `task '${taskId}' has no base commit recorded; cannot compute diff`,
      409,
    )
  }
  if (!existsSync(task.worktreePath)) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute diff`,
      410,
    )
  }
  const { diff, truncated } = await worktreeDiff(task.worktreePath, task.baseCommit)
  return { diff, baseCommit: task.baseCommit, truncated }
}

function rowToTask(row: typeof tasks.$inferSelect, workflowName: string | null): Task {
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
  }
}
