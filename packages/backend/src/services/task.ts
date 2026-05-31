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
import { NODE_KIND_BEHAVIORS } from '@agent-workflow/shared'
import { and, asc, desc, eq, gt, inArray, ne, or } from 'drizzle-orm'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import {
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
import { listAvailableRefs, resolveCachedRepo } from '@/services/gitRepoCache'
import { createWorktree, gitDiffSnapshot, rollbackToSnapshot, worktreeDiff } from '@/util/git'
import { redactGitUrl } from '@agent-workflow/shared'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { readArchivedEvents } from '@/services/eventsArchive'
import {
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  taskBroadcaster,
  tasksListBroadcaster,
} from '@/ws/broadcaster'
import { runTask } from './scheduler'
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

interface ResolvedRepoSource {
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
function normalizeStartTaskRepos(input: StartTask): StartTaskRepo[] {
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
async function resolveRepoSourceSingle(
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
  for (const spec of repoSpecs) {
    const r = await resolveRepoSourceSingle(spec, input, deps)
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
    ...(deps.defaultPerNodeTimeoutMs !== undefined
      ? { defaultPerNodeTimeoutMs: deps.defaultPerNodeTimeoutMs }
      : {}),
    ...(deps.subagentLiveCapture !== undefined
      ? { subagentLiveCapture: deps.subagentLiveCapture }
      : {}),
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
      activeTasks.delete(taskId)
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
 * resume / single-node-retry paths. Two strategies depending on `task.repoCount`:
 *
 *  - Single-repo (repoCount === 1): read the legacy `preSnapshot` column
 *    (a single git-stash sha) and roll back `task.worktreePath`.
 *    Byte-baseline equivalent to pre-RFC-066 behavior.
 *  - Multi-repo (repoCount > 1): read the new `preSnapshotReposJson` column
 *    (`{<worktreeDirName>: <stashSha>}` map) and roll each per-repo sub-
 *    worktree independently. Defensive fallback to the single-string
 *    `preSnapshot` for any task_repos row that happens to predate PR-B
 *    (e.g. multi-repo task created before T13 landed); same `task.worktreePath`
 *    rollback path is used as a last-ditch attempt in that case.
 *
 * Errors per repo are warn-and-continue; we never abort the resume because
 * one of N repos' stash applies failed. Caller decides next step.
 */
async function rollbackNodeRunForResume(
  task: Task,
  run: { id: string; preSnapshot: string | null; preSnapshotReposJson: string | null },
  log: ReturnType<typeof createLogger>,
): Promise<void> {
  // Multi-repo path: prefer the per-repo map when present.
  if (task.repoCount > 1 && run.preSnapshotReposJson !== null && task.repos.length > 0) {
    let map: Record<string, string> = {}
    try {
      map = JSON.parse(run.preSnapshotReposJson) as Record<string, string>
    } catch (err) {
      log.warn('preSnapshotReposJson parse failed; falling back to legacy single-stash rollback', {
        nodeRunId: run.id,
        error: err instanceof Error ? err.message : String(err),
      })
      // Fall through to single-repo path below.
    }
    for (const repo of task.repos) {
      const sha = map[repo.worktreeDirName] ?? ''
      if (sha === '') continue
      try {
        await rollbackToSnapshot(repo.worktreePath, sha)
      } catch (err) {
        log.warn('resume rollback per-repo failed', {
          nodeRunId: run.id,
          worktreeDirName: repo.worktreeDirName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return
  }

  // Single-repo path (or multi-repo defensive fallback when the per-repo
  // map is unparseable / absent). Byte-baseline equivalent to pre-RFC-066.
  if (run.preSnapshot !== null && run.preSnapshot !== '' && task.worktreePath !== '') {
    try {
      await rollbackToSnapshot(task.worktreePath, run.preSnapshot)
    } catch (err) {
      log.warn('resume rollback failed', {
        nodeRunId: run.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
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

  // Collect the latest non-done run per nodeId — those are the ones that
  // need rollback + a fresh attempt.
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))
  const latestPerNode = new Map<string, (typeof runs)[number]>()
  for (const r of runs) {
    const prev = latestPerNode.get(r.nodeId)
    if (prev === undefined || r.retryIndex > prev.retryIndex) latestPerNode.set(r.nodeId, r)
  }
  const toRollback = [...latestPerNode.values()].filter(
    (r) => r.status === 'failed' || r.status === 'interrupted',
  )

  for (const r of toRollback) {
    await rollbackNodeRunForResume(task, r, log)
    // The scheduler creates a new node_run with retry_index = max+1 on its
    // own when it sees no pending run for the node, so we just leave the
    // failed row as historical and clear errors on the task.
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

  // Kick the scheduler — same plumbing as startTask but without re-creating
  // the worktree.
  const controller = new AbortController()
  activeTasks.set(id, controller)
  void runTask({
    taskId: id,
    db,
    appHome: deps.appHome ?? Paths.root,
    ...(deps.opencodeCmd ? { opencodeCmd: deps.opencodeCmd } : {}),
    ...(deps.defaultPerNodeTimeoutMs !== undefined
      ? { defaultPerNodeTimeoutMs: deps.defaultPerNodeTimeoutMs }
      : {}),
    ...(deps.subagentLiveCapture !== undefined
      ? { subagentLiveCapture: deps.subagentLiveCapture }
      : {}),
    log,
    signal: controller.signal,
  })
    .catch((err) => {
      log.error('runTask threw on resume', {
        taskId: id,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      activeTasks.delete(id)
    })
  return next
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
  if (task.status === 'pending' || task.status === 'running') {
    throw new ConflictError(
      'task-still-running',
      `task '${taskId}' is ${task.status}; cancel it first before retrying a node`,
    )
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
  await rollbackNodeRunForResume(task, runRow, log)

  // Flip target + downstream node_runs from done → failed so the resumer
  // re-runs them. We do this by inserting a fresh failed row at retry_index
  // max+1, so the scheduler treats it as the "latest" and starts attempt+1.
  //
  // Carry forward (iteration, clarifyIteration, reviewIteration, shardKey,
  // parentNodeRunId, preSnapshot) from the prior run so the retried attempt
  // resumes in the same loop / clarify / review / shard frame. Skipping this
  // step previously reset clarifyIteration to 0 on retry, which made
  // buildClarifyPromptContext drop every answered round and the agent's
  // multi-round clarify history vanished from the next prompt. For the
  // explicitly retried target the source-of-truth is `runRow` (the row the
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
  const targets = new Set<string>([runRow.nodeId])
  for (const id of downstream) {
    const k = kindOf.get(id)
    const cascade = k === undefined ? 'mint-placeholder' : NODE_KIND_BEHAVIORS[k].retryCascade
    if (cascade === 'mint-placeholder') {
      targets.add(id)
    }
  }
  for (const nodeId of targets) {
    const existing = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
      .orderBy(desc(nodeRuns.retryIndex))
      .limit(1)
    const prev = existing[0]
    const nextRetry = prev === undefined ? 0 : prev.retryIndex + 1
    const inherit = nodeId === runRow.nodeId ? runRow : prev
    const newId = ulid()
    await db.insert(nodeRuns).values({
      id: newId,
      taskId,
      nodeId,
      status: 'failed',
      retryIndex: nextRetry,
      iteration: inherit?.iteration ?? 0,
      // RFC-064: the inherited clarifyIteration alone now covers both self
      // + cross signals (no more separate crossClarifyIteration mirror to
      // worry about — patch-2026-05-25 §2.3's intent is structurally
      // preserved by the unified counter).
      clarifyIteration: inherit?.clarifyIteration ?? 0,
      reviewIteration: inherit?.reviewIteration ?? 0,
      shardKey: inherit?.shardKey ?? null,
      parentNodeRunId: inherit?.parentNodeRunId ?? null,
      preSnapshot: inherit?.preSnapshot ?? null,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      errorMessage: 'queued for retry',
    })
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

  const controller = new AbortController()
  activeTasks.set(taskId, controller)
  void runTask({
    taskId,
    db,
    appHome: opts.deps.appHome ?? Paths.root,
    ...(opts.deps.opencodeCmd ? { opencodeCmd: opts.deps.opencodeCmd } : {}),
    ...(opts.deps.defaultPerNodeTimeoutMs !== undefined
      ? { defaultPerNodeTimeoutMs: opts.deps.defaultPerNodeTimeoutMs }
      : {}),
    ...(opts.deps.subagentLiveCapture !== undefined
      ? { subagentLiveCapture: opts.deps.subagentLiveCapture }
      : {}),
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
    // RFC-023 + RFC-064: unified clarifyIteration covers BOTH self-clarify
    // and cross-clarify rounds (single counter post-RFC-064).
    clarifyIteration: r.clarifyIteration,
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
  const usable = task.repos.filter(
    (r) => r.baseCommit !== null && r.baseCommit !== '' && existsSync(r.worktreePath),
  )
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
