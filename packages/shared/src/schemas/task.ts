// Task schemas. Mirrors design.md §3 (tasks table) + plan.md P-1-14.

import { z } from 'zod'
import { InjectedMemorySnapshotSchema } from './memory'

export const TASK_STATUS = [
  'pending',
  'running',
  'done',
  'failed',
  'canceled',
  'interrupted',
  // RFC-005: at least one review node in the task is waiting on human decision.
  // Derived from node_runs; does NOT count against maxConcurrentNodes (idle).
  'awaiting_review',
  // RFC-023: at least one clarify node in the task is waiting on user answers.
  // Has HIGHER priority than awaiting_review at the task level: when both
  // states coexist, recomputeTaskStatus reports awaiting_human (agent actively
  // blocked on input vs. user reviewing finished output).
  'awaiting_human',
] as const
export const TaskStatusSchema = z.enum(TASK_STATUS)
export type TaskStatus = z.infer<typeof TaskStatusSchema>

/**
 * RFC-037: user-supplied display name captured at launch time. Required for
 * all new tasks. Trimmed; 1..255 chars after trim. Persisted in `tasks.name`.
 * Migration 0021 backfills historical rows from `workflows.name` (fallback:
 * `task-{shortId}`).
 */
export const TASK_NAME_MAX = 255
export const TaskNameSchema = z
  .string()
  .trim()
  .min(1, 'name is required (1..255 chars after trim)')
  .max(TASK_NAME_MAX, `name must be ≤ ${TASK_NAME_MAX} chars`)

/**
 * RFC-066: maximum repos per multi-repo task. Hard cap to bound the
 * concurrent `git worktree add` work and submodule init storm. 8 covers all
 * realistic cross-repo workflows we've seen; raising it later only requires
 * touching this constant.
 */
export const MULTI_REPO_MAX = 8

/**
 * RFC-165: task execution-space kind.
 * - 'local'    — legacy path-mode tasks only (mode retired by RFC-165; kept for
 *                historical rows, never written for new launches).
 * - 'remote'   — URL mode: cached mirror clone + per-task worktree.
 * - 'scratch'  — RFC-165 temporary space: the workspace IS a fresh git repo
 *                (empty root commit); no source repo, no remote.
 * - 'internal' — framework-internal launches (fusion) via the service-level
 *                `internalSource` dep; unreachable from the public wire.
 */
export const SPACE_KINDS = ['local', 'remote', 'scratch', 'internal'] as const
export const SpaceKindSchema = z.enum(SPACE_KINDS)
export type SpaceKind = z.infer<typeof SpaceKindSchema>

/**
 * RFC-075: optional working branch name captured at launch. Applies to every
 * repo in a multi-repo task. Loose validation here only catches the obvious
 * illegal shapes early so the launcher can show a field error; the
 * authoritative check is `git check-ref-format --branch <name>` run inside
 * util/git at materialize time (rejects with `working-branch-invalid`).
 */
export const WORKING_BRANCH_MAX = 255
// Conservative subset of git's ref-format rules: no whitespace / control
// chars / `~^:?*[\`, no `..`, no `@{`, no leading or trailing `/`, no `//`,
// not `@` alone, no leading/trailing `.`, not ending in `.lock`.
const WORKING_BRANCH_ILLEGAL =
  // eslint-disable-next-line no-control-regex
  /[\s~^:?*[\\\x00-\x1f\x7f]|\.\.|@\{|^\/|\/$|\/\/|\.lock$|^@$|^\.|\.$/
export function isLooseValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > WORKING_BRANCH_MAX) return false
  return !WORKING_BRANCH_ILLEGAL.test(name)
}

/**
 * RFC-066/165: single repo entry inside `StartTask.repos[]` — URL-only since
 * RFC-165 retired path mode from the public wire (`file://` URLs are the
 * local-repo escape hatch; framework-internal local launches ride
 * `deps.internalSource` instead). `ref` optional → the cached repo's default
 * branch.
 */
export const StartTaskRepoSchema = z.object({
  repoUrl: z.string().min(1),
  ref: z.string().min(1).optional(),
})
export type StartTaskRepo = z.infer<typeof StartTaskRepoSchema>

/**
 * RFC-066: one row of `task_repos`, returned as `Task.repos[i]`. Single-repo
 * tasks have a 1-element array mirroring `Task.repoPath` / `worktreePath` /
 * `baseBranch` / `branch` / `baseCommit` / `repoUrl`. Multi-repo tasks have
 * N entries (sorted by `repoIndex`); `Task.*` top-level columns mirror
 * `repos[0]` for legacy API compatibility.
 */
export const TaskRepoSchema = z.object({
  /** 0..N-1; entry at index 0 is the "primary" repo (mirrors Task.* columns). */
  repoIndex: z.number().int().nonnegative(),
  repoPath: z.string(),
  /** RFC-024 redacted; null for path-mode entries. */
  repoUrl: z.string().nullable(),
  baseBranch: z.string(),
  branch: z.string(),
  /**
   * RFC-075: user-specified working branch for this repo (mirrors
   * `task_repos.working_branch`). Null when the task did not specify one — in
   * that case `branch` is the framework default `agent-workflow/{taskId}`.
   * When set, `branch === workingBranch`.
   */
  workingBranch: z.string().nullable().default(null),
  baseCommit: z.string().nullable(),
  worktreePath: z.string(),
  /**
   * Sub-directory basename inside `Task.worktreePath` for multi-repo tasks
   * (`utils` / `utils-2` / `utils-3` after auto-suffix collision resolution).
   * Empty string for single-repo tasks where `Task.worktreePath` is the repo
   * worktree itself.
   */
  worktreeDirName: z.string(),
  /** RFC-034: post-`worktree add` submodule init telemetry per repo. */
  hasSubmodules: z.boolean().nullable(),
  submoduleInitOk: z.boolean().nullable(),
  submoduleInitError: z.string().nullable(),
})
export type TaskRepo = z.infer<typeof TaskRepoSchema>

