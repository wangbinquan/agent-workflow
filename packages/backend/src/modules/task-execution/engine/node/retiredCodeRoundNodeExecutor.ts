import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'
import type { NodeExecutor } from './nodeExecutor'

export class RetiredCodeRoundNodeExecutor implements NodeExecutor<'code-round'> {
  readonly kind = 'code-round' as const

  async execute(_request: NodeStepRequest<'code-round'>): Promise<NodeStepOutcome> {
    return {
      kind: 'failed',
      summary: 'code-round execution was retired by RFC-310; use development missions',
      message: 'code-round-retired',
    }
  }
}
