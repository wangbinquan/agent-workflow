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
})
export type TaskSummary = z.infer<typeof TaskSummarySchema>

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
    repoPath: z.string().min(1).optional(),
    baseBranch: z.string().min(1).optional(),
    /** RFC-024: remote Git URL (SSH or HTTP/HTTPS). Triggers clone-or-reuse. */
    repoUrl: z.string().min(1).optional(),
    /** RFC-024: branch / tag / commit to check out from the cached repo. Optional. */
    ref: z.string().min(1).optional(),
    inputs: z.record(z.string(), z.string()).default({}),
    /** Per-task overrides (settings defaults apply when omitted). */
    maxDurationMs: z.number().int().nonnegative().optional(),
    maxTotalTokens: z.number().int().nonnegative().optional(),
    /**
     * RFC-036 — optional per-node reviewer / clarify_target assignments
     * recorded at launch time. Each entry's `nodeId` must exist in the
     * workflow definition and its kind must match the node's runtime kind.
     */
    assignments: z
      .array(
        z.object({
          nodeId: z.string().min(1),
          kind: z.enum(['reviewer', 'clarify_target']),
          userId: z.string().min(1),
        }),
      )
      .optional(),
    /**
     * RFC-036 — additional collaborator user IDs (besides the launcher).
     * Owner / reviewer / clarify_target are recorded automatically; this
     * field is for "share with me" peers without an assignment role.
     */
    collaboratorUserIds: z.array(z.string().min(1)).optional(),
  })
  .superRefine((value, ctx) => {
    const hasPath = typeof value.repoPath === 'string' && value.repoPath.length > 0
    const hasUrl = typeof value.repoUrl === 'string' && value.repoUrl.length > 0
    if (hasPath && hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'repoPath and repoUrl are mutually exclusive',
        path: ['repoUrl'],
      })
    }
    if (!hasPath && !hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'one of repoPath or repoUrl is required',
        path: ['repoPath'],
      })
    }
    if (hasPath && (!value.baseBranch || value.baseBranch.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'baseBranch is required in path mode',
        path: ['baseBranch'],
      })
    }
  })
export type StartTask = z.infer<typeof StartTaskSchema>

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
  /**
   * RFC-023: bumped each time the user submits clarify answers and the agent
   * is re-spawned for another round. Orthogonal to retryIndex (technical
   * retries) and reviewIteration (post-output review rounds). For an
   * agent-multi shard child node_run, the value is per-shard.
   */
  clarifyIteration: z.number().int().nonnegative().default(0),
  status: NodeRunStatusSchema,
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
  pid: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  errorMessage: z.string().nullable(),
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
})
export type NodeRun = z.infer<typeof NodeRunSchema>

/** Output ports captured from an envelope. */
export const NodeRunOutputSchema = z.object({
  nodeRunId: z.string(),
  port: z.string(),
  value: z.string(),
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