/** Full task row as returned by GET /api/tasks/:id. */
export const TaskSchema = z.object({
  id: z.string(),
  /** RFC-037: user-supplied display name; non-empty after migration 0021 backfill. */
  name: z.string(),
  workflowId: z.string(),
  /**
   * Display name of the referenced workflow, joined at query time. Null
   * when the workflow row was deleted (the task still survives via
   * workflowSnapshot, but we have no name to render).
   */
  workflowName: z.string().nullable(),
  /** Snapshotted workflow definition; survives later workflow edits. */
  workflowSnapshot: z.unknown(),
  /**
   * RFC-109: the `workflows.version` the snapshot was taken from (or last
   * synced to). Null for legacy tasks launched before migration 0050.
   */
  workflowVersion: z.number().nullable(),
  repoPath: z.string(),
  /**
   * RFC-024: original Git URL the task was launched from (when the user picked
   * the "remote URL" tab). `null` for path-mode tasks. May contain credentials —
   * UI MUST render via `redactGitUrl`.
   */
  repoUrl: z.string().nullable(),
  worktreePath: z.string(),
  baseBranch: z.string(),
  branch: z.string(),
  /**
   * RFC-075: user-specified working branch (applies to every repo; per-repo
   * values live in `repos[i].workingBranch`). Null when none was specified —
   * `branch` is then the framework default `agent-workflow/{taskId}`. Detail
   * page renders this alongside `baseBranch`.
   */
  workingBranch: z.string().nullable().default(null),
  /**
   * RFC-075: when true, the framework auto-commits & pushes each writer
   * agent's final output (see RFC-075). Default false → byte-identical to
   * pre-RFC-075 behavior.
   */
  autoCommitPush: z.boolean().default(false),
  baseCommit: z.string().nullable(),
  status: TaskStatusSchema,
  inputs: z.record(z.string(), z.string()),
  maxDurationMs: z.number().int().nonnegative().nullable(),
  maxTotalTokens: z.number().int().nonnegative().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  errorSummary: z.string().nullable(),
  errorMessage: z.string().nullable(),
  failedNodeId: z.string().nullable(),
  expiresAt: z.number().int().nullable(),
  deletedAt: z.number().int().nullable(),
  schemaVersion: z.number().int(),
  /**
   * RFC-067: per-task Git commit identity. Both NULL → daemon default
   * (legacy behavior, byte-identical to pre-RFC-067). Both set → runner
   * injects `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env at opencode spawn time
   * AND startTask writes `[user]` into the worktree's `.git/config`. XOR
   * rejected at StartTaskSchema superRefine and never persisted.
   */
  gitUserName: z.string().nullable(),
  gitUserEmail: z.string().nullable(),
  /**
   * RFC-066: count of `task_repos` rows for this task. Always ≥ 1. Single
   * repo tasks have value 1 (and `repos` is a length-1 array mirroring the
   * top-level `repoPath` / `worktreePath` / `baseBranch` / `branch` /
   * `baseCommit` / `repoUrl` columns). Multi-repo tasks have value > 1, with
   * `repos` containing all entries sorted by `repoIndex` ascending. The
   * top-level columns continue to mirror `repos[0]` for legacy API callers.
   *
   * Defaulted to 1 / [] here so existing callsites that synthesize a Task
   * row before backend mapping (legacy fixtures, in-flight backend code
   * during PR-A T2/T3/T4) keep parsing. The backend `getTask` mapper always
   * populates both explicitly after PR-A T4 lands.
   */
  repoCount: z.number().int().positive().default(1),
  /** RFC-066: per-repo detail, length == repoCount, sorted by repoIndex asc. */
  repos: z.array(TaskRepoSchema).default([]),
  /**
   * RFC-159: the `scheduled_tasks` id that auto-launched this task (null =
   * manually launched). Lets the UI link a task back to its schedule; a
   * schedule's run history is `GET /api/tasks?scheduledTaskId=`. Optional (like
   * `openAlertCount`) so fixtures predating RFC-159 keep parsing; the backend
   * mapper always populates it (null = manual).
   */
  scheduledTaskId: z.string().nullable().optional(),
  /** RFC-164: owning workgroup id (durable soft link; NULL = not a workgroup task). */
  workgroupId: z.string().nullable().optional(),
  /**
   * RFC-164 follow-up: the owning workgroup's display name, read from the task's
   * OWN frozen `workgroup_config_json` (same task-scoped source the list uses —
   * see `TaskSummary.workgroupName`), NOT a live join on the workgroups resource.
   * NULL for non-workgroup tasks / corrupt config. The detail page shows this +
   * links to `/workgroups/$name` instead of leaking the internal `__workgroup_host__`
   * anchor workflow (whose name is `workflowName`), mirroring the list view.
   */
  workgroupName: z.string().nullable().optional(),
  /**
   * RFC-165: execution-space kind. Defaulted to 'remote' so fixtures predating
   * migration 0085 keep parsing; the backend mapper always populates it.
   */
  spaceKind: SpaceKindSchema.default('remote'),
  /**
   * RFC-165: source agent name for single-agent tasks (durable soft link to
   * `agents.name`, same philosophy as `workgroupId`). NULL for workflow /
   * workgroup tasks.
   */
  sourceAgentName: z.string().nullable().optional(),
})
export type Task = z.infer<typeof TaskSchema>

