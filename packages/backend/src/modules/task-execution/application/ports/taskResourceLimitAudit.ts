// RFC-477 —— the resource-limit policy's durable cancel audit, declared by task-execution (the consumer).
//
// The audit is written by system-operations (`createResourceLimitAudit`); bootstrap spreads that implementation into
// the policy's persistence, which satisfies this port structurally. Task-execution therefore never imports
// system-operations: the target DAG has no task-execution → system-operations offered edge, and type edges count too.

export interface TaskResourceLimitCancellationAudit {
  readonly taskId: string
  readonly reason: string
  readonly now: number
}

export interface TaskResourceLimitAudit {
  recordLimitCancellation(input: TaskResourceLimitCancellationAudit): Promise<void>
}
