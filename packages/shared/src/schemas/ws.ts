// WebSocket message schemas for the three channels described in
// design/design.md §4.3. All messages are JSON; the daemon never sends
// binary frames in v1.

import { z } from 'zod'
import { TaskStatusSchema, TaskSummarySchema } from './task'
import { NodeRunStatusSchema } from './task'
import { DocVersionDecisionSchema, ReviewCommentSchema, ReviewDecisionKindSchema } from './review'
import { ClarifySessionSchema, ClarifySessionSummarySchema } from './clarify'
import { BatchImportRowSchema } from './repoBatchImport'
import { MemorySummarySchema } from './memory'

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
  // -------------------------------------------------------------------------
  // RFC-056 cross-clarify events. Parallel to clarify.created / clarify.answered
  // but for the cross-agent path (different node kind + multi-source aggregation
  // + reject persistence). Subscribers route invalidation:
  //   - cross-clarify.created           → /api/clarify list (mixed) + detail.
  //   - cross-clarify.answered          → list + detail; UI may show "multi-source
  //                                       waiting" banner from the response.
  //   - cross-clarify.rejected          → same; UI flips the cross-clarify form
  //                                       to read-only + tells user reject took effect.
  //   - cross-clarify.designer-rerun-batched → task detail nodeRuns tab; the
  //                                       new designer node_run is now pending.
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
  z.object({
    id: z.number().int(),
    type: z.literal('cross-clarify.designer-rerun-batched'),
    /** Freshly minted designer rerun row at clarifyIteration + 1
     *  (RFC-064 unified counter; event name + payload shape unchanged). */
    designerNodeRunId: z.string(),
    /** Cross-clarify source questioner NodeIds whose sessions fed this batch. */
    sourceQuestionerNodeIds: z.array(z.string()).min(1),
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
    version: z.number().int(),
    updatedAt: z.number().int(),
  }),
  z.object({ type: z.literal('workflow.deleted'), workflowId: z.string() }),
])
export type WorkflowsWsMessage = z.infer<typeof WorkflowsWsMessageSchema>

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
// All logged-in users may subscribe; the actual UI only renders the admin
// "approval queue" badge when the actor's role allows it.
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
  // RFC-045: in-place admin edit of candidate / approved / archived rows.
  // changedFields is the (non-empty) subset of {scopeType, scopeId, title,
  // bodyMd, tags} that actually changed in this PATCH; version is the
  // resulting row.version (>= 2 since version 1 belongs to creation/promote,
  // never to PATCH). Subscribed clients use changedFields for granular
  // toasts; useMemoryWs already routes any 'memory.*' event to full
  // invalidation, so this case is additive.
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
// /ws/memory-distill-jobs — RFC-041 admin monitor of the distill queue.
// Subscribed only by admin clients; backend WS upgrade enforces the same.
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

// -----------------------------------------------------------------------------
// Server → client control frames common to every channel.
// -----------------------------------------------------------------------------

export const WsControlMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), channel: z.string(), since: z.number().int().optional() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
])
export type WsControlMessage = z.infer<typeof WsControlMessageSchema>
