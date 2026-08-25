// RFC-247 §4.2 — the MCP tool set.
//
// One declarative table. A tool names the permission points it needs, and
// `tools/list` filtering, the pre-call check and the generated documentation
// all read that same field — the `RouteMeta` discipline applied to the second
// channel, for the same reason: a capability list that is written twice is a
// capability list that disagrees with itself.
//
// Every handler goes through `Dispatcher`, i.e. through the REST route table.
// Tools do not touch services directly (see dispatch.ts for why).
//
// ## Why named task tools but converged resource tools (D11)
//
// The task domain is where a model spends its time and where mistakes are
// expensive, so those verbs are spelled out: `launch_task`, `cancel_task`,
// `retry_node` each carry their own description, their own argument names, and
// their own warnings. The resource domain is broad, uniform, and mostly CRUD;
// eleven resource types × four verbs as named tools would be 44 entries whose
// descriptions differ only in a noun, drowning the task tools that matter.
// `resource_read` / `resource_write` take `kind` + `method` instead, and
// `describe_resource` hands back the schema for a kind on request.

import { z } from 'zod'
import {
  type MatrixResource,
  type Permission,
  REVIEW_ANCHOR_QUOTE_MAX_CHARS,
  REVIEW_ANCHOR_SECTION_MAX_CHARS,
  REVIEW_COMMENT_TEXT_MAX_CHARS,
  REVIEW_DECISION_BATCH_COMMENTS_MAX,
  REVIEW_DECISION_BATCH_SELECTIONS_MAX,
  REVIEW_LIST_STATUS,
  ReviewBatchSelectionSchema,
  ReviewDecisionKindSchema,
  type Role,
  type StartTaskSchema,
  type SubmitReviewDecisionSchema,
  type WorkflowInput,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DispatchResult, Dispatcher } from '@/mcp/dispatch'
import { bodySchemasFor, querySchemaFor, type ResourceBodySchemas } from '@/mcp/resourceSchemas'

export interface McpToolContext {
  readonly actor: Actor
  readonly dispatch: (req: Parameters<Dispatcher>[0]) => Promise<DispatchResult>
  /** Progress heartbeat; a no-op when the client sent no progressToken. */
  readonly progress: (message: string) => Promise<void>
  readonly signal: AbortSignal
}

export interface McpToolDef {
  readonly name: string
  readonly title: string
  readonly description: string
  /**
   * Points required to CALL the tool, ANDed. Empty means "reads", which every
   * valid token has (D3) — those tools are always listed.
   */
  readonly permissions: ReadonlyArray<Permission>
  readonly inputSchema: z.ZodRawShape
  readonly handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<unknown>
  /**
   * RFC-326 (P7) — what the audit row should name for this call. The converged
   * resource tools carry `kind` / `id` in their arguments and need nothing here;
   * a named tool whose identity lives under another argument name (the review
   * tools: `nodeRunId`) declares it, so `token_audit.resource_kind/id` stop being
   * blank for every call on a human gate.
   */
  readonly audit?: (args: Record<string, unknown>) => { kind: string; id?: string }
}

// -----------------------------------------------------------------------------
// Shared argument fragments
// -----------------------------------------------------------------------------

const taskId = z.string().min(1).describe('Task id (ULID), as returned by launch_task/list_tasks')

/**
 * Encode one path segment before it is interpolated into a dispatch URL.
 *
 * Tool arguments are model-supplied. Without this, `get_task({id:"../workflows"})`
 * builds `/api/tasks/../workflows`, which WHATWG URL normalisation collapses to
 * `/api/workflows` — a DIFFERENT endpoint from the one the tool declared. The
 * target route's own gate still runs, so this cannot exceed the token's matrix,
 * but it breaks two things that do matter: the audit row still says `get_task`,
 * and `tools/list` stops describing what a tool can actually reach.
 *
 * The converged tools already did this inside `fillId`; the named tools did not.
 * One helper now, used by both, so they cannot drift apart again.
 */
function enc(value: unknown): string {
  return encodeURIComponent(String(value))
}

/** Everything a dispatch answer needs to become a tool result. */
function unwrap(res: DispatchResult): unknown {
  if (res.status >= 400) throw new McpCallError(res)
  return res.body
}

/**
 * A business refusal, carrying the code the REST channel would have returned.
 * `details` is deliberately dropped — it can hold internal structure (row ids,
 * file paths, actor permission dumps) that has no place in a model's context.
 */
export class McpCallError extends Error {
  readonly status: number
  readonly code: string
  constructor(res: DispatchResult) {
    // The daemon's error envelope is FLAT — `{ok:false, code, message, details}`
    // (util/errors.ts `toPayload`), not `{error:{…}}`. Reading the wrong shape
    // would degrade every business refusal to a generic "request failed",
    // throwing away the one part a model can act on.
    const body = res.body as { code?: string; message?: string } | null
    const code = body?.code ?? 'error'
    const message = body?.message ?? `request failed with status ${res.status}`
    super(message)
    this.name = 'McpCallError'
    this.status = res.status
    this.code = code
  }
}

// -----------------------------------------------------------------------------
// Task domain (D11 — named tools)
// -----------------------------------------------------------------------------