/** Compact task entry for list pages. */
export const TaskSummarySchema = z.object({
  id: z.string(),
  /** RFC-037: user-supplied display name. */
  name: z.string(),
  workflowId: z.string(),
  /** Joined display name (null when the workflow row no longer exists). */
  workflowName: z.string().nullable(),
  repoPath: z.string(),
  /** RFC-024: provenance URL; null for path-mode tasks. UI must redact before render. */
  repoUrl: z.string().nullable(),
  status: TaskStatusSchema,
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  errorSummary: z.string().nullable(),
  /**
   * RFC-066: surfaced in list view so the UI can render a "N repos" chip
   * without joining `task_repos`. Always ≥ 1. Defaulted to 1 so fixtures
   * predating PR-A T4 keep parsing.
   */
  repoCount: z.number().int().positive().default(1),
  /**
   * RFC-108 T22: count of OPEN lifecycle_alerts for this task, so the list can
   * render a "stuck" badge without a per-row fetch. Optional (the single-task
   * serializers omit it; only the list query populates it) — the UI treats
   * undefined as 0.
   */
  openAlertCount: z.number().int().nonnegative().optional(),
  /** RFC-159: `scheduled_tasks` id that launched this task (null = manual). */
  scheduledTaskId: z.string().nullable().optional(),
  /** RFC-164: owning workgroup id (durable soft link; NULL = not a workgroup task). */
  workgroupId: z.string().nullable().optional(),
  /**
   * RFC-164 follow-up: the owning workgroup's display name, read from the task's
   * OWN frozen `workgroup_config_json` (the same task-scoped source the room
   * serves), NOT a live join on the workgroups resource — so it stays inside the
   * task's membership ACL and never leaks live resource state (RFC-099). NULL for
   * non-workgroup tasks / corrupt config. The list shows this + links to
   * `/workgroups/$name` instead of leaking the internal `__workgroup_host__`
   * anchor workflow (whose name is `workflowName`).
   */
  workgroupName: z.string().nullable().optional(),
  /** RFC-165: execution-space kind (see TaskSchema.spaceKind). */
  spaceKind: SpaceKindSchema.default('remote'),
  /** RFC-165: source agent name for single-agent tasks (null otherwise). */
  sourceAgentName: z.string().nullable().optional(),
})
export type TaskSummary = z.infer<typeof TaskSummarySchema>

/**
 * RFC-165: single derivation point for a task's execution subject. Route
 * guards, list badges, "launch again" deep links and the sync-workflow guard
 * all call this — do NOT scatter `workgroupId !== null` / `sourceAgentName`
 * checks elsewhere (flag-audit "kind scatter" lesson).
 */
export function taskExecutionKind(t: {
  workgroupId?: string | null
  sourceAgentName?: string | null
}): 'workgroup' | 'agent' | 'workflow' {
  if (t.workgroupId != null && t.workgroupId !== '') return 'workgroup'
  if (t.sourceAgentName != null && t.sourceAgentName !== '') return 'agent'
  return 'workflow'
}

/**
 * POST /api/tasks body.
 *
 * RFC-024: `repoPath` and `repoUrl` are mutually exclusive but exactly one
 * is required. `baseBranch` is only required in path mode (preserves legacy
 * launcher behavior); in URL mode the optional `ref` is used instead (falls
 * back to the cached repo's default branch on the server).
 */
