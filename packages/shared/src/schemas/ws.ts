// WebSocket message schemas for the three channels described in
// design/design.md §4.3. All messages are JSON; the daemon never sends
// binary frames in v1.

import { z } from 'zod'
import { TaskActorRoleSchema } from './resourceAcl'
import { TaskStatusSchema, TaskSummarySchema } from './task'
import { NodeRunStatusSchema } from './task'
import { DocVersionDecisionSchema, ReviewCommentSchema, ReviewDecisionKindSchema } from './review'
import { ClarifySessionSchema, ClarifySessionSummarySchema } from './clarify'
import { BatchImportRowSchema } from './repoBatchImport'
import { MemorySummarySchema } from './memory'
import { WorkflowMutationIdSchema, WorkflowSnapshotHashSchema } from './workflow'
import { WorkgroupMutationIdSchema, WorkgroupSnapshotHashSchema } from './workgroup'
import { McpRuntimeTestCaptureStateSchema, McpRuntimeTestTurnStatusSchema } from './mcpRuntimeTest'

// -----------------------------------------------------------------------------
// /ws/tasks/{taskId}
// -----------------------------------------------------------------------------

export const NodeEventKindSchema = z.enum([
  'tool_use',
  'text',
  'reasoning',
  'permission_asked',
  'error',
  'step_start',
  'step_finish',
  'stderr',
  // RFC-027: synthetic marker for post-run subagent capture failures.
  // Mirrors NODE_EVENT_KIND in schemas/task.ts.
  'subagent_capture_failed',
  // RFC-034: submodule init/sync warnings — mirror of NODE_EVENT_KIND.
  'submodule_init_failed',
  'submodule_sync_failed',
])
export type NodeEventKind = z.infer<typeof NodeEventKindSchema>

