import type { NodeStepOutcome } from '../../domain/nodeExecution'
import type { WrapperExecutionRequest, WrapperNodeKind } from '../../domain/wrapperExecution'

export type { WrapperNodeKind } from '../../domain/wrapperExecution'

/** Closed W2-C delegation seam implemented by the W2-D WrapperRuntime. */
export interface WrapperNodeExecutionPort {
  execute<K extends WrapperNodeKind>(
    kind: K,
    request: WrapperExecutionRequest<K>,
  ): Promise<NodeStepOutcome>
}