// RFC-284 T28 —— launch_task 入参与 shared StartTaskSchema 的键集镜像断言：
// satisfies 限定每个键必须是 StartTaskSchema 的合法键（发明 `repoId` 这类不存在
// 的字段名 = 编译期红）。requiredness 与语义仍以下方 describe/zod 定义为准；
// 键集是此前唯一靠注释维系、实际漂移过的轴（首版漏掉预算/协作者/多仓字段）。
const LAUNCH_TASK_INPUT_SCHEMA = {
  workflowId: z.string().min(1).describe('Workflow id to run'),
  name: z.string().min(1).max(255).describe('Task name — required, shown in every list'),
  cachedRepoId: z
    .string()
    .min(1)
    .optional()
    .describe('Imported repo to run against (resource_read kind="repos" lists them)'),
  repoUrl: z
    .string()
    .min(1)
    .optional()
    .describe('Remote git URL, as an alternative to cachedRepoId'),
  ref: z.string().min(1).optional().describe('Branch, tag or commit to start from'),
  scratch: z
    .boolean()
    .optional()
    .describe('Run in a fresh empty git repo instead of a source repo; excludes every repo field'),
  inputs: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Workflow input values, keyed by the port KEY. Read them first with ' +
        'resource_read(kind="workflows", method="get"): `definition.inputs[]` gives each ' +
        'key, label, kind and whether it is required. `files` and `enum` values use a ' +
        'packed multi-line encoding — copy the shape the workflow documents.',
    ),
  workingBranch: z.string().min(1).optional(),
  autoCommitPush: z.boolean().optional().describe('Commit and push after each writer node'),
  // MCP tool inputs are a CLOSED schema — a field not listed here can never
  // reach the route, whatever the caller sends. The first version stopped
  // after `autoCommitPush`, which silently made the per-task budgets,
  // collaborators, git identity and multi-repo launches unreachable over
  // MCP even though the route accepts them all. RFC-320 removed client-owned
  // Git identity from every launch surface; it is intentionally absent here.
  maxDurationMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Per-task wall-clock budget; falls back to the global setting'),
  maxTotalTokens: z.number().int().nonnegative().optional(),
  collaboratorUserIds: z
    .array(z.string().min(1))
    .optional()
    .describe('Users added alongside the launcher (who becomes owner)'),
  expectedWorkflowVersion: z
    .number()
    .int()
    .optional()
    .describe('Refuse (409) if the workflow changed since you read it'),
  repoGroupId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Multi-repo launch: run in a repo group's materialized layout. " +
        'Mutually exclusive with the top-level repo fields. RFC-248 retired the ' +
        'old inline `repos[]` array — passing it now fails with 422. ' +
        'See resource_read(kind="repo-groups") for available groups.',
    ),
} satisfies Partial<Record<keyof z.input<typeof StartTaskSchema>, z.ZodTypeAny>>

const TASK_TOOLS: ReadonlyArray<McpToolDef> = [
  {
    name: 'launch_task',
    title: 'Launch a task',
    description:
      'Start a workflow run. Creates a git worktree from the chosen base branch and executes the workflow. ' +
      'Returns immediately with the task id — use watch_task or get_task to follow it. ' +
      'Workflows that declare an upload input cannot be launched over MCP (files have no representation here).',
    permissions: ['tasks:execute'],
    // Field names and requiredness mirror StartTaskSchema exactly. Getting
    // `name` wrong (it is required, with no server fallback) or inventing a
    // `repoId` would 422 every call with a schema error the model cannot act on.
    inputSchema: LAUNCH_TASK_INPUT_SCHEMA,
    handler: async (args, ctx) => {
      await assertNoUploadInputs(String(args.workflowId), ctx)
      return unwrap(await ctx.dispatch({ method: 'POST', path: '/api/tasks', body: args }))
    },
  },
  {
    name: 'get_task',
    title: 'Get a task',
    description: 'Full state of one task: status, node runs, timing, and any alerts.',
    permissions: [],
    inputSchema: { id: taskId },
    handler: async (args, ctx) =>
      unwrap(await ctx.dispatch({ method: 'GET', path: `/api/tasks/${enc(args.id)}` })),
  },
  {
    name: 'list_tasks',
    title: 'List tasks',
    description:
      'Tasks visible to this token. Scope depends on the account: most users see the tasks they own or collaborate on.',
    permissions: [],
    inputSchema: {
      status: z.string().optional().describe('Filter by task status'),
      limit: z.number().int().positive().max(200).optional(),
    },
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'GET',
          path: '/api/tasks',
          query: {
            status: args.status === undefined ? undefined : String(args.status),
            limit: args.limit === undefined ? undefined : String(args.limit),
          },
        }),
      ),
  },
  {
    name: 'watch_task',
    title: 'Wait for a task to settle',
    description:
      'Block until the task finishes, fails, is cancelled, or stops for human input — up to 240 seconds. ' +
      'Sends a progress heartbeat while it waits. If the cap is reached the call returns normally with ' +
      '`stillRunning: true` and the latest snapshot; call it again to keep waiting.',
    permissions: [],
    inputSchema: { id: taskId },
    handler: async (args, ctx) => {
      const { watchTask } = await import('@/mcp/watch')
      return watchTask(String(args.id), ctx)
    },
  },
  {
    name: 'get_task_diff',
    title: 'Get a task diff',
    description:
      "The task's accumulated worktree diff, including uncommitted changes. This is what a Code → Audit → Fix workflow passes between its stages.",
    permissions: [],
    inputSchema: { id: taskId },
    handler: async (args, ctx) =>
      unwrap(await ctx.dispatch({ method: 'GET', path: `/api/tasks/${enc(args.id)}/diff` })),
  },
  {
    name: 'list_node_runs',
    title: 'List node runs',
    description:
      'Per-node execution records for a task, including retries (each retry is its own run).',
    permissions: [],
    inputSchema: { id: taskId },
    handler: async (args, ctx) =>
      unwrap(await ctx.dispatch({ method: 'GET', path: `/api/tasks/${enc(args.id)}/node-runs` })),
  },
  {
    name: 'cancel_task',
    title: 'Cancel a task',
    description:
      'Stop a running task. The worktree is KEPT, so the work done so far stays inspectable and the task can be resumed.',
    permissions: ['tasks:execute'],
    inputSchema: { id: taskId },
    handler: async (args, ctx) =>
      unwrap(await ctx.dispatch({ method: 'POST', path: `/api/tasks/${enc(args.id)}/cancel` })),
  },
  {
    name: 'retry_node',
    title: 'Retry one node',
    description:
      "Re-run a single node. IMPORTANT: this rolls the worktree back to that node's pre-run snapshot, " +
      'and by default cascades — every downstream node re-runs too, discarding their results. ' +
      'The retry becomes a new node run rather than overwriting the old one.',
    permissions: ['tasks:execute'],
    inputSchema: {
      id: taskId,
      nodeRunId: z.string().min(1).describe('Node run id from list_node_runs'),
    },
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'POST',
          path: `/api/tasks/${enc(args.id)}/nodes/${enc(args.nodeRunId)}/retry`,
        }),
      ),
  },
  {
    name: 'resume_task',
    title: 'Resume a task',
    description:
      'Resume a task that was cancelled or interrupted by a daemon restart. Retried nodes roll back to their pre-run snapshot.',
    permissions: ['tasks:execute'],
    inputSchema: { id: taskId },
    handler: async (args, ctx) =>
      unwrap(await ctx.dispatch({ method: 'POST', path: `/api/tasks/${enc(args.id)}/resume` })),
  },
  {
    name: 'diagnose_task',
    title: 'Diagnose a failing task',
    description: 'Run the built-in diagnosis for a failed or stuck task and return its findings.',
    permissions: ['tasks:execute'],
    inputSchema: { id: taskId },
    handler: async (args, ctx) =>
      unwrap(await ctx.dispatch({ method: 'POST', path: `/api/tasks/${enc(args.id)}/diagnose` })),
  },
  {
    name: 'repair_alert',
    title: 'Apply a repair option to an alert',
    description:
      'Apply one of the repair options a task alert offers. Call get_task first to read the alert and its options.',
    permissions: ['tasks:execute'],
    inputSchema: {
      id: taskId,
      alertId: z.string().min(1),
      optionId: z
        .string()
        .min(1)
        .describe('Repair option id — from list_repair_options on this alert'),
      confirm: z
        .literal(true)
        .describe('Must be true; a repair mutates the run, so the route demands an explicit ack'),
    },
    // Field names mirror `RepairRequestSchema` exactly. The first version sent
    // `{ option }`, which the route rejected on EVERY call — the tool advertised
    // an operation that had never once worked.
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'POST',
          path: `/api/tasks/${enc(args.id)}/alerts/${enc(args.alertId)}/repair`,
          body: { optionId: args.optionId, confirm: args.confirm },
        }),
      ),
  },
  {
    name: 'list_repair_options',
    title: 'List repair options for an alert',
    description:
      'The repair options a task alert offers, with their ids. repair_alert needs one of these ids — ' +
      'without this tool an MCP-only caller has no way to obtain one.',
    permissions: [],
    inputSchema: { id: taskId, alertId: z.string().min(1) },
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'GET',
          path: `/api/tasks/${enc(args.id)}/alerts/${enc(args.alertId)}/repair-options`,
        }),
      ),
  },
  {
    name: 'delete_task',
    title: 'Delete a task',
    description:
      'Permanently delete a task and its worktree. Irreversible. Requires the task name as confirmation, ' +
      'exactly as the web UI does — pass it in `confirm`.',
    permissions: ['tasks:delete'],
    inputSchema: {
      id: taskId,
      confirm: z.string().min(1).describe('The exact task name, to confirm the deletion'),
    },
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'DELETE',
          path: `/api/tasks/${enc(args.id)}`,
          body: { confirm: args.confirm },
        }),
      ),
  },
]

