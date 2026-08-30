// RFC-247 §4.2 — the MCP tool set.
//
// One declarative table. A tool names the permission points it needs, and
// `tools/list` filtering, the pre-call check and the generated documentation
// all read that same field — the `RouteMeta` discipline applied to the second
// channel, for the same reason: a capability list that is written twice is a
// capability list that disagrees with itself.
//
// Every handler invokes stable operation ids declared in operationBindings.ts.
// The compatibility adapter targets the already-mounted main route table; no
// tool chooses a method/URL or creates a second transport stack.
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
  type SubmitClarifyAnswersSchema,
  type SubmitReviewDecisionSchema,
  type WorkflowInput,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import {
  bindingForTool,
  type McpHttpOperation,
  MCP_OPERATIONS,
  MCP_TOOL_BINDINGS,
  RESOURCE_OPERATIONS,
} from '@/mcp/operationBindings'
import { bodySchemasFor, querySchemaFor, type ResourceBodySchemas } from '@/mcp/resourceSchemas'
import { registerMcpOperationProjection } from '@/platform/operations/catalog'
import type { OperationResult } from '@/platform/operations/contracts'
import type { McpOperationHandles } from '@/mcp/operationClient'

export interface McpToolContext {
  readonly actor: Actor
  readonly operations: McpOperationHandles
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

/** Everything a dispatch answer needs to become a tool result. */
function unwrap(res: OperationResult): unknown {
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
  constructor(res: OperationResult) {
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
      return unwrap(await ctx.operations.taskLaunch({ body: args }))
    },
  },
  {
    // RFC-329 A3 — `launch_task` takes a `ref`, and until now nothing on this
    // channel could tell the model which refs exist, so it had to guess a branch
    // name. The REST route takes `?path=<absolute local mirror path>`
    // (routes/repos.ts, guarded by requireKnownPath), which is not something a
    // model should be handling or inventing — so this tool takes the repo id and
    // resolves the path itself.
    name: 'list_repo_refs',
    title: 'List the branches and tags of an imported repo',
    description:
      'Branches and tags available in an imported repo mirror. `launch_task` takes one of these as ' +
      '`ref`; without this tool the only option is guessing a branch name. Takes the repo id from ' +
      'resource_read(kind="repos", method="list") — that list is also where the row itself lives, ' +
      'since repos have no single-repo read.',
    permissions: [],
    inputSchema: {
      cachedRepoId: z
        .string()
        .min(1)
        .describe('Repo id from resource_read(kind="repos", method="list")'),
    },
    audit: (args) => ({ kind: 'repo-refs', id: String(args.cachedRepoId) }),
    handler: async (args, ctx) => {
      const listed = unwrap(await ctx.operations.cachedReposList()) as {
        items?: ReadonlyArray<{ id?: unknown; localPath?: unknown }>
      }
      const row = (listed.items ?? []).find((item) => item.id === args.cachedRepoId)
      // A miss is a business refusal shaped like the route's own 404, NOT a
      // thrown TypeError on the next line. The failure mode has to match what a
      // single-dispatch tool would have produced, or a two-hop tool becomes the
      // one place where a bad id yields a 500.
      if (row === undefined || typeof row.localPath !== 'string') {
        throw new McpCallError({
          status: 404,
          body: {
            code: 'cached-repo-not-found',
            message: `no imported repo with id '${String(args.cachedRepoId)}'`,
          },
        })
      }
      return unwrap(
        await ctx.operations.repoRefsList({
          query: { path: row.localPath },
        }),
      )
    },
  },
  {
    name: 'get_task',
    title: 'Get a task',
    // RFC-329 A2 — this used to promise "and any alerts". It does not carry
    // them: the route returns the task row via serializeTaskFor. Saying so was
    // what sent callers looking for an alertId that was never there.
    description:
      'Full state of one task: status, node runs and timing. Alerts are NOT included — use list_task_alerts.',
    permissions: [],
    inputSchema: { id: taskId },
    handler: async (args, ctx) =>
      unwrap(await ctx.operations.taskGet({ params: { id: String(args.id) } })),
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
        await ctx.operations.taskList({
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
      unwrap(await ctx.operations.taskDiffGet({ params: { id: String(args.id) } })),
  },
  {
    name: 'list_node_runs',
    title: 'List node runs',
    description:
      'Per-node execution records for a task, including retries (each retry is its own run).',
    permissions: [],
    inputSchema: { id: taskId },
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.taskNodeRunsList({
          params: { id: String(args.id) },
        }),
      ),
  },
  {
    name: 'cancel_task',
    title: 'Cancel a task',
    description:
      'Stop a running task. The worktree is KEPT, so the work done so far stays inspectable and the task can be resumed.',
    permissions: ['tasks:execute'],
    inputSchema: { id: taskId },
    handler: async (args, ctx) =>
      unwrap(await ctx.operations.taskCancel({ params: { id: String(args.id) } })),
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
        await ctx.operations.taskRetryNode({
          params: { id: String(args.id), nodeRunId: String(args.nodeRunId) },
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
      unwrap(await ctx.operations.taskResume({ params: { id: String(args.id) } })),
  },
  {
    name: 'diagnose_task',
    title: 'Diagnose a failing task',
    description: 'Run the built-in diagnosis for a failed or stuck task and return its findings.',
    permissions: ['tasks:execute'],
    inputSchema: { id: taskId },
    handler: async (args, ctx) =>
      unwrap(await ctx.operations.taskDiagnose({ params: { id: String(args.id) } })),
  },
  {
    // RFC-329 A2 — the alert loop was BROKEN on this channel. `repair_alert` and
    // `list_repair_options` both need an `alertId`, and `repair_alert` told the
    // caller to "call get_task first to read the alert" — but `GET /api/tasks/:id`
    // returns the task row through `serializeTaskFor`, which carries no alerts at
    // all. The alerts live on their own route, and nothing dispatched to it. So an
    // MCP-only caller could never obtain the one argument both tools require, and
    // the two of them were unreachable in practice.
    name: 'list_task_alerts',
    title: 'List the alerts a task raised',
    description:
      'Lifecycle alerts currently open on a task — invariant violations and stuck-run findings. ' +
      'This is the ONLY way to obtain an `alertId`: get_task returns the task row and does not carry ' +
      'alerts. Feed the id to list_repair_options for the option ids, then to repair_alert.',
    permissions: [],
    inputSchema: { id: taskId },
    audit: (args) => ({ kind: 'task-alerts', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.taskAlertsList({
          params: { id: String(args.id) },
        }),
      ),
  },
  {
    name: 'repair_alert',
    title: 'Apply a repair option to an alert',
    description:
      'Apply one of the repair options a task alert offers. Call list_task_alerts for the alertId ' +
      '(get_task does not carry alerts), then list_repair_options for the optionId.',
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
        await ctx.operations.taskAlertRepair({
          params: { id: String(args.id), alertId: String(args.alertId) },
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
        await ctx.operations.taskAlertRepairOptionsList({
          params: { id: String(args.id), alertId: String(args.alertId) },
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
        await ctx.operations.taskDelete({
          params: { id: String(args.id) },
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
  const res = await ctx.operations.workflowGet({ params: { id: workflowId } })
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
      'Every gate that will not move on its own: reviews, clarifying questions, workgroup rooms and fusion ' +
      'approvals. Each lane reports independently — `complete: false` means one of them failed and its entry ' +
      'carries `{ok: false, error}`, so an empty lane is only trustworthy when that lane says `ok`. ' +
      'watch_task returns as soon as a task reaches one of these states.',
    permissions: [],
    inputSchema: {},
    audit: () => ({ kind: 'human-gates' }),
    handler: async (_args, ctx) => {
      // RFC-329 —— per-lane failure, and `Promise.allSettled` alone does NOT give
      // it. The dispatcher resolves 4xx/5xx as a fulfilled DispatchResult (see
      // operation adapter); only `unwrap` turns those into a throw. So unwrap has to
      // happen INSIDE each lane, or a lane that 500s reports as an empty gate list
      // — the single most dangerous answer this tool can give, because "nothing is
      // waiting on you" is exactly what a model acts on by moving on.
      const lane = async (
        operation: McpHttpOperation,
        query?: Record<string, string>,
      ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> => {
        try {
          return {
            ok: true,
            data: unwrap(await ctx.operations.dependency(operation, { query })),
          }
        } catch (err) {
          return { ok: false, error: err instanceof McpCallError ? err.code : 'error' }
        }
      }
      const [reviews, clarify, workgroupTasks, fusions] = await Promise.all([
        lane(MCP_OPERATIONS.reviewsList),
        lane(MCP_OPERATIONS.clarifyList),
        lane(MCP_OPERATIONS.workgroupPendingList),
        lane(MCP_OPERATIONS.fusionsList, { status: 'awaiting_approval' }),
      ])
      const lanes = { reviews, clarify, workgroupTasks, fusions }
      return { ...lanes, complete: Object.values(lanes).every((entry) => entry.ok) }
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
      unwrap(
        await ctx.operations.clarifyGet({
          params: { nodeRunId: String(args.nodeRunId) },
        }),
      ),
  },
  {
    name: 'answer_clarify',
    title: 'Answer clarifying questions',
    description:
      'Submit answers to a clarifying round. Two channels: by default (`defer` omitted) this answers the WHOLE ' +
      'round, seals it and lets the task continue. With `defer: true` it seals only the questions you answer ' +
      'into the dispatch board and does NOT advance the task — send them later with dispatch_task_questions. ' +
      'Include `ifMatchIteration` from get_clarify_session: without it, two answerers can silently overwrite ' +
      'each other. `directive: "stop"` answers and asks for no further rounds (it also flips this node’s ' +
      'clarify switch — see set_clarify_directive).',
    // RFC-329 A4 — this used to say 412. The route deliberately answers 409
    // (routes/clarify.ts header; ConflictError is hard-coded to 409 in
    // util/errors.ts), and a wrong status here sends the caller down the wrong
    // retry branch. `rfc329-mcp-dead-paths.test.ts` now pins the number in this
    // description to `new ConflictError(...).status` so it cannot drift again.
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
        .describe('The iterationIndex you read; mismatched answers are refused with 409'),
      directive: z.enum(['continue', 'stop']).optional(),
      // RFC-329 —— the control channel. The REST route has had these three since
      // RFC-128/136; this tool could not express any of them, so "answer some
      // questions now and let a colleague take the rest" was web-only. Note this
      // is the exact shape the guard's request-field dimension checks: a key the
      // route accepts and this schema omits is a silent capability gap, which is
      // precisely how these three went unnoticed.
      defer: z
        .boolean()
        .optional()
        .describe(
          'false / omitted = QUICK channel: answer the whole round, seal it, task continues. ' +
            'true = CONTROL channel: seal only the answered questions into the dispatch board ' +
            'WITHOUT advancing the task.',
        ),
      questionIds: z
        .array(z.string())
        .optional()
        .describe(
          'Control channel only: seal exactly these question ids and leave the siblings for ' +
            'someone else. Sending it without defer:true is REFUSED (clarify-question-ids-requires-defer), ' +
            'not silently ignored — on the quick channel it would strand the dropped questions.',
        ),
      resubmitQuestionIds: z
        .array(z.string())
        .optional()
        .describe(
          'Control channel only: the already-sealed questions you are deliberately OVERWRITING. ' +
            'Without this declaration a sealed question keeps its exactly-once refusal even here.',
        ),
    } satisfies Partial<
      Record<keyof z.input<typeof SubmitClarifyAnswersSchema> | 'nodeRunId', z.ZodTypeAny>
    >,
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.clarifyAnswer({
          params: { nodeRunId: String(args.nodeRunId) },
          body: {
            answers: args.answers,
            ifMatchIteration: args.ifMatchIteration,
            directive: args.directive,
            defer: args.defer,
            questionIds: args.questionIds,
            resubmitQuestionIds: args.resubmitQuestionIds,
          },
        }),
      ),
  },
  // ---------------------------------------------------------------------------
  // RFC-329 —— the clarify board (per-question routing), the node switch, and the
  // collaborative draft. All of these existed on REST since RFC-120/122/128; none
  // had a tool, so "answer some now, hand the rest to a colleague, dispatch when
  // ready" was reachable only from the web UI.
  //
  // Every description says whether the step ADVANCES THE RUN, because only one of
  // them does and a model cannot tell from the verb.
  // ---------------------------------------------------------------------------
  {
    name: 'list_task_questions',
    title: 'List the questions on a task’s board',
    description:
      'Every question entry on this task with its phase — pending assignment, staged for dispatch, or already ' +
      'sent. This is the board behind answer_clarify’s control channel. Does not advance the run.',
    permissions: [],
    inputSchema: {
      id: taskId,
      sourceNodeId: z.string().min(1).optional().describe('Only questions raised by this node'),
      phase: z
        .string()
        .min(1)
        .optional()
        .describe('Filter by phase; an unknown value is refused (422), not ignored'),
    },
    audit: (args) => ({ kind: 'task-questions', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.taskQuestionsList({
          params: { id: String(args.id) },
          query: {
            ...(typeof args.sourceNodeId === 'string' ? { sourceNodeId: args.sourceNodeId } : {}),
            ...(typeof args.phase === 'string' ? { phase: args.phase } : {}),
          },
        }),
      ),
  },
  {
    name: 'raise_task_question',
    title: 'Raise a question of your own on a task',
    description:
      'Add a question nobody asked for — the human-authored counterpart of an agent’s clarify round. ' +
      'With `targetNodeId` it lands staged (ready for dispatch_task_questions); without one it waits for ' +
      'assignment. Does not advance the run on its own.',
    permissions: ['tasks:execute'],
    inputSchema: {
      id: taskId,
      title: z.string().min(1).describe('Short question title'),
      body: z.string().min(1).describe('The question itself'),
      targetNodeId: z
        .string()
        .min(1)
        .optional()
        .describe(
          'A workflow agent node; giving one stages the entry instead of leaving it pending',
        ),
    },
    audit: (args) => ({ kind: 'task-questions', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.taskQuestionRaise({
          params: { id: String(args.id) },
          body: { title: args.title, body: args.body, targetNodeId: args.targetNodeId },
        }),
      ),
  },
  {
    name: 'confirm_task_question',
    title: 'Confirm a question entry',
    description: 'Accept a board entry as-is. Does not advance the run.',
    permissions: ['tasks:execute'],
    inputSchema: { id: taskId, entryId: z.string().min(1) },
    audit: (args) => ({ kind: 'task-questions', id: String(args.entryId) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.taskQuestionConfirm({
          params: { id: String(args.id), entryId: String(args.entryId) },
        }),
      ),
  },
  {
    name: 'reassign_task_question',
    title: 'Route a question to a different node',
    description:
      'Point a board entry at another workflow node. The reply says what happened: `added-designer` (the ' +
      'question gained an upstream handler), `removed-designer` (back to a single card) or `moved-manual`. ' +
      'The asker entry is always kept. Does not advance the run.',
    permissions: ['tasks:update'],
    inputSchema: {
      id: taskId,
      entryId: z.string().min(1),
      targetNodeId: z.string().min(1).describe('The workflow node that should handle it'),
    },
    audit: (args) => ({ kind: 'task-questions', id: String(args.entryId) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.taskQuestionReassign({
          params: { id: String(args.id), entryId: String(args.entryId) },
          body: { targetNodeId: args.targetNodeId },
        }),
      ),
  },
  {
    name: 'stage_task_question',
    title: 'Move a question into the send queue',
    description:
      'Mark a board entry ready to go. It sits there until dispatch_task_questions sends every staged entry. ' +
      'Does not advance the run.',
    permissions: ['tasks:execute'],
    inputSchema: { id: taskId, entryId: z.string().min(1) },
    audit: (args) => ({ kind: 'task-questions', id: String(args.entryId) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.taskQuestionStage({
          params: { id: String(args.id), entryId: String(args.entryId) },
        }),
      ),
  },
  {
    name: 'dispatch_task_questions',
    title: 'Send the staged questions and resume the task',
    description:
      'THIS IS THE STEP THAT RESUMES THE RUN. Sends every staged entry (or just `entryIds`) to their nodes. ' +
      'HTTP 200 includes a durable `receipt`: question stamping, rerun minting, task release, and continuation ' +
      'admission committed atomically. A later engine wake is recovered from that continuation.',
    permissions: ['tasks:execute'],
    inputSchema: {
      id: taskId,
      entryIds: z
        .array(z.string())
        .optional()
        .describe('Restrict to these entries; omit to send everything staged'),
    },
    audit: (args) => ({ kind: 'task-questions', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.taskQuestionsDispatch({
          params: { id: String(args.id) },
          body: { entryIds: args.entryIds },
        }),
      ),
  },
  {
    name: 'list_clarify_directives',
    title: 'Read the per-node clarify switches',
    description:
      'Which nodes on this task are allowed to keep asking. Answering with `directive: "stop"` flips the ' +
      'asking node’s switch here, so this is where you verify a stop actually took.',
    permissions: [],
    inputSchema: { id: taskId },
    audit: (args) => ({ kind: 'clarify-directives', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.clarifyDirectivesList({
          params: { id: String(args.id) },
        }),
      ),
  },
  {
    name: 'set_clarify_directive',
    title: 'Turn one node’s clarifying on or off',
    description:
      'Set whether a node may raise further clarify rounds, WITHOUT answering anything. The other way to ' +
      'reach the same switch is answer_clarify with `directive` — that one answers the round as well. ' +
      'Both write the same single source of truth.',
    permissions: ['tasks:update'],
    inputSchema: {
      id: taskId,
      nodeId: z.string().min(1),
      directive: z.enum(['continue', 'stop']),
    },
    audit: (args) => ({ kind: 'clarify-directives', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.clarifyDirectiveSet({
          params: { id: String(args.id), nodeId: String(args.nodeId) },
          body: { directive: args.directive },
        }),
      ),
  },
  {
    name: 'save_clarify_draft',
    title: 'Save a draft answer others can see',
    description:
      'Park a work-in-progress answer on one question so co-answerers see it before anyone submits. ' +
      'LAST WRITE WINS per question — there is no revision fence, so a concurrent editor (web or MCP) ' +
      'silently replaces your draft. Drafts are not answers: nothing is sealed and the run does not move.',
    permissions: ['tasks:execute'],
    inputSchema: {
      nodeRunId: z.string().min(1),
      roundId: z.string().min(1),
      questionId: z.string().min(1),
      selectedOptionIndices: z.array(z.number().int().nonnegative()).max(64).optional(),
      customText: z.string().max(65536).optional(),
    },
    audit: (args) => ({ kind: 'clarify-draft', id: String(args.nodeRunId) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.clarifyDraftSave({
          params: { nodeRunId: String(args.nodeRunId) },
          body: {
            roundId: args.roundId,
            questionId: args.questionId,
            selectedOptionIndices: args.selectedOptionIndices ?? [],
            customText: args.customText ?? '',
          },
        }),
      ),
  },
  // ---------------------------------------------------------------------------
  // RFC-329 —— the workgroup room. Same boundary as clarify (task membership) and
  // the same stopping state (`awaiting_human`), but until now zero tools: a task
  // parked on a workgroup gate was invisible to every MCP caller.
  // ---------------------------------------------------------------------------
  {
    name: 'get_workgroup_room',
    title: 'Read a workgroup task’s room',
    description:
      'The room behind a workgroup task: messages, assignment cards, member roster, and `pauseReason` when ' +
      'the task is parked on a human. Start here before posting or confirming.',
    permissions: [],
    inputSchema: { id: taskId },
    audit: (args) => ({ kind: 'workgroup-room', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.workgroupRoomGet({
          params: { taskId: String(args.id) },
        }),
      ),
  },
  {
    name: 'post_workgroup_message',
    title: 'Speak in a workgroup room',
    description:
      'ADVANCES THE RUN. A message mentioning "@member" dispatches a card straight to those members; ' +
      'a message with no mention lands on the blackboard and re-wakes a leader that had gone idle. ' +
      'Either way the engine is kicked, so do not use this as a note-to-self.',
    permissions: ['tasks:execute'],
    inputSchema: {
      id: taskId,
      body: z.string().min(1).max(65536).describe('Message text; "@member" tokens dispatch cards'),
    },
    audit: (args) => ({ kind: 'workgroup-room', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.workgroupMessagePost({
          params: { taskId: String(args.id) },
          body: { body: args.body },
        }),
      ),
  },
  {
    name: 'confirm_workgroup_step',
    title: 'Approve or reject a workgroup step',
    description:
      'ADVANCES THE RUN. Decides the gate a workgroup task is parked on. `reject` REQUIRES a comment ' +
      '(the route refuses without one) — that comment is what the agents read to know what to redo.',
    permissions: ['tasks:execute'],
    inputSchema: {
      id: taskId,
      decision: z.enum(['approve', 'reject']),
      comment: z.string().max(65536).optional().describe('Required when rejecting'),
    },
    audit: (args) => ({ kind: 'workgroup-gate', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.workgroupStepConfirm({
          params: { taskId: String(args.id) },
          body: { decision: args.decision, comment: args.comment },
        }),
      ),
  },
  {
    name: 'confirm_workgroup_dynamic_workflow',
    title: 'Approve or reject a generated workflow',
    description:
      'ADVANCES THE RUN. Same approve/reject shape as confirm_workgroup_step, but for the gate where a ' +
      'workgroup proposes a dynamically generated workflow. `reject` requires a comment.',
    permissions: ['tasks:execute'],
    inputSchema: {
      id: taskId,
      decision: z.enum(['approve', 'reject']),
      comment: z.string().max(65536).optional().describe('Required when rejecting'),
    },
    audit: (args) => ({ kind: 'workgroup-gate', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.workgroupDynamicWorkflowConfirm({
          params: { taskId: String(args.id) },
          body: { decision: args.decision, comment: args.comment },
        }),
      ),
  },
  {
    name: 'save_workgroup_dynamic_workflow',
    title: 'Keep a generated workflow as a real one',
    description:
      'Persist the workflow a workgroup generated as an ordinary workflow resource you can launch again. ' +
      'Creates a resource; does not advance the run.',
    // Cross-domain: the URL says workgroup-task, the effect creates a workflow.
    // The route ANDs both points, so a token holding only one of them is refused
    // — declaring only `workflows:create` here would have listed the tool for
    // callers who cannot use it.
    permissions: ['tasks:execute', 'workflows:create'],
    inputSchema: {
      id: taskId,
      name: z.string().min(1).describe('Name for the new workflow'),
      description: z.string().max(4096).optional(),
    },
    audit: (args) => ({ kind: 'workgroup-room', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.workgroupDynamicWorkflowSave({
          params: { taskId: String(args.id) },
          body: { name: args.name, description: args.description },
        }),
      ),
  },
  {
    name: 'deliver_workgroup_assignment',
    title: 'Hand in an assignment card',
    description:
      'ADVANCES THE RUN. Delivers the card dispatched to you. Two accepted shapes: a chat-style `body`, ' +
      'or a structured `summary` + `detail`. Give one of them.',
    permissions: ['tasks:execute'],
    inputSchema: {
      id: taskId,
      assignmentId: z.string().min(1),
      body: z.string().min(1).max(65536).optional().describe('Chat-style delivery'),
      summary: z.string().min(1).max(16384).optional().describe('Structured delivery: headline'),
      detail: z.string().max(65536).optional().describe('Structured delivery: the rest'),
    },
    audit: (args) => ({ kind: 'workgroup-assignment', id: String(args.assignmentId) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.workgroupAssignmentDeliver({
          params: { taskId: String(args.id), id: String(args.assignmentId) },
          body: { body: args.body, summary: args.summary, detail: args.detail },
        }),
      ),
  },
  {
    name: 'cancel_workgroup_assignment',
    title: 'Cancel an assignment card',
    description:
      'Withdraw a dispatched card without delivering it. Does not advance the run — the task stays parked ' +
      'until something else moves it.',
    permissions: ['tasks:execute'],
    inputSchema: { id: taskId, assignmentId: z.string().min(1) },
    audit: (args) => ({ kind: 'workgroup-assignment', id: String(args.assignmentId) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.workgroupAssignmentCancel({
          params: { taskId: String(args.id), id: String(args.assignmentId) },
        }),
      ),
  },
  // ---------------------------------------------------------------------------
  // RFC-329 —— the memory→skill fusion approval gate.
  //
  // Visibility note that MUST stay in the descriptions: the list route hands back
  // everything only to holders of `resource-acl:bypass`, and that point is a
  // system-domain one — no PAT can ever carry it. So on this channel these tools
  // are ALWAYS owner-scoped. Implying otherwise would have a model report "no
  // pending fusions" when it simply cannot see anyone else's.
  // ---------------------------------------------------------------------------
  {
    name: 'list_fusions',
    title: 'List memory→skill fusions',
    description:
      'Fusions you own, optionally filtered by state. Over MCP this is ALWAYS scoped to your own fusions — ' +
      'seeing everyone’s needs a permission no token can hold, so an empty list means "none of yours", ' +
      'not "none exist". Use `status: "awaiting_approval"` for the ones needing a decision.',
    permissions: [],
    inputSchema: {
      status: z
        .enum([
          'running',
          'awaiting_approval',
          'applying',
          'done',
          'rejected',
          'canceled',
          'failed',
        ])
        .optional()
        .describe('Exact state; unknown values are rejected here rather than silently ignored'),
      skillId: z.string().min(1).optional(),
    },
    audit: () => ({ kind: 'fusions' }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.fusionsList({
          query: {
            ...(typeof args.status === 'string' ? { status: args.status } : {}),
            ...(typeof args.skillId === 'string' ? { skillId: args.skillId } : {}),
          },
        }),
      ),
  },
  {
    name: 'get_fusion',
    title: 'Read one fusion, including its proposed diff',
    description:
      'The full fusion record with the change it proposes to the skill. Read this before approving — ' +
      'the list deliberately omits the diff to stay cheap.',
    permissions: [],
    inputSchema: { id: z.string().min(1) },
    audit: (args) => ({ kind: 'fusions', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(await ctx.operations.fusionGet({ params: { id: String(args.id) } })),
  },
  {
    name: 'approve_fusion',
    title: 'Approve a fusion',
    description:
      'IRREVERSIBLE. Bumps the skill to a new version with the proposed change and fuses the source ' +
      'memories into it. Read the diff with get_fusion first; there is no undo short of editing the skill ' +
      'back by hand.',
    permissions: ['skills:update', 'memory:update'],
    inputSchema: { id: z.string().min(1) },
    audit: (args) => ({ kind: 'fusions', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(await ctx.operations.fusionApprove({ params: { id: String(args.id) } })),
  },
  {
    name: 'reject_fusion',
    title: 'Reject a fusion and let it try again',
    description:
      'Sends the fusion back with feedback and RE-RUNS it — this is "try again with this guidance", not ' +
      '"drop it". Use cancel_fusion to stop it for good.',
    permissions: ['tasks:execute'],
    inputSchema: {
      id: z.string().min(1),
      feedback: z.string().min(1).max(4000).describe('What was wrong; the agent reads this'),
    },
    audit: (args) => ({ kind: 'fusions', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(
        await ctx.operations.fusionReject({
          params: { id: String(args.id) },
          body: { feedback: args.feedback },
        }),
      ),
  },
  {
    name: 'cancel_fusion',
    title: 'Cancel a fusion',
    description: 'Stop a fusion for good. Unlike reject_fusion this does not re-run it.',
    permissions: ['tasks:execute'],
    inputSchema: { id: z.string().min(1) },
    audit: (args) => ({ kind: 'fusions', id: String(args.id) }),
    handler: async (args, ctx) =>
      unwrap(await ctx.operations.fusionCancel({ params: { id: String(args.id) } })),
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
        await ctx.operations.reviewsList({
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
      unwrap(
        await ctx.operations.reviewGet({
          params: { nodeRunId: String(args.nodeRunId) },
        }),
      ),
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
        await ctx.operations.reviewDocumentGet({
          params: {
            nodeRunId: String(args.nodeRunId),
            versionId: String(args.docVersionId),
          },
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
      const [versions, rounds] = await Promise.all([
        ctx.operations.reviewVersionsList({
          params: { nodeRunId: String(args.nodeRunId) },
        }),
        ctx.operations.reviewRoundsList({
          params: { nodeRunId: String(args.nodeRunId) },
        }),
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
        await ctx.operations.reviewCommentAdd({
          params: { nodeRunId: String(args.nodeRunId) },
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
        await ctx.operations.reviewCommentUpdate({
          params: {
            nodeRunId: String(args.nodeRunId),
            commentId: String(args.commentId),
          },
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
        await ctx.operations.reviewCommentDelete({
          params: {
            nodeRunId: String(args.nodeRunId),
            commentId: String(args.commentId),
          },
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
        await ctx.operations.reviewSelectionSet({
          params: {
            nodeRunId: String(args.nodeRunId),
            docVersionId: String(args.docVersionId),
          },
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
        await ctx.operations.reviewSubmit({
          params: { nodeRunId: String(args.nodeRunId) },
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
interface ResourceOperationPresentation {
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

interface ResourcePresentation {
  readonly create?: ResourceOperationPresentation
  readonly update?: ResourceOperationPresentation
  readonly delete?: ResourceOperationPresentation
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

/**
 * MCP-only presentation quirks. Operation availability, method and path live
 * exclusively in RESOURCE_OPERATIONS; this table cannot recreate a transport
 * binding or silently drift from the catalog.
 */
const RESOURCE_PRESENTATION: Partial<Record<McpResourceKind, ResourcePresentation>> = {
  agents: {
    note: 'Updates and deletes are fenced: include `expectedUpdatedAt` and `expectedAclRevision` from a prior read.',
  },
  skills: {
    note:
      'Updates go through the combined-save endpoint and are fenced: include the `expectedToken` ' +
      'from a prior read. Deletes need `expectedToken` + `expectedAclRevision`.',
  },
  workflows: {
    note: 'Updates and deletes are fenced: include the `expectedVersion` from a prior read.',
  },
  workgroups: {
    note: 'Updates and deletes are fenced: include the `expectedVersion` from a prior read.',
  },
  'scheduled-tasks': {
    note:
      'Creating a schedule, or editing one in a way that arms a launch, additionally requires tasks:execute — ' +
      'a schedule is a launch with a delay.',
  },
  repos: {
    note:
      'Repos are imported in batches: `create` takes a batch payload, not one repo. There is no update — ' +
      'a mirror is refreshed, not edited. There is also no single-repo read: list and pick the row. ' +
      "`delete` needs that row's `urlRedacted` as `confirm`.",
  },
  'capability-templates': {
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
    delete: { forceQuery: true },
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
    delete: { confirmQuery: true },
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
      const method = args.method === 'get' ? 'get' : args.method === 'facets' ? 'facets' : 'list'
      const operation = resourceOperationFor(args.kind, method)
      return unwrap(
        await ctx.operations.dependency(operation, {
          ...(method === 'get' ? { params: { id: String(args.id) } } : {}),
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
      const method = args.method as 'create' | 'update' | 'delete'
      const operation = resourceOperationFor(args.kind, method)
      const presentation = resourcePresentationFor(args.kind)[method]
      if (method === 'create') {
        return unwrap(await ctx.operations.dependency(operation, { body: args.body ?? {} }))
      }
      if (typeof args.id !== 'string' || args.id === '') {
        throw new Error(`resource_write: \`id\` is required for ${method}`)
      }
      if (method === 'update') {
        return unwrap(
          await ctx.operations.dependency(operation, {
            params: { id: args.id },
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
        await ctx.operations.dependency(operation, {
          params: { id: args.id },
          // `memory` gates hard-delete on a `?confirm=true` QUERY (its own
          // pre-RFC-247 irreversibility ack) IN ADDITION to the token's
          // type-to-confirm body. Sending only the body made every memory
          // delete fail with `confirm-required`.
          query: {
            ...(presentation?.confirmQuery === true ? { confirm: 'true' } : {}),
            // RFC-248: 强制删除走查询串（REST 路由读的是 `?force=1`）。
            ...(presentation?.forceQuery === true && args.force === true ? { force: '1' } : {}),
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

function resourcePresentationFor(kind: unknown): ResourcePresentation {
  const operations = (RESOURCE_OPERATIONS as Readonly<Record<string, unknown>>)[String(kind)]
  if (operations === undefined) throw new Error(`unknown resource kind: ${String(kind)}`)
  return RESOURCE_PRESENTATION[kind as McpResourceKind] ?? {}
}

function resourceOperationFor(
  kind: unknown,
  method: 'list' | 'facets' | 'get' | 'create' | 'update' | 'delete',
): (typeof MCP_OPERATIONS)[keyof typeof MCP_OPERATIONS] {
  const operations = (
    RESOURCE_OPERATIONS as Readonly<
      Record<
        string,
        Partial<Record<typeof method, (typeof MCP_OPERATIONS)[keyof typeof MCP_OPERATIONS]>>
      >
    >
  )[String(kind)]
  const operation = operations?.[method]
  if (operation === undefined) {
    if (method === 'facets') {
      throw new Error(`${String(kind)} has no facets`)
    }
    const note = resourcePresentationFor(kind).note
    throw new Error(
      `unknown resource operation: ${String(kind)}:${method}` +
        (note === undefined ? '' : ` — ${note}`),
    )
  }
  return operation
}

export function describeResource(kind: McpResourceKind): {
  kind: McpResourceKind
  operations: Array<{ operation: string; method: string; path: string; permission: string | null }>
  bodySchemas: ResourceBodySchemas
  /** RFC-327: `resource_read`'s `query` contract for this kind, when it has one. */
  querySchema?: unknown
  note?: string
} {
  const presentation = resourcePresentationFor(kind)
  const ops: Array<{ operation: string; method: string; path: string; permission: string | null }> =
    []
  for (const operation of ['list', 'facets', 'get', 'create', 'update', 'delete'] as const) {
    const op = (
      RESOURCE_OPERATIONS as Readonly<
        Record<
          string,
          Partial<Record<typeof operation, (typeof MCP_OPERATIONS)[keyof typeof MCP_OPERATIONS]>>
        >
      >
    )[kind]?.[operation]
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
  return presentation.note === undefined ? withQuery : { ...withQuery, note: presentation.note }
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

const toolNames = new Set(ALL_TOOLS.map((tool) => tool.name))
const bindingNames = Object.keys(MCP_TOOL_BINDINGS)
const missingBindings = ALL_TOOLS.filter((tool) => bindingForTool(tool.name) === undefined).map(
  (tool) => tool.name,
)
const staleBindings = bindingNames.filter((name) => !toolNames.has(name))
if (missingBindings.length > 0 || staleBindings.length > 0) {
  throw new Error(
    `MCP operation binding closure mismatch: missing=[${missingBindings.join(', ')}] stale=[${staleBindings.join(', ')}]`,
  )
}
registerMcpOperationProjection(
  ALL_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    permissions: tool.permissions,
    binding: bindingForTool(tool.name)!,
  })),
  MCP_RESOURCE_KINDS.map((kind) => ({ kind, description: describeResource(kind) })),
)

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