export const TaskWsMessageSchema = z.discriminatedUnion('type', [
  // RFC-164 PR-4 — workgroup room events ride the existing per-task channel
  // (same visibility gate as every other task frame). Payloads are id-only:
  // clients invalidate the room query instead of patching caches.
  z.object({
    id: z.number().int(),
    type: z.literal('wg.message.created'),
    messageId: z.string(),
    kind: z.string(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('wg.assignment.updated'),
    assignmentId: z.string(),
    status: z.string(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('wg.gate.updated'),
    awaitingConfirmation: z.boolean(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('task.status'),
    status: TaskStatusSchema,
    errorSummary: z.string().optional(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('node.status'),
    nodeRunId: z.string(),
    nodeId: z.string(),
    status: NodeRunStatusSchema,
    iteration: z.number().int().optional(),
    retryIndex: z.number().int().optional(),
    shardKey: z.string().optional(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('node.event'),
    nodeRunId: z.string(),
    ts: z.number().int(),
    kind: NodeEventKindSchema,
    payload: z.unknown(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('task.done'),
    status: z.enum(['done', 'failed', 'canceled', 'interrupted']),
  }),
  // -------------------------------------------------------------------------
  // RFC-005 review events. Delivered on the per-task /ws/tasks/{taskId}
  // channel — global Reviews tab uses polling + invalidation on its own.
  // -------------------------------------------------------------------------
  z.object({
    id: z.number().int(),
    type: z.literal('review.created'),
    nodeRunId: z.string(),
    reviewNodeId: z.string(),
    docVersionId: z.string(),
    versionIndex: z.number().int().positive(),
    reviewIteration: z.number().int().nonnegative(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('review.decision_made'),
    nodeRunId: z.string(),
    decision: ReviewDecisionKindSchema,
    /** New iteration index after this decision (post-bump). */
    reviewIteration: z.number().int().nonnegative(),
    /** Mirrors doc_versions.decision so listeners can refresh in one round-trip. */
    docVersionDecision: DocVersionDecisionSchema,
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('review.comment_added'),
    nodeRunId: z.string(),
    docVersionId: z.string(),
    comment: ReviewCommentSchema,
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('review.comment_deleted'),
    nodeRunId: z.string(),
    docVersionId: z.string(),
    commentId: z.string(),
  }),
  // RFC-009-T1: PATCH on an existing comment broadcasts the updated row so
  // other tabs can replace it in place without re-fetching the full review.
  z.object({
    id: z.number().int(),
    type: z.literal('review.comment_updated'),
    nodeRunId: z.string(),
    docVersionId: z.string(),
    comment: ReviewCommentSchema,
  }),
  // RFC-079: a multi-document review item's accepted/not_accepted choice
  // changed. Other tabs update the left-rail StatusChip + the approve gate
  // (all-decided) without re-fetching the full review.
  z.object({
    id: z.number().int(),
    type: z.literal('review.selection_changed'),
    nodeRunId: z.string(),
    docVersionId: z.string(),
    selection: z.enum(['unselected', 'accepted', 'not_accepted']),
  }),
  // -------------------------------------------------------------------------
  // RFC-023 clarify events. Broadcast on the same /ws/tasks/{taskId} channel
  // as review.* events. Payloads carry sourceShardKey so subscribers can
  // route updates to the correct shard tab in the detail UI.
  // -------------------------------------------------------------------------
  z.object({
    id: z.number().int(),
    type: z.literal('clarify.created'),
    /** node_runs.id of the clarify node instance (one per shard for wrapper-fanout inner agents). */
    nodeRunId: z.string(),
    /** Workflow node id of the clarify node. */
    clarifyNodeId: z.string(),
    /** Source-agent shard key when applicable; null for non-sharded agents. */
    sourceShardKey: z.string().nullable(),
    /** New iterationIndex for this clarify_session. */
    iterationIndex: z.number().int().nonnegative(),
    session: ClarifySessionSummarySchema,
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('clarify.answered'),
    nodeRunId: z.string(),
    clarifyNodeId: z.string(),
    sourceShardKey: z.string().nullable(),
    iterationIndex: z.number().int().nonnegative(),
    /** Newly minted source agent node_run id; subscribers can switch focus. */
    rerunNodeRunId: z.string(),
    session: ClarifySessionSchema,
  }),
  // RFC-099 (D8/D14) — synthetic frame (id:-1 like clarify.answered) fired on
  // every clarify draft save so other members' open forms live-update and
  // show "X just edited this question".
  z.object({
    id: z.number().int(),
    type: z.literal('clarify.draft.updated'),
    nodeRunId: z.string(),
    roundId: z.string(),
    questionId: z.string(),
    editor: z.object({
      userId: z.string(),
      displayName: z.string(),
      role: TaskActorRoleSchema,
    }),
    ts: z.number().int(),
  }),
  // -------------------------------------------------------------------------
  // RFC-056 cross-clarify events. Parallel to clarify.created / clarify.answered
  // but for the cross-agent path (different node kind + multi-source aggregation
  // + reject persistence). Subscribers route invalidation:
  //   - cross-clarify.created           → /api/clarify list (mixed) + detail.
  //   - cross-clarify.answered          → list + detail; UI may show "multi-source
  //                                       waiting" banner from the response.
  //   - cross-clarify.rejected          → same; UI flips the cross-clarify form
  //                                       to read-only + tells user reject took effect.
  // (cross-clarify.designer-rerun-batched removed by RFC-132 ②b — its only producer
  //  was the deleted legacy immediate-mint path; invalidation rides cross-clarify.answered.)
  // -------------------------------------------------------------------------
  z.object({
    id: z.number().int(),
    type: z.literal('cross-clarify.created'),
    nodeRunId: z.string(),
    crossClarifyNodeId: z.string(),
    sessionId: z.string(),
    iteration: z.number().int().nonnegative(),
    sourceQuestionerNodeId: z.string(),
    targetDesignerNodeId: z.string().nullable(),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('cross-clarify.answered'),
    nodeRunId: z.string(),
    sessionId: z.string(),
    iteration: z.number().int().nonnegative(),
    directive: z.enum(['continue', 'stop']),
  }),
  z.object({
    id: z.number().int(),
    type: z.literal('cross-clarify.rejected'),
    nodeRunId: z.string(),
    sessionId: z.string(),
    /** Freshly minted questioner rerun row carrying STOP CLARIFYING. */
    questionerNodeRunId: z.string(),
  }),
])
export type TaskWsMessage = z.infer<typeof TaskWsMessageSchema>

// -----------------------------------------------------------------------------
// /ws/tasks (list page)
// -----------------------------------------------------------------------------

export const TasksListWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task.created'), task: TaskSummarySchema }),
  z.object({ type: z.literal('task.status'), taskId: z.string(), status: TaskStatusSchema }),
  z.object({ type: z.literal('task.deleted'), taskId: z.string() }),
  // RFC-244: membership full-replace changed list visibility/Owner. The
  // process-local before/after audience is carried beside this wire frame.
  z.object({ type: z.literal('task.members.changed'), taskId: z.string() }),
  // RFC-330 D19/D20: an employee case's owner / members changed. Same
  // before/after audience mechanism as task.members.changed, keyed by caseId.
  z.object({ type: z.literal('employee-case.members.changed'), caseId: z.string() }),
  // RFC-053 P-3: the lifecycle invariant scan emitted a new finding (or
  // promoted an existing 'warning' to 'error'). Subscribers (the list page
  // + the future detail-page banner in PR-E) invalidate the per-task alerts
  // query so the red chip reflects current state without polling.
  z.object({
    type: z.literal('lifecycle.alert'),
    taskId: z.string(),
    rule: z.string(),
    severity: z.enum(['warning', 'error']),
    transition: z.enum(['new', 'promoted']),
  }),
  z.object({ type: z.literal('lifecycle.alert.resolved'), taskId: z.string() }),
])
export type TasksListWsMessage = z.infer<typeof TasksListWsMessageSchema>

// -----------------------------------------------------------------------------
// /ws/workflows (list + editor multi-tab sync)
// -----------------------------------------------------------------------------

export const WorkflowsWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workflow.created'),
    workflowId: z.string(),
    name: z.string(),
    version: z.number().int(),
  }),
  z.object({
    type: z.literal('workflow.updated'),
    workflowId: z.string(),
    clientMutationId: WorkflowMutationIdSchema,
    version: z.number().int(),
    snapshotHash: WorkflowSnapshotHashSchema,
    updatedAt: z.number().int(),
  }),
  z.object({
    type: z.literal('workflow.deleted'),
    workflowId: z.string(),
    clientMutationId: WorkflowMutationIdSchema,
    deletedVersion: z.number().int().positive(),
  }),
  // RFC-099 — fired on PUT /api/workflows/:id/acl. Carries no ACL payload;
  // clients re-fetch, and the WS server uses it to invalidate its
  // per-connection visibility cache for this workflowId.
  z.object({ type: z.literal('workflow.acl.updated'), workflowId: z.string() }),
])
export type WorkflowsWsMessage = z.infer<typeof WorkflowsWsMessageSchema>

// -----------------------------------------------------------------------------
// /ws/workgroups (list + editor multi-tab sync)
// -----------------------------------------------------------------------------

export const WorkgroupsWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workgroup.created'),
    workgroupId: z.string(),
    name: z.string(),
    version: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('workgroup.updated'),
    workgroupId: z.string(),
    clientMutationId: WorkgroupMutationIdSchema,
    version: z.number().int().positive(),
    snapshotHash: WorkgroupSnapshotHashSchema,
    updatedAt: z.number().int(),
  }),
  z.object({
    type: z.literal('workgroup.deleted'),
    workgroupId: z.string(),
    clientMutationId: WorkgroupMutationIdSchema,
    deletedVersion: z.number().int().positive(),
  }),
  z.object({ type: z.literal('workgroup.acl.updated'), workgroupId: z.string() }),
])
export type WorkgroupsWsMessage = z.infer<typeof WorkgroupsWsMessageSchema>