/**
 * RFC-247 AC-17 — refuse an upload-input workflow BEFORE anything is created.
 *
 * Upload inputs arrive over multipart and are written into the worktree; MCP
 * has no representation for a file, so such a launch cannot succeed. Checking
 * here rather than letting the route fail keeps the promise that matters: no
 * task row, no worktree, nothing to clean up.
 */
async function assertNoUploadInputs(workflowId: string, ctx: McpToolContext): Promise<void> {
  const res = await ctx.dispatch({ method: 'GET', path: `/api/workflows/${enc(workflowId)}` })
  if (res.status >= 400) throw new McpCallError(res)
  // `WorkflowInput` identifies a port by `key`, NOT `name` — an earlier version
  // read `.name`, so every refusal said "(?)" and the caller could not tell
  // which input was the problem. Typing against the shared schema here is what
  // makes the field name checkable instead of a string nobody re-reads.
  const inputs = (res.body as { definition?: { inputs?: WorkflowInput[] } })?.definition?.inputs
  const uploads = (inputs ?? []).filter((i) => i.kind === 'upload').map((i) => i.key)
  if (uploads.length > 0) {
    throw new Error(
      `this workflow takes file uploads (${uploads.join(', ')}), which cannot be supplied over MCP — ` +
        'launch it from the web UI instead. Every other input kind (text / enum / git / files) ' +
        'can be passed through `inputs`.',
    )
  }
}

// -----------------------------------------------------------------------------
// Human gates (D11 T18) — the moments a run stops and waits for a person
// -----------------------------------------------------------------------------

// RFC-326 — the review gate is a complete surface over MCP: every
// `/api/reviews*` route has a named tool (the two-way guard in
// tests/architecture/rfc326-review-tool-route-guard.test.ts pins it, with
// `EXEMPT_REVIEW_ROUTES` naming the deliberate exceptions). Anchors are the
// simplified locator resolved server-side (design §2); writes carry the same
// wire shape as the REST route they dispatch to, so the service's refusals
// (candidates for an ambiguous quote, the missing-document rule of a
// multi-document round) reach the model verbatim through McpCallError.

const reviewNodeRunId = z
  .string()
  .min(1)
  .describe('Review node run id — the `nodeRunId` from list_pending_gates / list_reviews')

const reviewAudit = (args: Record<string, unknown>): { kind: string; id?: string } => ({
  kind: 'reviews',
  ...(typeof args.nodeRunId === 'string' && args.nodeRunId !== '' ? { id: args.nodeRunId } : {}),
})

/** The simplified locator (design §2.1) as tool arguments; all absent = document-level. */
const REVIEW_LOCATOR_INPUT_SCHEMA = {
  quote: z
    .string()
    .trim()
    .min(1)
    .max(REVIEW_ANCHOR_QUOTE_MAX_CHARS)
    .optional()
    .describe(
      'Verbatim text copied from the document body (markdown markers included, e.g. the backticks of inline code). ' +
        'Omit every locator field to attach the comment to the document as a whole (its title line).',
    ),
  occurrence: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      '1-based occurrence number of `quote` counted over the WHOLE document (non-overlapping). ' +
        'Required only when the quote is ambiguous — the refusal lists every candidate with this number.',
    ),
  section: z
    .string()
    .trim()
    .min(1)
    .max(REVIEW_ANCHOR_SECTION_MAX_CHARS)
    .optional()
    .describe(
      'Narrow the quote to one section: a heading text, a `#`-prefixed breadcrumb segment, or the full ' +
        '`# A > ## B` breadcrumb. The refusal names the sections the quote does occur under.',
    ),
  docVersionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Which document, in a multi-document round (get_review lists them under `documents`). ' +
        'REQUIRED there — even for a one-item round. On a single-document review it is optional, ' +
        'but if you do pass one it must be THAT document: a value naming any other pending ' +
        'document is refused (404 doc-version-not-found), not ignored.',
    ),
}

const REVIEW_COMMENT_TEXT = z
  .string()
  .min(1)
  .max(REVIEW_COMMENT_TEXT_MAX_CHARS)
  .describe('The comment body (markdown)')

