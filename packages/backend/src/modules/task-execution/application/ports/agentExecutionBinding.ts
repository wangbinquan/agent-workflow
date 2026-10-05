import type {
  ExecutionEffectPort,
  ExecutionEffectResult,
  ExecutionStartReceipt,
} from './executionEffect'
import type { ProcessEffectProjection } from './processEffectProjection'
import type { Logger } from '@/util/log'

/** The execution owner issues this participant in the same selected
 * composition as its binding. Implementations keep persistence and receipt
 * dialects private; consumers only forward the opaque participant. */
declare const agentExecutionTaskParticipantBrand: unique symbol
interface AgentExecutionTaskParticipant {
  readonly [agentExecutionTaskParticipantBrand]: 'agent-execution-task-participant'
}

export interface AgentExecutionParticipants {
  readonly taskEffect?: AgentExecutionTaskParticipant
}

/** One material-bound attempt. Receipts and terminal projections are opaque
 * to callers; their native/hosted implementation owns the persistence dialect. */
export interface AgentExecutionBinding {
  readonly effect: ExecutionEffectPort
  readonly executionRef: string
  readonly materialRef: string
  readonly workspaceRef: string
  readonly projection?: ProcessEffectProjection<ExecutionStartReceipt, ExecutionEffectResult>
  acknowledgeOwner(receipt: ExecutionStartReceipt): void | Promise<void>
  recordTaskReceipt(receipt: ExecutionStartReceipt, nodeRunId: string): Promise<void>
  reportUnreaped(
    result: ExecutionEffectResult,
    input: { readonly nodeRunId: string; readonly deadlineMs: number; readonly log: Logger },
  ): void
  unreapedMessage(result: ExecutionEffectResult, deadlineMs: number): string
}