// -----------------------------------------------------------------------------
// /ws/repo-imports/{batchId} — RFC-033 batch import progress.
// -----------------------------------------------------------------------------

export const RepoImportWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('row.update'),
    row: BatchImportRowSchema,
  }),
  z.object({
    type: z.literal('batch.completed'),
    batchId: z.string(),
    completedAt: z.string(),
  }),
  z.object({
    type: z.literal('batch.error'),
    batchId: z.string(),
    errorCode: z.string(),
    message: z.string(),
  }),
])
export type RepoImportWsMessage = z.infer<typeof RepoImportWsMessageSchema>

// -----------------------------------------------------------------------------
// /ws/memories — RFC-041 platform memory candidate / promotion stream.
// All logged-in users may subscribe; the actual UI renders the approval queue
// badge only from row-level `canManage` values.
// -----------------------------------------------------------------------------

export const MemoryWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('memory.candidate.created'),
    memory: MemorySummarySchema,
  }),
  z.object({
    type: z.literal('memory.candidate.promoted'),
    memoryId: z.string(),
    newStatus: z.enum(['approved', 'rejected']),
    supersededIds: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('memory.archived'), memoryId: z.string() }),
  z.object({ type: z.literal('memory.unarchived'), memoryId: z.string() }),
  z.object({ type: z.literal('memory.deleted'), memoryId: z.string() }),
  z.object({
    type: z.literal('memory.superseded'),
    oldId: z.string(),
    newId: z.string(),
  }),
  // RFC-045/RFC-305/RFC-342: permission-gated content edit or dedicated scope move.
  // changedFields is the non-empty subset that actually changed in the PATCH
  // or Move command; version is the resulting row.version (>= 2 since version
  // 1 belongs to creation/promote, never to a mutation). Subscribed clients
  // use changedFields for granular toasts; useMemoryWs already routes any
  // 'memory.*' event to full invalidation, so this case is additive.
  z.object({
    type: z.literal('memory.updated'),
    memoryId: z.string(),
    changedFields: z
      .array(z.enum(['scopeType', 'scopeId', 'title', 'bodyMd', 'tags']))
      .min(1)
      .max(5),
    version: z.number().int().min(2),
  }),
])
export type MemoryWsMessage = z.infer<typeof MemoryWsMessageSchema>