/**
 * RFC-284 T28 discipline (see LAUNCH_TASK_INPUT_SCHEMA): the key set mirrors the
 * shared SubmitReviewDecisionSchema plus the tool's own `nodeRunId`, so a wire
 * key renamed in shared is a compile error here — the `decision` enum drifted
 * once (`iterate` vs the REST `iterated`) and made iterate-over-MCP impossible.
 */
const SUBMIT_REVIEW_INPUT_SCHEMA = {
  nodeRunId: reviewNodeRunId,
  decision: ReviewDecisionKindSchema.describe(
    'approved | iterated | rejected — the same values the REST route accepts (`iterate` is not one)',
  ),
  rejectReason: z.string().min(1).optional().describe('Required when decision is "rejected"'),
  reviewIteration: z
    .number()
    .int()
    .nonnegative()
    .describe('The `reviewIteration` get_review returned; a stale value is refused with 409'),
  comments: z
    .array(
      z.object({
        commentText: REVIEW_COMMENT_TEXT,
        ...REVIEW_LOCATOR_INPUT_SCHEMA,
      }),
    )
    .max(REVIEW_DECISION_BATCH_COMMENTS_MAX)
    .optional()
    .describe(
      'Comments written in the SAME transaction as the decision (same fields as add_review_comment). ' +
        'One invalid anchor refuses the whole call and nothing is written.',
    ),
  selections: z
    .array(ReviewBatchSelectionSchema)
    .max(REVIEW_DECISION_BATCH_SELECTIONS_MAX)
    .optional()
    .describe(
      'Multi-document rounds: accept / reject individual documents in the same transaction. ' +
        '`approved` requires every document to be decided (here or earlier).',
    ),
} satisfies Record<keyof z.input<typeof SubmitReviewDecisionSchema> | 'nodeRunId', z.ZodTypeAny>

