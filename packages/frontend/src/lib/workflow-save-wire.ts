// RFC-199 B1 frontend adapter for the revision-fenced workflow wire.
//
// The composite/single-flight draft state machine lands in B2. Until then,
// keep request construction and receipt projection in small pure seams so no
// editor caller can accidentally fall back to the pre-RFC partial PUT shape.

import type {
  DeleteWorkflow,
  SaveWorkflowReceipt,
  UpdateWorkflow,
  WorkflowDetail,
  WorkflowDraftSnapshot,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'

export function makeWorkflowSaveRequest(
  expectedVersion: number,
  snapshot: WorkflowDraftSnapshot,
): UpdateWorkflow {
  return {
    expectedVersion,
    clientMutationId: ulid(),
    snapshot,
  }
}

export function makeWorkflowDeleteRequest(
  expectedVersion: number,
  confirm: string,
): DeleteWorkflow {
  return {
    expectedVersion,
    clientMutationId: ulid(),
    // RFC-222 (D5): the user's typed confirmation, echoed to the server.
    confirm,
  }
}

/** Project the fenced receipt onto the already-authorized detail cache row. */
export function applyWorkflowSaveReceipt(
  current: WorkflowDetail,
  receipt: SaveWorkflowReceipt,
): WorkflowDetail {
  if (receipt.revision.workflowId !== current.id) {
    throw new Error('workflow save receipt belongs to a different workflow')
  }
  return {
    ...current,
    ...receipt.snapshot,
    version: receipt.revision.version,
    updatedAt: receipt.revision.updatedAt,
    snapshotHash: receipt.revision.snapshotHash,
  }
}