// -----------------------------------------------------------------------------
// /ws/memory-distill-jobs — RFC-041/RFC-305 capability-gated distill monitor.
// Backend WS upgrade requires `memory-distill-jobs:manage` + `memory:update`.
// -----------------------------------------------------------------------------

export const MemoryDistillJobWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('distill.queued'),
    jobId: z.string(),
    debounceKey: z.string(),
  }),
  z.object({ type: z.literal('distill.started'), jobId: z.string() }),
  z.object({
    type: z.literal('distill.done'),
    jobId: z.string(),
    candidatesCreated: z.number().int(),
  }),
  z.object({
    type: z.literal('distill.failed'),
    jobId: z.string(),
    error: z.string(),
  }),
])
export type MemoryDistillJobWsMessage = z.infer<typeof MemoryDistillJobWsMessageSchema>

// RFC-159 — scheduled-task list stream. `ownerUserId` rides on every frame so the
// per-frame gate can filter to owner + `tasks:read:all` without a DB lookup.
export const ScheduledTaskWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scheduled.created'), id: z.string(), ownerUserId: z.string() }),
  z.object({ type: z.literal('scheduled.updated'), id: z.string(), ownerUserId: z.string() }),
  z.object({ type: z.literal('scheduled.deleted'), id: z.string(), ownerUserId: z.string() }),
  z.object({ type: z.literal('scheduled.fired'), id: z.string(), ownerUserId: z.string() }),
])
export type ScheduledTaskWsMessage = z.infer<typeof ScheduledTaskWsMessageSchema>

// RFC-234 — intent-session stream. `ownerUserId` rides on every frame so the
// per-frame gate filters to creator + `intent:audit` (D26 / RFC-305)
// without a DB lookup. Frames are invalidation signals; payloads stay in HTTP.
export const IntentSessionWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('intent.turn.started'),
    sessionId: z.string(),
    turnId: z.string(),
    ownerUserId: z.string(),
  }),
  z.object({
    type: z.literal('intent.turn.finished'),
    sessionId: z.string(),
    turnId: z.string(),
    ownerUserId: z.string(),
  }),
  z.object({
    type: z.literal('intent.turn.execution.updated'),
    sessionId: z.string(),
    turnId: z.string(),
    eventSeq: z.number().int().min(0),
    ownerUserId: z.string(),
  }),
  z.object({
    type: z.literal('intent.session.updated'),
    sessionId: z.string(),
    ownerUserId: z.string(),
  }),
  z.object({
    type: z.literal('intent.apply.committed'),
    sessionId: z.string(),
    journalId: z.string(),
    ownerUserId: z.string(),
  }),
])
export type IntentSessionWsMessage = z.infer<typeof IntentSessionWsMessageSchema>

// RFC-238 — private MCP runtime-test locator stream. Transcript/tool payloads
// remain on owner-gated REST endpoints; this frame only tells the client which
// durable projection/cursor to refresh.
export const McpRuntimeTestWsMessageSchema = z
  .object({
    type: z.literal('mcp-runtime-test.updated'),
    sessionId: z.string().min(1).max(128),
    sessionVersion: z.number().int().nonnegative(),
    inFlightTurnId: z.string().min(1).max(128).nullable(),
    turnStatus: McpRuntimeTestTurnStatusSchema.nullable(),
    eventCursor: z.number().int().nonnegative(),
    captureState: McpRuntimeTestCaptureStateSchema.nullable(),
  })
  .strict()
export type McpRuntimeTestWsMessage = z.infer<typeof McpRuntimeTestWsMessageSchema>