const GATE_TOOLS: ReadonlyArray<McpToolDef> = [
  {
    name: 'list_pending_gates',
    title: 'List everything waiting on a human',
    description:
      'Tasks stopped at a review or a clarifying question. These are the runs that will not move on their own — ' +
      'watch_task returns as soon as one reaches this state.',
    permissions: [],
    inputSchema: {},
    audit: () => ({ kind: 'human-gates' }),
    handler: async (_args, ctx) => {
      const [reviews, clarify] = await Promise.all([
        ctx.dispatch({ method: 'GET', path: '/api/reviews' }),
        ctx.dispatch({ method: 'GET', path: '/api/clarify' }),
      ])
      return { reviews: unwrap(reviews), clarify: unwrap(clarify) }
    },
  },
  {
    name: 'get_clarify_session',
    title: 'Read a clarifying question round',
    description:
      'The questions a node is waiting on, plus the current `iterationIndex` — pass that back to answer_clarify ' +
      'so a concurrent answer from someone else is detected instead of overwritten.',
    permissions: [],
    inputSchema: { nodeRunId: z.string().min(1) },
    handler: async (args, ctx) =>
      unwrap(await ctx.dispatch({ method: 'GET', path: `/api/clarify/${enc(args.nodeRunId)}` })),
  },
  {
    name: 'answer_clarify',
    title: 'Answer clarifying questions',
    description:
      'Submit answers and let the task continue. Include `ifMatchIteration` from get_clarify_session: without it, ' +
      'two answerers can silently overwrite each other. `directive: "stop"` answers and asks for no further rounds.',
    permissions: ['tasks:execute'],
    inputSchema: {
      nodeRunId: z.string().min(1),
      answers: z
        .array(z.record(z.string(), z.unknown()))
        .describe('One entry per question — see get_clarify_session for their shape'),
      ifMatchIteration: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('The iterationIndex you read; mismatched answers are refused with 412'),
      directive: z.enum(['continue', 'stop']).optional(),
    },
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'POST',
          path: `/api/clarify/${enc(args.nodeRunId)}/answers`,
          body: {
            answers: args.answers,
            ifMatchIteration: args.ifMatchIteration,
            directive: args.directive,
          },
        }),
      ),
  },
  {
    name: 'list_reviews',
    title: 'List reviews, pending or decided',
    description:
      'Reviews across tasks, filtered by status (pending by default; `all`, `approved`, `rejected`, `iterated`), ' +
      'task or workflow. Use it to find the review of a specific task, including ones already decided; ' +
      'list_pending_gates is the shortcut for "everything waiting on me right now".',
    permissions: [],
    inputSchema: {
      status: z.enum(REVIEW_LIST_STATUS).optional().describe('Default: pending'),
      taskId: z.string().min(1).optional(),
      workflowId: z.string().min(1).optional(),
      limit: z.number().int().positive().max(500).optional().describe('Default 100, max 500'),
    },
    audit: () => ({ kind: 'reviews' }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'GET',
          path: '/api/reviews',
          query: {
            status: typeof args.status === 'string' ? args.status : undefined,
            taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
            workflowId: typeof args.workflowId === 'string' ? args.workflowId : undefined,
            limit: typeof args.limit === 'number' ? String(args.limit) : undefined,
          },
        }),
      ),
  },
  {
    name: 'get_review',
    title: 'Read a pending review',
    description:
      'The document awaiting review (`currentBody`), its comments so far and the current `reviewIteration` — ' +
      'pass that back to submit_review. In a multi-document round `currentBody` is only the FIRST document: ' +
      '`documents[]` lists every item with its `docVersionId`; read the others with get_review_document.',
    permissions: [],
    inputSchema: { nodeRunId: reviewNodeRunId },
    audit: reviewAudit,
    handler: async (args, ctx) =>
      unwrap(await ctx.dispatch({ method: 'GET', path: `/api/reviews/${enc(args.nodeRunId)}` })),
  },
  {
    name: 'get_review_document',
    title: 'Read one review document version',
    description:
      'The full body of one document of a review — any item of a multi-document round, or any earlier version ' +
      'from list_review_history — together with the comments that were attached to it at the time.',
    permissions: [],
    inputSchema: {
      nodeRunId: reviewNodeRunId,
      docVersionId: z
        .string()
        .min(1)
        .describe('A `docVersionId` from get_review or list_review_history'),
    },
    audit: reviewAudit,
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'GET',
          path: `/api/reviews/${enc(args.nodeRunId)}/versions/${enc(args.docVersionId)}`,
        }),
      ),
  },
  {
    name: 'list_review_history',
    title: 'List the earlier versions and rounds of a review',
    description:
      'Every document version this review has seen (each with its decision and archived comments) and, for ' +
      'multi-document reviews, the per-round grouping. Read a version body with get_review_document.',
    permissions: [],
    inputSchema: { nodeRunId: reviewNodeRunId },
    audit: reviewAudit,
    handler: async (args, ctx) => {
      const base = `/api/reviews/${enc(args.nodeRunId)}`
      const [versions, rounds] = await Promise.all([
        ctx.dispatch({ method: 'GET', path: `${base}/versions` }),
        ctx.dispatch({ method: 'GET', path: `${base}/rounds` }),
      ])
      return { versions: unwrap(versions), rounds: unwrap(rounds) }
    },
  },
  {
    name: 'add_review_comment',
    title: 'Comment on a passage of a review document',
    description:
      'Attach a comment to a passage. Locate it by copying the text VERBATIM from the document body into `quote` ' +
      '(markdown markers included); add `occurrence` (the global 1-based number) or `section` when the quote ' +
      'is ambiguous — the refusal lists the candidates. No locator at all = a document-level comment on the ' +
      'title. A multi-document round requires `docVersionId`. The response carries `warnings` when the quote sits ' +
      'in a code block, spans blocks, or lies in a link target / HTML comment (then the web page cannot ' +
      'highlight it, though the comment still counts).',
    permissions: ['tasks:execute'],
    inputSchema: {
      nodeRunId: reviewNodeRunId,
      commentText: REVIEW_COMMENT_TEXT,
      ...REVIEW_LOCATOR_INPUT_SCHEMA,
    },
    audit: reviewAudit,
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'POST',
          path: `/api/reviews/${enc(args.nodeRunId)}/comments`,
          body: {
            commentText: args.commentText,
            quote: args.quote,
            occurrence: args.occurrence,
            section: args.section,
            docVersionId: args.docVersionId,
          },
        }),
      ),
  },
  {
    name: 'update_review_comment',
    title: 'Edit the text of a review comment',
    description:
      'Replace the body of a comment while the review is still pending. Only the author may edit it ' +
      '(the task owner and administrators excepted); the anchor is kept as it was.',
    permissions: ['tasks:execute'],
    inputSchema: {
      nodeRunId: reviewNodeRunId,
      commentId: z.string().min(1).describe('The comment `id` from get_review'),
      commentText: REVIEW_COMMENT_TEXT,
    },
    audit: reviewAudit,
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'PATCH',
          path: `/api/reviews/${enc(args.nodeRunId)}/comments/${enc(args.commentId)}`,
          body: { commentText: args.commentText },
        }),
      ),
  },
  {
    name: 'delete_review_comment',
    title: 'Delete a review comment',
    description:
      'Remove a comment from a pending review. Only the author may delete it (the task owner and ' +
      'administrators excepted). Comments already archived by a decision cannot be deleted.',
    permissions: ['tasks:execute'],
    inputSchema: {
      nodeRunId: reviewNodeRunId,
      commentId: z.string().min(1).describe('The comment `id` from get_review'),
    },
    audit: reviewAudit,
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'DELETE',
          path: `/api/reviews/${enc(args.nodeRunId)}/comments/${enc(args.commentId)}`,
        }),
      ),
  },
  {
    name: 'set_review_document_selection',
    title: 'Accept or reject one document of a multi-document review',
    description:
      'Multi-document rounds only: mark one document `accepted` or `not_accepted`. This does not advance the ' +
      'task — submit_review does, and `approved` needs every document decided. The same choice can ride on ' +
      'submit_review as `selections[]` in one transaction.',
    permissions: ['tasks:execute'],
    inputSchema: {
      nodeRunId: reviewNodeRunId,
      docVersionId: z.string().min(1).describe('A `docVersionId` from get_review'),
      selection: z.enum(['accepted', 'not_accepted']),
    },
    audit: reviewAudit,
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'PATCH',
          path: `/api/reviews/${enc(args.nodeRunId)}/documents/${enc(args.docVersionId)}/selection`,
          body: { selection: args.selection },
        }),
      ),
  },
  {
    name: 'submit_review',
    title: 'Approve, iterate or reject a review',
    description:
      'Decide a pending review, optionally with comments and per-document selections in the same transaction: ' +
      'one invalid entry refuses the whole call and nothing is written. `rejected` requires `rejectReason`; ' +
      '`iterated` sends the comments back to the authoring agent for another round. `reviewIteration` must ' +
      'match what get_review returned, so a decision made against a stale version is refused rather than ' +
      'applied. If the call fails after a worktree rollback, re-issue the SAME decision — the rollback is ' +
      'idempotent and the documents are still pending.',
    permissions: ['tasks:execute'],
    inputSchema: SUBMIT_REVIEW_INPUT_SCHEMA,
    audit: reviewAudit,
    handler: async (args, ctx) =>
      unwrap(
        await ctx.dispatch({
          method: 'POST',
          path: `/api/reviews/${enc(args.nodeRunId)}/decision`,
          body: {
            decision: args.decision,
            rejectReason: args.rejectReason,
            reviewIteration: args.reviewIteration,
            comments: args.comments,
            selections: args.selections,
          },
        }),
      ),
  },
]

// -----------------------------------------------------------------------------
// Resource domain (D11 — converged tools)
// -----------------------------------------------------------------------------

/**
 * What each resource kind actually supports, read off the real route table
 * rather than assumed from the kind name. The differences are not cosmetic and
 * a symmetric guess gets three of them wrong:
 *
 *   · `repos` are imported in batches (`/api/cached-repos/batch-import`) and
 *     have NO update route at all — which is why `repos:update` was never
 *     minted as a permission point.
 *   · `memory` updates are PATCH, not PUT.
 *   · `tasks` are absent: launching is not "creating a resource", and the task
 *     verbs have dedicated tools above. Two ways to cancel a task is one way
 *     too many.
 */
interface ResourceOp {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** `:id` is substituted; absent means a collection path. */
  readonly path: string
  /**
   * The route ALSO demands `?confirm=true` as an irreversibility ack, separate
   * from RFC-247's type-to-confirm body. Only `memory` does this today.
   */
  readonly confirmQuery?: boolean
  /**
   * RFC-248: 这个 kind 的 delete 支持 `?force=1`（摘除引用 / 停发计划）。
   * 没有它的话，MCP 调用方收到 409 后**无路可走**——`resource_write` 不接
   * 任何 query，往 body 里塞 `force` 也会被 REST 路由忽略（它读的是查询串）。
   */
  readonly forceQuery?: boolean
}

