// RFC-580 — the task-scoped workgroup room contracts: the route module, its command and query ports and their
// submissions / receipts. They left `public/` with the room HTTP binding (now `inbound/http/workgroupTaskRoutes.ts`).
import type { WorkgroupOperationContext } from '../../public/participants'

/**
 * Closed transport envelopes for the task-scoped Workgroup room.  The room
 * projection intentionally remains serialized here: it contains historical
 * template metadata whose JSON vocabulary is wider than the public Resource
 * Catalog contract, while the HTTP adapter must preserve the existing wire
 * byte-for-byte without exposing an open object or a persistence row.
 */
export interface WorkgroupTaskJsonSubmission {
  readonly kind: 'json-body'
  readonly body: string
}

export interface WorkgroupTaskJsonDocument {
  readonly kind: 'json-document'
  readonly body: string
}

export interface WorkgroupTaskRef {
  readonly taskId: string
}

export interface WorkgroupTaskSubmission extends WorkgroupTaskRef {
  readonly submission: WorkgroupTaskJsonSubmission
}

export interface WorkgroupTaskAssignmentRef extends WorkgroupTaskRef {
  readonly assignmentId: string
}

export interface WorkgroupTaskAssignmentSubmission extends WorkgroupTaskAssignmentRef {
  readonly submission: WorkgroupTaskJsonSubmission
}

export interface WorkgroupTaskMessageReceipt {
  readonly messageId: string
  readonly assignmentIds: readonly string[]
}

export interface WorkgroupTaskDeliveryReceipt {
  readonly messageId: string
}

export interface WorkgroupTaskDecisionReceipt {
  readonly decision: 'approve' | 'reject'
  readonly exhausted?: true
}

export interface WorkgroupTaskWorkflowReceipt {
  readonly id: string
  readonly name: string
}

export interface WorkgroupTaskConfigReceipt {
  readonly changes: readonly string[]
}

/** Task-scoped Workgroup mutations; transport parsing and provider clients stay private. */
export interface WorkgroupTaskRoomCommands {
  postMessage(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskSubmission,
  ): Promise<WorkgroupTaskMessageReceipt>
  deliverAssignment(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskAssignmentSubmission,
  ): Promise<WorkgroupTaskDeliveryReceipt>
  confirmGate(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskSubmission,
  ): Promise<WorkgroupTaskDecisionReceipt>
  confirmDynamicWorkflow(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskSubmission,
  ): Promise<WorkgroupTaskDecisionReceipt>
  saveDynamicWorkflow(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskSubmission,
  ): Promise<WorkgroupTaskWorkflowReceipt>
  updateConfig(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskSubmission,
  ): Promise<WorkgroupTaskConfigReceipt>
  cancelAssignment(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskAssignmentRef,
  ): Promise<void>
}

/** Task-scoped Workgroup room projections encoded as closed JSON documents. */
export interface WorkgroupTaskRoomQueries {
  pendingCount(authority: WorkgroupOperationContext): Promise<WorkgroupTaskJsonDocument>
  pending(authority: WorkgroupOperationContext): Promise<WorkgroupTaskJsonDocument>
  room(
    authority: WorkgroupOperationContext,
    input: WorkgroupTaskRef,
  ): Promise<WorkgroupTaskJsonDocument>
}

/** Required route binding for the task-scoped room/config/action aggregate. */
export interface WorkgroupTaskRoomModule {
  readonly commands: WorkgroupTaskRoomCommands
  readonly queries: WorkgroupTaskRoomQueries
}