// -----------------------------------------------------------------------------
// RFC-312 —— presence（用户在线状态）。
//
// 只有两个变体：连接建立时一次全量 `presence.snapshot`，之后是合并窗口刷出的
// `presence.changed` 增量。**没有"撤权"帧**——权限被收回时整条连接会被既有的
// rerunUpgradeGate 关掉（4403），客户端据此清空自己的 store，不需要任何服务端重同步协议。
// -----------------------------------------------------------------------------

export const PresenceWsMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('presence.snapshot'),
      /** 当前在线的 userId 全集。规模 = 在线人数，与用户表规模无关。 */
      online: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      type: z.literal('presence.changed'),
      changes: z.array(z.object({ userId: z.string(), online: z.boolean() }).strict()).nonempty(),
    })
    .strict(),
])
export type PresenceWsMessage = z.infer<typeof PresenceWsMessageSchema>

// -----------------------------------------------------------------------------
// Client → server control frames common to every channel.
// -----------------------------------------------------------------------------

export const WsClientControlMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping'), nonce: z.number().int().nonnegative() }).strict(),
])
export type WsClientControlMessage = z.infer<typeof WsClientControlMessageSchema>

// -----------------------------------------------------------------------------
// Server → client control frames common to every channel.
// -----------------------------------------------------------------------------

export const WsControlMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), channel: z.string(), since: z.number().int().optional() }),
  z.object({ type: z.literal('pong'), nonce: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('authority.changed'), revision: z.number().int().nonnegative() }),
  /**
   * RFC-324 —— 某个资源的授权面变了（档位、名单、可见性或 owner）。
   *
   * 刻意**不带 resourceId**：客户端要做的是让本地缓存的授权判定失效，而它同时
   * 持有的 ACL 判定至多是屏幕上打开的那一两个（权限面板 + 当前详情页）。带上 id
   * 就得让服务端算出"谁关心这一行"，那是一份比它防的问题更贵的账。
   *
   * 与 `authority.changed` 分开：那条说的是**账号自己的**权限集变了（刷新 /me），
   * 这条说的是**某个资源行**的授权变了（刷新 ACL 判定）。合并会让任一侧的变更
   * 都去拉另一侧的接口。
   */
  z.object({ type: z.literal('resource-acl.changed') }),
])
export type WsControlMessage = z.infer<typeof WsControlMessageSchema>

// -----------------------------------------------------------------------------
// RFC-152 — double-ended WS path constants. The single source for every WS
// endpoint path: frontend hooks / components build their subscription URLs
// from these (no hand-written `/ws/...` strings), and the backend registry's
// pathRes are interlock-tested against them
// (packages/backend/tests/rfc152-ws-paths-interlock.test.ts), so the two
// sides cannot drift apart silently.
// -----------------------------------------------------------------------------

export const WS_PATHS = {
  /** Authenticated app-wide authority revision stream. */
  authority: '/ws/authority',
  /** Per-task detail stream (`?since=N` replays node_run_events). */
  task: (taskId: string): string => `/ws/tasks/${encodeURIComponent(taskId)}`,
  /** Global task list stream (per-frame RBAC-filtered). */
  tasksList: '/ws/tasks',
  /** Workflow list + editor multi-tab sync (per-frame ACL-filtered). */
  workflows: '/ws/workflows',
  /** Workgroup list + editor multi-tab sync (per-frame ACL-filtered). */
  workgroups: '/ws/workgroups',
  /** RFC-033 — per-batch repo import progress. */
  repoImport: (batchId: string): string => `/ws/repo-imports/${encodeURIComponent(batchId)}`,
  /** RFC-041 — platform memory candidate / promotion stream (per-frame scope-filtered). */
  memories: '/ws/memories',
  /** RFC-041/RFC-305 — distill queue monitor (`memory-distill-jobs:manage` upgrade gate). */
  memoryDistillJobs: '/ws/memory-distill-jobs',
  /** RFC-159 — scheduled-task list stream (per-frame owner/`tasks:read:all` filtered). */
  scheduledTasks: '/ws/scheduled-tasks',
  /** RFC-234/RFC-305 — intent-session stream (creator + `intent:audit`). */
  intentSessions: '/ws/intent-sessions',
  /** RFC-238 — MCP runtime-test locator stream (creator only). */
  mcpRuntimeTests: '/ws/mcp-runtime-tests',
  /** RFC-312 — 在线状态流（`users:presence` 升级门；整条连接级鉴权，无 frameGate）。 */
  presence: '/ws/presence',
} as const
