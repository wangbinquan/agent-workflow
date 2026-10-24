export interface ResourceLimitCancellationAudit {
  readonly taskId: string
  readonly reason: string
  readonly now: number
}

export interface ResourceLimitAudit {
  recordLimitCancellation(input: ResourceLimitCancellationAudit): Promise<void>
}
