import type { CrossClarifyNodeExecutionPorts } from '../../../application/ports/humanGateNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import type { NodeExecutor } from '../nodeExecutor'
import { runCrossClarifyNode } from './runCrossClarifyNode'

export class CrossClarifyNodeExecutor implements NodeExecutor<'clarify-cross-agent'> {
  readonly kind = 'clarify-cross-agent' as const
  constructor(private readonly ports: CrossClarifyNodeExecutionPorts) {}
  execute(request: NodeStepRequest<'clarify-cross-agent'>): Promise<NodeStepOutcome> {
    return runCrossClarifyNode(this.ports, request)
  }
}