export const StartTaskSchema = z
  .object({
    workflowId: z.string().min(1),
    /**
     * RFC-037: user-supplied display name. Required, trimmed, 1..255 chars.
     * Empty / whitespace-only / overlong → 422. No server fallback.
     */
    name: TaskNameSchema,
    /**
     * RFC-165: temporary-space launch. When true the task gets a fresh
     * `git init` scratch repo (empty root commit) as its workspace — no
     * source repo. Mutually exclusive with every repo-source field AND with
     * `workingBranch` / `autoCommitPush` (no remote to push to); enforced in
     * superRefine.
     */
    scratch: z.boolean().optional(),
    /** RFC-024: remote Git URL (SSH / HTTP(S) / file://). Triggers clone-or-reuse. */
    repoUrl: z.string().min(1).optional(),
    /** RFC-024: branch / tag / commit to check out from the cached repo. Optional. */
    ref: z.string().min(1).optional(),
    inputs: z.record(z.string(), z.string()).default({}),
    /** Per-task overrides (settings defaults apply when omitted). */
    maxDurationMs: z.number().int().nonnegative().optional(),
    maxTotalTokens: z.number().int().nonnegative().optional(),
    /**
     * RFC-036 / RFC-099 — initial task users besides the launcher (the
     * launcher is recorded as owner automatically). RFC-099 removed the
     * per-node `assignments` field — POST /api/tasks now rejects payloads
     * still carrying it with 422 `assignments-removed`.
     */
    collaboratorUserIds: z.array(z.string().min(1)).optional(),
    /**
     * RFC-067 — optional per-task Git commit identity. Both must be set
     * together or both omitted (XOR enforced in superRefine). When both set,
     * the runner injects `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` /
     * `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` at opencode spawn time
     * AND the launcher writes `user.name` / `user.email` into the worktree's
     * `.git/config` as a fallback for non-opencode git invocations.
     */
    gitUserName: z.string().min(1).max(255).optional(),
    gitUserEmail: z.string().min(1).max(255).optional(),
    /**
     * RFC-066: multi-repo task launch. Length ∈ [1, MULTI_REPO_MAX]. When
     * present, the legacy top-level `repoPath` / `repoUrl` / `baseBranch` /
     * `ref` fields MUST be absent (mutex enforced in superRefine). Length-1
     * arrays are equivalent to the legacy body and walk the single-repo code
     * path byte-for-byte; length > 1 triggers the multi-repo materialize
     * branch (parent dir + per-repo sub-worktrees under
     * `~/.agent-workflow/worktrees/multi/{taskId}/`).
     */
    repos: z.array(StartTaskRepoSchema).min(1).max(MULTI_REPO_MAX).optional(),
    /**
     * RFC-075 — optional working branch name. Applies to every repo in a
     * multi-repo task. When set, the worktree is checked out on this branch
     * (replacing the default `agent-workflow/{taskId}`), branched off the
     * remote-latest base; an existing branch is reused + base merged in.
     * Omitted → legacy isolation branch, byte-for-byte unchanged.
     */
    workingBranch: z.string().min(1).max(WORKING_BRANCH_MAX).optional(),
    /**
     * RFC-075 — when true, after each writer agent emits its final output the
     * framework commits all changes (LLM-summarized message) and pushes to
     * the working branch (or the isolation branch when no working branch was
     * set). Default false → no commit/push, legacy behavior.
     */
    autoCommitPush: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const hasLegacyUrl = typeof value.repoUrl === 'string' && value.repoUrl.length > 0
    const hasLegacy = hasLegacyUrl
    const hasRepos = Array.isArray(value.repos) && value.repos.length > 0

    // RFC-067: Git identity XOR + format check — runs for EVERY space kind
    // (implementation-gate P2 fix: the scratch early-return below used to
    // skip it, silently accepting half identities on scratch launches; a
    // scratch task's root/agent commits DO consume a supplied identity).
    // Trim before testing so whitespace-only strings can't sneak through.
    // Loose email check: must contain `@`, no whitespace on either side —
    // git itself accepts any `Name <email>` shape, so no TLD/DNS pedantry.
    const trimName = value.gitUserName?.trim() ?? ''
    const trimEmail = value.gitUserEmail?.trim() ?? ''
    const hasName = trimName.length > 0
    const hasEmail = trimEmail.length > 0
    if (hasName !== hasEmail) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'git-identity-incomplete',
        path: hasName ? ['gitUserEmail'] : ['gitUserName'],
      })
    }
    if (hasEmail && !/^[^\s@]+@[^\s@]+$/.test(trimEmail)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'git-identity-email-invalid',
        path: ['gitUserEmail'],
      })
    }

    // RFC-165: scratch ⊕ every repo source. A scratch task has no source repo,
    // no ref, no remote — so workingBranch / autoCommitPush are meaningless
    // and rejected too (schema layer of the two-layer ban; UI hides them).
    if (value.scratch === true) {
      if (hasLegacy || hasRepos || (typeof value.ref === 'string' && value.ref.length > 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scratch-source-conflict',
          path: ['scratch'],
        })
        return
      }
      if (value.workingBranch !== undefined || value.autoCommitPush !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'scratch-remote-only-option',
          path: [value.workingBranch !== undefined ? 'workingBranch' : 'autoCommitPush'],
        })
        return
      }
      return // scratch body is complete — repo-source rules below don't apply.
    }

    // RFC-066: legacy ↔ v2 mutex. Mixed body → reject (caller must pick one).
    if (hasLegacy && hasRepos) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'start-task-source-conflict',
        path: ['repos'],
      })
      return
    }

    // RFC-066/165: at least one source (or scratch) must be provided.
    if (!hasLegacy && !hasRepos) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'start-task-source-required',
        path: ['repos'],
      })
      return
    }

    // RFC-075: loose working-branch format check. Authoritative validation is
    // `git check-ref-format --branch` at materialize time; this catches the
    // obvious illegal shapes (whitespace, `..`, leading/trailing `/`, etc.)
    // before we even spawn git.
    if (typeof value.workingBranch === 'string') {
      const wb = value.workingBranch.trim()
      if (wb.length === 0 || !isLooseValidBranchName(wb)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'working-branch-invalid',
          path: ['workingBranch'],
        })
      }
    }
  })
export type StartTask = z.infer<typeof StartTaskSchema>

/**
 * RFC-165: the space-field subset of a launch body. `applySpaceFields` is the
 * single assembly point for every service-level candidate builder
 * (startWorkgroupTask / startAgentTask) — a schema-only change cannot silently
 * drop a space field again (RFC-125 lesson, workgroup candidate incident F2).
 */
export interface LaunchSpaceFields {
  scratch?: boolean
  repoUrl?: string
  ref?: string
  repos?: StartTaskRepo[]
}

export function applySpaceFields<T extends Record<string, unknown>>(
  candidate: T,
  body: LaunchSpaceFields,
): T & LaunchSpaceFields {
  return {
    ...candidate,
    ...(body.scratch !== undefined ? { scratch: body.scratch } : {}),
    ...(body.repoUrl !== undefined ? { repoUrl: body.repoUrl } : {}),
    ...(body.ref !== undefined ? { ref: body.ref } : {}),
    ...(body.repos !== undefined ? { repos: body.repos } : {}),
  }
}

