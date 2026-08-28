import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'

export type WrapperNodeKind = 'wrapper-git' | 'wrapper-loop' | 'wrapper-fanout'

/** W2-C delegation seam; the implementation remains owned by W2-D. */
export interface WrapperNodeExecutionPort {
  execute<K extends WrapperNodeKind>(kind: K, request: NodeStepRequest<K>): Promise<NodeStepOutcome>
}