interface ResourceRoutes {
  readonly list: ResourceOp
  readonly get?: ResourceOp
  /**
   * RFC-327 —— 这个 kind 的「有什么可筛」目录(今天只有 memory:标签 + 计数)。
   * 没有它时 `resource_read(method:'facets')` 明确拒绝,而不是悄悄退回 list。
   */
  readonly facets?: ResourceOp
  readonly create?: ResourceOp
  readonly update?: ResourceOp
  readonly delete?: ResourceOp
  /** Surfaced by describe_resource when the shape is not the obvious one. */
  readonly note?: string
}

/**
 * RFC-248 T30c —— MCP 的资源 kind **不等于**权限域。
 *
 * 仓库组在 UI / API 上是独立一类资源，但它的写权限沿用 `repos:*`（它管理的是
 * 仓库的编排，不是第十一种可授权资源；`MATRIX_RESOURCES` 保持不变，账号页的
 * 令牌矩阵也就不会多出一个用户无从理解的勾）。所以这里显式把两者拆开：
 * `McpResourceKind` 是「工具能寻址的资源」，`permissionDomain` 是「写它要哪个点」。
 */
export type McpResourceKind = MatrixResource | 'repo-groups'

/** kind → 权限域。缺省即 kind 自身。 */
const PERMISSION_DOMAIN: Partial<Record<McpResourceKind, MatrixResource>> = {
  'repo-groups': 'repos',
}

const permissionDomainFor = (kind: McpResourceKind): string => PERMISSION_DOMAIN[kind] ?? kind

const RESOURCE_ROUTES: Partial<Record<McpResourceKind, ResourceRoutes>> = {
  agents: {
    list: { method: 'GET', path: '/api/agents' },
    get: { method: 'GET', path: '/api/agents/:id' },
    create: { method: 'POST', path: '/api/agents' },
    update: { method: 'PUT', path: '/api/agents/:id' },
    delete: { method: 'DELETE', path: '/api/agents/:id' },
    note: 'Updates and deletes are fenced: include `expectedUpdatedAt` and `expectedAclRevision` from a prior read.',
  },
  skills: {
    list: { method: 'GET', path: '/api/skills' },
    get: { method: 'GET', path: '/api/skills/:id' },
    create: { method: 'POST', path: '/api/skills' },
    // NOT `PUT /api/skills/:id` — that route is retired and answers 410 Gone on
    // every call, so the first version of this table advertised a skill update
    // that could never succeed.
    update: { method: 'POST', path: '/api/skills/:id/save' },
    delete: { method: 'DELETE', path: '/api/skills/:id' },
    note:
      'Updates go through the combined-save endpoint and are fenced: include the `expectedToken` ' +
      'from a prior read. Deletes need `expectedToken` + `expectedAclRevision`.',
  },
  mcps: {
    list: { method: 'GET', path: '/api/mcps' },
    get: { method: 'GET', path: '/api/mcps/:id' },
    create: { method: 'POST', path: '/api/mcps' },
    update: { method: 'PUT', path: '/api/mcps/:id' },
    delete: { method: 'DELETE', path: '/api/mcps/:id' },
  },
  plugins: {
    list: { method: 'GET', path: '/api/plugins' },
    get: { method: 'GET', path: '/api/plugins/:id' },
    create: { method: 'POST', path: '/api/plugins' },
    update: { method: 'PUT', path: '/api/plugins/:id' },
    delete: { method: 'DELETE', path: '/api/plugins/:id' },
  },
  workflows: {
    list: { method: 'GET', path: '/api/workflows' },
    get: { method: 'GET', path: '/api/workflows/:id' },
    create: { method: 'POST', path: '/api/workflows' },
    update: { method: 'PUT', path: '/api/workflows/:id' },
    delete: { method: 'DELETE', path: '/api/workflows/:id' },
    note: 'Updates and deletes are fenced: include the `expectedVersion` from a prior read.',
  },
  workgroups: {
    list: { method: 'GET', path: '/api/workgroups' },
    get: { method: 'GET', path: '/api/workgroups/:id' },
    create: { method: 'POST', path: '/api/workgroups' },
    update: { method: 'PUT', path: '/api/workgroups/:id' },
    delete: { method: 'DELETE', path: '/api/workgroups/:id' },
    note: 'Updates and deletes are fenced: include the `expectedVersion` from a prior read.',
  },
  'scheduled-tasks': {
    list: { method: 'GET', path: '/api/scheduled-tasks' },
    get: { method: 'GET', path: '/api/scheduled-tasks/:id' },
    create: { method: 'POST', path: '/api/scheduled-tasks' },
    update: { method: 'PUT', path: '/api/scheduled-tasks/:id' },
    delete: { method: 'DELETE', path: '/api/scheduled-tasks/:id' },
    note:
      'Creating a schedule, or editing one in a way that arms a launch, additionally requires tasks:execute — ' +
      'a schedule is a launch with a delay.',
  },
  repos: {
    list: { method: 'GET', path: '/api/cached-repos' },
    get: { method: 'GET', path: '/api/cached-repos/:id' },
    create: { method: 'POST', path: '/api/cached-repos/batch-import' },
    delete: { method: 'DELETE', path: '/api/cached-repos/:id' },
    note:
      'Repos are imported in batches: `create` takes a batch payload, not one repo. There is no update — ' +
      'a mirror is refreshed, not edited.',
  },
  'capability-templates': {
    list: { method: 'GET', path: '/api/capability-templates' },
    get: { method: 'GET', path: '/api/capability-templates/:id' },
    create: { method: 'POST', path: '/api/capability-templates' },
    update: { method: 'PUT', path: '/api/capability-templates/:id' },
    delete: { method: 'DELETE', path: '/api/capability-templates/:id' },
    note:
      'RFC-309: a capability template is the whole configuration for one capability — the ' +
      'scripts and hooks it runs, the parameters it declares, and which agent and prompt fills ' +
      'each AI slot. Writing `scripts` or `hooks` additionally requires `scripts:author`: those ' +
      'run with the daemon’s own credentials, and a write that changes them without it is ' +
      'rejected whole rather than silently stripped. ' +
      'There is deliberately no tool for capability FRAMEWORKS — authoring one is host code ' +
      'execution, gated on `scripts:author`, and never reachable from a tool surface.',
  },
  'repo-groups': {
    list: { method: 'GET', path: '/api/repo-groups' },
    get: { method: 'GET', path: '/api/repo-groups/:id' },
    create: { method: 'POST', path: '/api/repo-groups' },
    update: { method: 'PUT', path: '/api/repo-groups/:id' },
    delete: { method: 'DELETE', path: '/api/repo-groups/:id', forceQuery: true },
    note:
      'RFC-248: a repo group is a named multi-repo layout (mount paths, nesting, sparse subdir, ' +
      'readonly). It is the ONLY way to launch a multi-repo task — `launch_task` takes ' +
      '`repoGroupId`; the old inline `repos[]` array is retired and now fails with 422. ' +
      'Writes are gated on `repos:*` (a group orchestrates repos, it is not a separate grantable ' +
      'resource). Updates are fenced: pass the `version` from a prior read as `expectedVersion`. ' +
      'Delete refuses (409) while other groups or enabled scheduled tasks still reference it; ' +
      'pass force=1 to detach those groups and disable those schedules.',
  },
  memory: {
    list: { method: 'GET', path: '/api/memories' },
    // RFC-327：标签 / scope 目录。读面,与 list 同权限档。
    facets: { method: 'GET', path: '/api/memories/facets' },
    get: { method: 'GET', path: '/api/memories/:id' },
    create: { method: 'POST', path: '/api/memories' },
    update: { method: 'PATCH', path: '/api/memories/:id' },
    delete: { method: 'DELETE', path: '/api/memories/:id', confirmQuery: true },
  },
}

