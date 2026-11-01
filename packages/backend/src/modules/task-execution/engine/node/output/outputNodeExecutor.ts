import type { OutputNodeExecutionPorts } from '../../../application/ports/virtualIoNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import type { NodeExecutor } from '../nodeExecutor'
import { runOutputNode } from './runOutputNode'

export class OutputNodeExecutor implements NodeExecutor<'output'> {
  readonly kind = 'output' as const
  constructor(private readonly ports: OutputNodeExecutionPorts) {}
  execute(request: NodeStepRequest<'output'>): Promise<NodeStepOutcome> {
    return runOutputNode(this.ports, request)
  }
}
