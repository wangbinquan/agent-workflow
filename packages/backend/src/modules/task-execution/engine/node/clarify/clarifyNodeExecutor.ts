import type { ClarifyNodeExecutionPorts } from '../../../application/ports/humanGateNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import type { NodeExecutor } from '../nodeExecutor'
import { settleIdleClarify } from './settleIdleClarify'

export class ClarifyNodeExecutor implements NodeExecutor<'clarify'> {
  readonly kind = 'clarify' as const
  constructor(private readonly ports: ClarifyNodeExecutionPorts) {}
  execute(request: NodeStepRequest<'clarify'>): Promise<NodeStepOutcome> {
    return settleIdleClarify(this.ports, request)
  }
}