/**
 * The kinds the converged tools accept: every matrix resource except `tasks`.
 *
 * Spelled out as a tuple because `z.enum` needs one, and locked against
 * `MATRIX_RESOURCES` by a test rather than derived with a cast — a cast would
 * let a newly added resource silently miss its tools, which is the same class
 * of drift the permission catalog's self-checks exist to prevent.
 */
const RESOURCE_KINDS = [
  'agents',
  'skills',
  'mcps',
  'plugins',
  'workflows',
  'workgroups',
  'scheduled-tasks',
  'repos',
  // RFC-248: 独立 kind、权限沿用 `repos:*`（见 PERMISSION_DOMAIN）。
  'repo-groups',
  // RFC-304 — the GROUP layer only. `capability-frameworks` is deliberately
  // absent: authoring one is host code execution, and an agent editing the
  // templates that configure agents is a loop nobody asked for.
  'capability-templates',
  'memory',
] as const

/** Exported for the drift lock in tests. */
export const MCP_RESOURCE_KINDS: ReadonlyArray<McpResourceKind> = RESOURCE_KINDS

const RESOURCE_TOOLS: ReadonlyArray<McpToolDef> = [
  {
    name: 'resource_read',
    title: 'Read resources',
    description:
      'List or fetch a resource of any kind (agents, skills, mcps, plugins, workflows, workgroups, ' +
      'scheduled-tasks, repos, memory). Reads are available to every token, bounded by what the ' +
      'owning account can see.',
    permissions: [],
    inputSchema: {
      kind: z.enum(RESOURCE_KINDS).describe('Resource type'),
      method: z
        .enum(['list', 'get', 'facets'])
        .describe(
          'list = all visible (narrow it with `query`); get = one by id; ' +
            'facets = what there is to filter BY (memory: its tags with counts)',
        ),
      id: z.string().min(1).optional().describe('Required when method is "get"'),
      // RFC-327：过滤参数直通到 REST 的查询串。之前这个工具一个参数都不收,于是
      // 「按 scope / 标签找知识」在 MCP 上只能全量拉回来自己筛——正文还要逐条 get。
      query: z
        .record(z.string())
        .optional()
        .describe(
          'Filters, passed straight through as the query string. Call describe_resource for the ' +
            'ones a kind accepts — memory takes scopeType / scopeId / status / search / tags ' +
            '(comma-separated) / tagMode (any|all). Unknown keys are refused by the route, not ignored.',
        ),
    },
    handler: async (args, ctx) => {
      const routes = routesFor(args.kind)
      const op =
        args.method === 'get' ? routes.get : args.method === 'facets' ? routes.facets : routes.list
      if (op === undefined)
        throw new Error(`resource_read: ${String(args.kind)} has no ${String(args.method)}`)
      return unwrap(
        await ctx.dispatch({
          method: op.method,
          path: fillId(op.path, args.id),
          query: args.query as Record<string, string> | undefined,
        }),
      )
    },
  },
  {
    name: 'resource_write',
    title: 'Create, update or delete a resource',
    description:
      'Write to a resource of any kind. The token must hold the matching permission for that kind and verb — ' +
      'call describe_capabilities to see which it has. Deletion is irreversible and requires the resource ' +
      "name in `confirm`; call describe_resource for a kind's field schema before creating or updating.",
    // Declared empty and checked PER CALL against (kind, method): a token that
    // may create workflows but not delete them still needs this tool listed.
    // The real gate is the route's own, which cannot be bypassed from here.
    permissions: [],
    inputSchema: {
      kind: z.enum(RESOURCE_KINDS).describe('Resource type'),
      method: z.enum(['create', 'update', 'delete']),
      id: z.string().min(1).optional().describe('Required for update and delete'),
      body: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Field values for create/update — see describe_resource'),
      confirm: z
        .string()
        .min(1)
        .optional()
        .describe('Required for delete: the exact resource name'),
      force: z
        .boolean()
        .optional()
        .describe(
          'Delete only, and only where the kind supports it (repo-groups): proceed even though ' +
            'other resources still reference this one — detaching those references and disabling ' +
            'referencing scheduled tasks. Without it such a delete returns 409.',
        ),
    },
    handler: async (args, ctx) => {
      const routes = routesFor(args.kind)
      const method = args.method as 'create' | 'update' | 'delete'
      const op = routes[method]
      if (op === undefined) {
        // Not a permission refusal — the capability does not exist for anyone.
        // Saying so plainly stops a model retrying with a wider token.
        throw new Error(
          `resource_write: ${String(args.kind)} has no ${method} operation` +
            (routes.note === undefined ? '' : ` — ${routes.note}`),
        )
      }
      if (method === 'create') {
        return unwrap(
          await ctx.dispatch({ method: op.method, path: op.path, body: args.body ?? {} }),
        )
      }
      if (typeof args.id !== 'string' || args.id === '') {
        throw new Error(`resource_write: \`id\` is required for ${method}`)
      }
      if (method === 'update') {
        return unwrap(
          await ctx.dispatch({
            method: op.method,
            path: fillId(op.path, args.id),
            body: args.body ?? {},
          }),
        )
      }
      if (typeof args.confirm !== 'string' || args.confirm === '') {
        throw new Error('resource_write: `confirm` must carry the exact resource name to delete it')
      }
      // `body` is merged in, not dropped: several kinds fence their deletes on
      // a revision (`expectedUpdatedAt` / `expectedVersion` / …). Those fields
      // arrive here the same way they arrive from the web UI — read first, pass
      // what you read. Filling them in on the caller's behalf would defeat the
      // fence exactly when it matters, which is when two writers race.
      return unwrap(
        await ctx.dispatch({
          method: op.method,
          path: fillId(op.path, args.id),
          // `memory` gates hard-delete on a `?confirm=true` QUERY (its own
          // pre-RFC-247 irreversibility ack) IN ADDITION to the token's
          // type-to-confirm body. Sending only the body made every memory
          // delete fail with `confirm-required`.
          query: {
            ...(op.confirmQuery === true ? { confirm: 'true' } : {}),
            // RFC-248: 强制删除走查询串（REST 路由读的是 `?force=1`）。
            ...(op.forceQuery === true && args.force === true ? { force: '1' } : {}),
          },
          body: { ...(args.body ?? {}), confirm: args.confirm },
        }),
      )
    },
  },
  {
    name: 'describe_resource',
    title: 'Describe a resource kind',
    description:
      'Which operations a resource kind supports, which permission each needs, the JSON Schema of its ' +
      'create/update bodies, and any quirk in its shape (repos import in batches; memory updates are ' +
      'partial). Call this before a first create or update — the schemas include the revision fields ' +
      'whose absence makes an update fail.',
    permissions: [],
    inputSchema: { kind: z.enum(RESOURCE_KINDS) },
    handler: async (args) => describeResource(args.kind as McpResourceKind),
  },
]