/**
 * RFC-165: raw-key rejection for retired path-mode fields. StartTaskSchema is
 * a non-strict zod object — unknown keys are silently stripped, so a mixed
 * old/new body like `{scratch:true, repoPath:"…"}` would silently degrade to
 * a scratch launch instead of failing. Every public entrance (JSON, multipart,
 * agent/workgroup launch, scheduled create/update/fire/run-now) MUST call this
 * on the RAW body before zod parsing and 422 on a non-null result. Precedent:
 * the `assignments` raw-key reject in routes/tasks.ts (RFC-099).
 *
 * Returns the offending key path (e.g. `repoPath`, `repos[2].baseBranch`) or
 * null when the body is clean.
 */
export const RETIRED_START_TASK_KEYS = ['repoPath', 'baseBranch', 'fetchBeforeLaunch'] as const

export function rejectRetiredStartTaskKeys(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null
  const body = raw as Record<string, unknown>
  for (const key of RETIRED_START_TASK_KEYS) {
    if (key in body) return key
  }
  const repos = body['repos']
  if (Array.isArray(repos)) {
    for (let i = 0; i < repos.length; i++) {
      const row = repos[i]
      if (row === null || typeof row !== 'object') continue
      for (const key of RETIRED_START_TASK_KEYS) {
        if (key in (row as Record<string, unknown>)) return `repos[${i}].${key}`
      }
    }
  }
  return null
}

/** Filters for GET /api/tasks. */
export const ListTasksQuerySchema = z.object({
  status: TaskStatusSchema.optional(),
  workflowId: z.string().optional(),
  repoPath: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
})
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>

// -----------------------------------------------------------------------------
// node_runs — per-node execution rows. Loop iterations + multi-process fan-out
// + retries all produce additional rows of the same shape. The frontend
// detail view (P-1-18) flattens them into a status table.
// -----------------------------------------------------------------------------

export const NODE_RUN_STATUS = [
  'pending',
  'running',
  'done',
  'failed',
  'canceled',
  'interrupted',
  'skipped',
  'exhausted',
  // RFC-005: review nodes sit here until the user approves/rejects/iterates.
  'awaiting_review',
  // RFC-023: clarify nodes sit here until the user submits answers. The
  // upstream agent that produced <workflow-clarify> is still 'done' — the
  // clarify node, not the agent, is what carries this state.
  'awaiting_human',
] as const
export const NodeRunStatusSchema = z.enum(NODE_RUN_STATUS)
export type NodeRunStatus = z.infer<typeof NodeRunStatusSchema>

/**
 * RFC-098 WP-10 (audit S-25): WHY a node_run row was minted, persisted on
 * `node_runs.rerun_cause` (migration 0044) by the single mint factory
 * (`backend/services/nodeRunMint.ts`). Before this column the scheduler's
 * injection gates had to infer the cause from proxy signals (retryIndex
 * parity, derived clarify generation), which is exactly how the crossClarify
 * "deliberately retryIndex ≥ 1" hack came to exist.
 *
 * Scheduler main-mint merge rule (RFC-098 design 对抗检视修订 #11, pinned by
 * rfc098-rerun-cause-gates.test.ts): when the scheduler mints a fresh
 * top-level agent row, the cause is derived from the freshest existing
 * top-level row (`latestExisting`) at the same (node, iteration):
 *   - undefined                          → 'initial'
 *   - done (stale, upstream advanced)    → 'stale-redispatch'
 *   - failed / interrupted / canceled
 *     / exhausted                        → 'revival'
 *   - awaiting_review / awaiting_human   → 'stale-redispatch' (stale parked
 *     row re-dispatched; the park row itself keeps its own *-park cause)
 *   - pending / running / skipped        → 'stale-redispatch' (defensive —
 *     pending top-level rows are reused, not re-minted; running rows are
 *     never co-dispatched)
 */
export const RERUN_CAUSES = [
  /** First dispatch of a node at this (iteration): no prior top-level row. */
  'initial',
  /** Fresh re-dispatch because the freshest existing row went stale
   *  (upstream advanced) — incl. stale parked awaiting_* rows. */
  'stale-redispatch',
  /** Re-mint over a terminal-failure-family latest row
   *  (failed / interrupted / canceled / exhausted) — resume / RFC-095 revival. */
  'revival',
  /** RFC-042 in-invocation process retry attempt (scheduler retry loop). */
  'process-retry',
  /** RFC-023 self-clarify answer rerun (clarify.ts submitClarifyAnswers). */
  'clarify-answer',
  /** RFC-056 cross-clarify designer update rerun (crossClarify.ts). */
  'cross-clarify-answer',
  /** RFC-056/059 cross-clarify questioner stop / reject / continue rerun. */
  'cross-clarify-questioner-rerun',
  /** RFC-005 review decision=iterated rerun of the source agent. */
  'review-iterate',
  /** RFC-005 review decision=rejected rerun of the source agent. */
  'review-reject',
  /** RFC-005 review node parked at awaiting_review. */
  'review-park',
  /** RFC-023 clarify node parked at awaiting_human. */
  'clarify-park',
  /** RFC-056 cross-clarify node parked at awaiting_human. */
  'cross-clarify-park',
  /** User-picked retryNode target placeholder row (task.ts). */
  'retry-node',
  /** Downstream cascade placeholder minted by retryNode (task.ts). */
  'retry-node-cascade',
  /** Fanout shard child row (scheduler dispatchFanoutShard). */
  'fanout-shard',
  /** Fanout aggregator row (scheduler). */
  'fanout-aggregator',
  /** Wrapper (loop / fanout / git) container fresh-mint. */
  'wrapper-init',
  /** RFC-075 commit&push container row (commitPushRunner). */
  'commit-push',
  /** Commit&push per-session child row (scheduler genViaOpencode). */
  'commit-push-session',
  /** RFC-130 §6.2 built-in merge-conflict resolver child row (scheduler resolveMergeConflicts). */
  'merge-resolve',
  /** Virtual done row for input / output IO nodes. */
  'io-virtual',
  /** Cross-clarify scheduler guard rows (missing-questioner failure /
   *  persistent-stop short-circuit). */
  'cross-clarify-guard',
  /** RFC-164 workgroup leader turn (workgroupRunner). */
  'wg-leader-round',
  /** RFC-164 workgroup member assignment run (workgroupRunner). */
  'wg-assignment',
  /** RFC-164 workgroup assignment-less message-wake turn (workgroupRunner). */
  'wg-message-turn',
  /** RFC-164 free_collab completion-gate holder run (design §8.2). */
  'wg-gate',
  /** RFC-167 dynamic-workflow orchestrator generation run (dynamicWorkflowRunner). */
  'dw-generate',
  /** RFC-167 dynamic-workflow confirm-gate holder run (design §3.1). */
  'dw-gate',
] as const
export const RerunCauseSchema = z.enum(RERUN_CAUSES)
export type RerunCause = z.infer<typeof RerunCauseSchema>

