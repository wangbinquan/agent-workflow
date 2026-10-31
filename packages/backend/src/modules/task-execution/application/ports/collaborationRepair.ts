/**
 * Collaboration-owned repair command consumed by Task Execution's lifecycle
 * repair coordinator. Only business identity and the observed closed state
 * cross the boundary; the selected provider retains the clarify-table CAS.
 */
export interface TaskClarifyRepairPort {
  hasOpenForNodeRun(input: {
    readonly taskId: string
    readonly nodeRunId: string
  }): Promise<boolean>
  latestClosedForNodeRun(input: { readonly taskId: string; readonly nodeRunId: string }): Promise<{
    readonly roundId: string
    readonly status: 'answered' | 'canceled' | 'abandoned'
  } | null>
  reopen(input: {
    readonly taskId: string
    readonly roundId: string
    readonly expectedStatus: 'answered' | 'canceled' | 'abandoned'
    readonly occurredAt: number
  }): Promise<boolean>
}

export interface TaskReviewRepairInspection {
  readonly decision: 'pending' | 'approved' | 'rejected' | 'iterated' | 'superseded'
  readonly versionIndex: number
  readonly reviewIteration: number
  readonly sourceFilePath: string | null
  readonly hasApprovedDocOutput: boolean
  readonly hasApprovalMetaOutput: boolean
}

/**
 * Collaboration-owned R1 facts used by Task Execution's lifecycle repair
 * coordinator. The coordinator owns the review-node lifecycle CAS; this port
 * owns the document decision and the two approval output facts.
 */
export interface TaskReviewRepairPort {
  inspect(input: {
    readonly taskId: string
    readonly docVersionId: string
    readonly nodeRunId: string
  }): Promise<TaskReviewRepairInspection | null>
  completeApproved(input: {
    readonly taskId: string
    readonly docVersionId: string
    readonly nodeRunId: string
    readonly occurredAt: number
  }): Promise<boolean>
  unapprove(input: {
    readonly taskId: string
    readonly docVersionId: string
    readonly nodeRunId: string
  }): Promise<boolean>
}

export interface CollaborationRepairPorts {
  readonly clarify: TaskClarifyRepairPort
  readonly review: TaskReviewRepairPort
}