function routesFor(kind: unknown): ResourceRoutes {
  const routes = RESOURCE_ROUTES[kind as McpResourceKind]
  if (routes === undefined) throw new Error(`unknown resource kind: ${String(kind)}`)
  return routes
}

function fillId(path: string, id: unknown): string {
  if (!path.includes(':id')) return path
  if (typeof id !== 'string' || id === '') throw new Error('`id` is required for this operation')
  return path.replace(':id', encodeURIComponent(id))
}

export function describeResource(kind: McpResourceKind): {
  kind: McpResourceKind
  operations: Array<{ operation: string; method: string; path: string; permission: string | null }>
  bodySchemas: ResourceBodySchemas
  /** RFC-327: `resource_read`'s `query` contract for this kind, when it has one. */
  querySchema?: unknown
  note?: string
} {
  const routes = routesFor(kind)
  const ops: Array<{ operation: string; method: string; path: string; permission: string | null }> =
    []
  for (const operation of ['list', 'facets', 'get', 'create', 'update', 'delete'] as const) {
    const op = routes[operation]
    if (op === undefined) continue
    ops.push({
      operation,
      method: op.method,
      path: op.path,
      // Reads need no point (D3); writes need the matching verb.
      // RFC-248 T30c: 权限点用**权限域**拼，不是 kind——`repo-groups` 的写点
      // 是 `repos:update` 之类，不存在 `repo-groups:update` 这个点。
      permission:
        operation === 'list' || operation === 'get' || operation === 'facets'
          ? null
          : `${permissionDomainFor(kind)}:${operation}`,
    })
  }
  // The field contract, derived from the same zod objects the routes validate
  // with. `resource_write` points callers here for it; before this it was the
  // one question this tool could not answer.
  const bodySchemas = bodySchemasFor(kind)
  const querySchema = querySchemaFor(kind)
  const base = { kind, operations: ops, bodySchemas }
  const withQuery = querySchema === undefined ? base : { ...base, querySchema }
  return routes.note === undefined ? withQuery : { ...withQuery, note: routes.note }
}

// -----------------------------------------------------------------------------
// Introspection
// -----------------------------------------------------------------------------

const INTROSPECTION_TOOLS: ReadonlyArray<McpToolDef> = [
  {
    name: 'describe_capabilities',
    title: 'What can this token do',
    description:
      'The permissions this token holds and, just as usefully, the ones it does not — so a refusal can be ' +
      'explained to the user as "ask for workflows:create" rather than "it failed".',
    permissions: [],
    inputSchema: {},
    handler: async (_args, ctx) => describeCapabilities(ctx.actor),
  },
]

export function describeCapabilities(actor: Actor): {
  role: Role
  granted: Permission[]
  toolsAvailable: string[]
  toolsUnavailable: Array<{ tool: string; missing: Permission[] }>
} {
  const granted = [...actor.permissions].sort()
  const available: string[] = []
  const unavailable: Array<{ tool: string; missing: Permission[] }> = []
  for (const tool of ALL_TOOLS) {
    const missing = tool.permissions.filter((p) => !actor.permissions.has(p))
    if (missing.length === 0) available.push(tool.name)
    else unavailable.push({ tool: tool.name, missing })
  }
  return {
    role: actor.user.role,
    granted,
    toolsAvailable: available,
    toolsUnavailable: unavailable,
  }
}

export const ALL_TOOLS: ReadonlyArray<McpToolDef> = [
  ...TASK_TOOLS,
  ...GATE_TOOLS,
  ...RESOURCE_TOOLS,
  ...INTROSPECTION_TOOLS,
]

/**
 * RFC-247 D10 — the tools a given token may see.
 *
 * Filtering `tools/list` is not a security boundary (the route gate is); it is
 * an accuracy one. A model shown `delete_task` will eventually try it, and
 * spending a turn to learn it was never allowed is worse than never having been
 * offered it.
 */
export function toolsFor(actor: Actor): ReadonlyArray<McpToolDef> {
  return ALL_TOOLS.filter((tool) =>
    tool.permissions.every((permission) => actor.permissions.has(permission)),
  )
}