/**
 * RFC-145 — `node_runs.failure_code` (migration 0077): the machine-readable
 * failure taxonomy that used to live as errorMessage PREFIXES parsed by
 * `decideEnvelopeFollowup`'s order-sensitive startsWith chain. The runner now
 * declares the code at each stamp point (producer-side, 7 values);
 * `FOLLOWUP_POLICY` (shared/prompt.ts) projects it onto the 6-value render
 * reason (clarify-forbidden deliberately renders as envelope-missing — the
 * previously implicit downgrade, now explicit in the table).
 *
 * NULL = this row carries no machine-readable failure shape (the common case:
 * most failures are not follow-up-able). errorMessage remains human-readable
 * breadcrumbs only — a source guard forbids machine reads of it.
 *
 * Like RERUN_CAUSES this is a plain nullable TEXT column — the enum is
 * enforced at the TypeScript boundary, not by SQLite.
 */
export const FAILURE_CODES = [
  /** No <workflow-output> envelope in stdout (incl. the output-null defensive branch). */
  'envelope-missing',
  /** Both <workflow-clarify> and <workflow-output> present outside ask-back mode. */
  'clarify-and-output-both',
  /** Clarify envelope present but unparseable — only the `clarify-questions-*`
   *  validator-code family (D8: `clarify-options-*` and other codes stay
   *  unstructured; today's router gives them NO follow-up). */
  'clarify-questions-malformed',
  /** Clarify channel ACTIVE but the agent produced output / both / neither. */
  'clarify-required',
  /** Clarify channel STOPPED but the agent produced another clarify. */
  'clarify-forbidden',
  /** A port opened but its close tag was missing/corrupted. */
  'envelope-port-malformed',
  /** RFC-049 port content validation failed (payload rides in
   *  port_validation_failures_json, NOT in this code). */
  'port-validation-failed',
] as const
export const FailureCodeSchema = z.enum(FAILURE_CODES)
export type FailureCode = z.infer<typeof FailureCodeSchema>

/**
 * RFC-075: metadata recorded on a framework-synthesized commit&push node_run.
 * Non-null presence marks the row as a commit node (the synthetic `nodeId` is
 * `__commit_push__:{agentNodeId}` (+ `:{repoSlug}` in multi-repo); the row's
 * `parentNodeRunId` points at the triggering agent run). The UI renders these
 * rows distinctly and offers a "view session" button.
 */
export const COMMIT_PUSH_OUTCOME = [
  /** commit + push both succeeded */
  'pushed',
  /** push rejected for auth/permission reasons → committed locally, not retried */
  'commit-local-auth',
  /** repair retries exhausted → committed locally, node failed */
  'commit-local-failed',
  /** no net change since the last commit → nothing committed */
  'skipped-empty',
] as const
export const CommitPushOutcomeSchema = z.enum(COMMIT_PUSH_OUTCOME)
export type CommitPushOutcome = z.infer<typeof CommitPushOutcomeSchema>

export const CommitPushMetaSchema = z.object({
  /** Absolute path to the repo worktree this commit row targets. */
  repoPath: z.string(),
  /** Local branch committed on (working branch or `agent-workflow/{taskId}`). */
  repoBranch: z.string(),
  /** Push target, e.g. `origin/<branch>`. */
  pushTarget: z.string(),
  /** Base ref the worktree was branched from. */
  baseRef: z.string(),
  /** Resolved commit SHA, or null when nothing was committed. */
  commitSha: z.string().nullable(),
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** How the commit message was produced. */
  messageSource: z.enum(['llm', 'llm-repair', 'fallback']),
  /** Number of repair-and-repush cycles performed (0 when first push succeeded). */
  repairAttempts: z.number().int().nonnegative(),
  pushOutcome: CommitPushOutcomeSchema,
  /** Redacted push stderr summary, or null. */
  pushError: z.string().nullable(),
})
export type CommitPushMeta = z.infer<typeof CommitPushMetaSchema>

