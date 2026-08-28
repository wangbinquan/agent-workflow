import type { Agent, FailureCode } from '@agent-workflow/shared'
import type { NodeExecutionContextRef, NodeExecutionTaskRef } from '../../domain/nodeExecution'

/** One already-admitted host row. Assignment and turn strategy remain outside this port. */
export interface WorkgroupHostRef {
  readonly nodeRunId: string
  readonly nodeId: string
  readonly agent: Agent
  readonly promptTemplate: string
  readonly workgroupProtocolBlock?: string
  readonly discardWrites?: boolean
  readonly clarifyEnabled?: boolean
  readonly hostOutputPorts?: readonly string[]
}

export interface WorkgroupHostExecutionRequest {
  readonly lane: 'workgroup-host'
  readonly task: NodeExecutionTaskRef
  readonly host: WorkgroupHostRef
  readonly execution: NodeExecutionContextRef
}

export interface WorkgroupHostExecutionResult {
  readonly status: 'done' | 'failed' | 'canceled' | 'awaiting'
  readonly outputs: Readonly<Record<string, string>>
  readonly clarifyQuestionCount?: number
  readonly errorMessage?: string
  readonly processUnreaped?: true
  readonly failureCode?: FailureCode
}

export interface WorkgroupHostExecutionPort {
  executeHost(request: WorkgroupHostExecutionRequest): Promise<WorkgroupHostExecutionResult>
}
