export interface ReviewRepairInspection {
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
export interface ReviewRepairParticipant {
  inspect(input: {
    readonly taskId: string
    readonly docVersionId: string
    readonly nodeRunId: string
  }): Promise<ReviewRepairInspection | null>
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