export const NodeRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  nodeId: z.string(),
  parentNodeRunId: z.string().nullable(),
  iteration: z.number().int().nonnegative(),
  shardKey: z.string().nullable(),
  retryIndex: z.number().int().nonnegative(),
  /**
   * RFC-005: bumped each time a review decision (reject/iterate) triggers a
   * regeneration of this node's upstream — decoupled from retryIndex (which
   * counts purely technical retries like process crashes).
   */
  reviewIteration: z.number().int().nonnegative().default(0),
  status: NodeRunStatusSchema,
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  pid: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
  /** RFC-145: structured review-supersede lineage — the frontend canceled-row
   *  classification (rollback vs superseded vs manual) reads these instead of
   *  parsing errorMessage prefixes. */
  supersededByReview: z.enum(['iterated', 'rejected']).nullable().default(null),
  rolledBack: z.boolean().nullable().default(null),
  /** User prompt sent to opencode (populated after runner builds it). */
  promptText: z.string().nullable(),
  tokInput: z.number().int().nullable(),
  tokOutput: z.number().int().nullable(),
  tokTotal: z.number().int().nullable(),
  tokCacheCreate: z.number().int().nullable(),
  tokCacheRead: z.number().int().nullable(),
  /**
   * RFC-026: opencode session id captured from the JSON event stream of this
   * run, when present. Used by the task-detail UI to show a "session=inline"
   * chip on clarify-resume runs (and as a copy-paste handle for local
   * `opencode --session <id>` debugging). NULL when the run never spawned
   * opencode (clarify / review / input / output / wrapper) or when opencode
   * exited before emitting any session event.
   */
  opencodeSessionId: z.string().nullable().default(null),
  /**
   * RFC-046: post-budget-clip snapshot of the approved memories injected into
   * this agent run's inline prompt (the `## Learned context` block produced
   * by `formatMemoryBlock`). NULL for pre-RFC-046 rows, for non-agent kinds
   * that never call inject (input/output/wrapper/review/clarify), and for
   * runs where every scope returned zero memories (block was null — the
   * prompt was byte-for-byte unchanged). For envelope-followup retries
   * (RFC-042), the runner copies this column from the retry_index=0 sibling
   * row so the UI surfaces the same list the model is still seeing in its
   * resumed session. Optional+nullable to keep older API responses parseable.
   */
  injectedMemories: z.array(InjectedMemorySnapshotSchema).nullable().optional(),
  /**
   * RFC-049: structured failures captured when envelope.ts threw
   * PortValidationError for one of this attempt's `markdown_file` (or any
   * future kind's) ports. The scheduler reads this column to route
   * same-session follow-up to the right OutputKindHandler and to compose
   * per-port repair prompt text without re-parsing errorMessage. NULL on
   * successful runs, runs that failed for any non-port-validation reason,
   * and pre-RFC-049 rows.
   */
  portValidationFailures: z
    .array(
      z.object({
        port: z.string(),
        kind: z.string(),
        subReason: z.string(),
        detail: z.string().optional(),
      }),
    )
    .nullable()
    .optional(),
  /**
   * RFC-075: present (non-null) only on framework-synthesized commit&push
   * node_runs. Carries the commit SHA / push outcome / repair count for the
   * detail-page commit row. NULL/absent for every regular node_run and all
   * pre-RFC-075 rows.
   */
  commitPush: CommitPushMetaSchema.nullable().optional(),
  /**
   * RFC-078: for REVIEW node_runs, the time the CURRENT review round's content
   * was produced — derived from the latest pending doc_version's created_at
   * (terminal reviews: the deciding version's created_at). This is the
   * meaningful "review started" anchor; the row's raw startedAt is the slot
   * first-open tick and is never re-stamped across refresh/iterate reuse, so it
   * can predate the reviewed run by hours. NULL/absent for non-review rows and
   * review rows with no doc_version yet (UI falls back to startedAt).
   */
  reviewRoundStartedAt: z.number().int().nullable().optional(),
  /**
   * RFC-078: for REVIEW node_runs, when the current round was decided (the
   * deciding doc_version's decided_at); NULL while awaiting a human decision.
   * Paired with reviewRoundStartedAt to render a meaningful human-review wait
   * time instead of (finishedAt − pinned startedAt).
   */
  reviewDecidedAt: z.number().int().nullable().optional(),
  /**
   * RFC-158: for REVIEW node_runs, the task-detail canvas click target — read-time
   * derived in getTaskNodeRuns from the run's doc_versions (NOT persisted, no
   * migration):
   *   - 'awaiting'  — has a renderable current round AND status='awaiting_review'
   *                   (open the live review界面).
   *   - 'decided'   — has a renderable current round whose representative version
   *                   is a HUMAN conclusion (approve/reject/iterate, non-system);
   *                   the bare /reviews/{run} route replays it.
   *   - null/absent — no renderable round (no doc_version — incl. an empty
   *                   `list<md>` review — or the current round is pending / a
   *                   system-made supersede), OR a non-review run. The canvas
   *                   leaves the node un-clickable so it never routes to a 404 /
   *                   empty decided view. Gated on selectCurrentReviewRound !== null
   *                   so it strictly implies getReviewDetail can render.
   */
  reviewNavKind: z.enum(['awaiting', 'decided']).nullable().optional(),
  /**
   * RFC-161: for clarify / cross-clarify node_runs, the task-detail canvas click
   * target — read-time derived in getTaskNodeRuns from the run's latest
   * clarify_round status (NOT persisted, no migration; see
   * clarifyNavKindForRoundStatus):
   *   - 'awaiting'  — latest round is awaiting_human AND the task is not dead
   *                   (canceled/failed) → open the interactive answer page.
   *   - 'answered'  — latest round is answered → open the read-only echo.
   *   - null/absent — no round (would 404), a canceled/abandoned round, an
   *                   orphaned awaiting on a canceled/failed task, or a
   *                   non-clarify run. The canvas leaves the node un-clickable.
   */
  clarifyNavKind: z.enum(['awaiting', 'answered']).nullable().optional(),
})
export type NodeRun = z.infer<typeof NodeRunSchema>

/** Output ports captured from an envelope. */
export const NodeRunOutputSchema = z.object({
  nodeRunId: z.string(),
  port: z.string(),
  value: z.string(),
  /**
   * RFC-072: resolved AgentOutputKind string at run time (agent.outputKinds[port]),
   * e.g. 'markdown_file' / 'path<md>' / 'markdown'. null/absent for legacy rows
   * or ports whose agent declared no kind. The task-detail Outputs tab uses it to
   * tell file-path ports (whose `value` is a worktree-relative path) from text.
   */
  kind: z.string().nullable().optional(),
})
export type NodeRunOutput = z.infer<typeof NodeRunOutputSchema>

/** Response shape of GET /api/tasks/:id/node-runs. */
export const TaskNodeRunsSchema = z.object({
  runs: z.array(NodeRunSchema),
  outputs: z.array(NodeRunOutputSchema),
})
export type TaskNodeRuns = z.infer<typeof TaskNodeRunsSchema>

/** Response shape of GET /api/tasks/:id/node-runs/:nodeRunId/events. */

export const NODE_EVENT_KIND = [
  'tool_use',
  'text',
  'reasoning',
  'permission_asked',
  'error',
  'step_start',
  'step_finish',
  'stderr',
  // RFC-027: marker written by services/sessionCapture when the
  // post-run opencode SQLite read fails. SessionTab treats it as a
  // captureComplete=false signal for the affected child session.
  'subagent_capture_failed',
  // RFC-034: emitted by services/task.ts when worktree creation succeeded
  // but the post-`worktree add` `submodule update --init --recursive` pass
  // failed. Task continues; agents will see empty submodule directories.
  'submodule_init_failed',
  // RFC-034: emitted when warm-fetch / refresh on a cached repo succeeded but
  // the `submodule sync && update` pass failed.
  'submodule_sync_failed',
] as const

export const NodeRunEventSchema = z.object({
  id: z.number().int(),
  nodeRunId: z.string(),
  ts: z.number().int(),
  kind: z.enum(NODE_EVENT_KIND),
  payload: z.unknown(),
})
export type NodeRunEvent = z.infer<typeof NodeRunEventSchema>

export const NodeRunEventsResponseSchema = z.object({
  events: z.array(NodeRunEventSchema),
  /** Highest event id in this batch (or null when empty). */
  cursor: z.number().int().nullable(),
})
export type NodeRunEventsResponse = z.infer<typeof NodeRunEventsResponseSchema>

/** Response shape of GET /api/tasks/:id/diff. */
export const TaskDiffSchema = z.object({
  /** Empty string when nothing has changed since the worktree was created. */
  diff: z.string(),
  /** baseCommit used; null when the task failed before worktree creation. */
  baseCommit: z.string().nullable(),
  /** True when diff was truncated for transport. v1 caps at 1 MiB. */
  truncated: z.boolean(),
})
export type TaskDiff = z.infer<typeof TaskDiffSchema>

/**
 * RFC-109 — `POST /api/tasks/:id/sync-workflow` body. `expectedVersion` is the
 * `latestVersion` the user saw in the preview; the server rejects with
 * `workflow-sync-preview-stale` if the live workflow advanced since (TOCTOU).
 */
export const SyncWorkflowBodySchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
})
export type SyncWorkflowBody = z.infer<typeof SyncWorkflowBodySchema>

// ---------------------------------------------------------------------------
// RFC-165 §4 — single-agent launch (POST /api/agents/:name/tasks)
// ---------------------------------------------------------------------------

/**
 * Single-agent launch body. Deliberately SHAPE-lenient like
 * StartWorkgroupTaskSchema: the service composes a full StartTask candidate
 * around the builtin `__agent_host__` workflow (inputs = {description}) and
 * runs StartTaskSchema on it, so repo-source cross-field rules stay
 * single-sourced above. `description` becomes the agent's task prompt via the
 * host snapshot's `{{description}}` template (port-injected — a literal
 * `{{...}}` in the text is never re-expanded).
 */
export const StartAgentTaskSchema = z.object({
  name: z.string().trim().min(1).max(255),
  /** The task prompt for the agent (proposal: 描述即提示词). */
  description: z.string().trim().min(1).max(65536),
  /**
   * RFC-165 D7: whether the host snapshot wires an OPTIONAL clarify channel
   * (the agent may ask the user questions before/instead of finishing).
   * Default ON; false ⇒ no clarify node at all.
   */
  allowClarify: z.boolean().default(true),
  /** RFC-165: temporary-space launch (see StartTaskSchema.scratch). */
  scratch: z.boolean().optional(),
  repoUrl: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  repos: z.array(z.unknown()).min(1).max(16).optional(),
  collaboratorUserIds: z.array(z.string().min(1)).max(64).optional(),
  gitUserName: z.string().max(255).optional(),
  gitUserEmail: z.string().max(255).optional(),
  workingBranch: z.string().optional(),
  autoCommitPush: z.boolean().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
})
export type StartAgentTask = z.infer<typeof StartAgentTaskSchema>
