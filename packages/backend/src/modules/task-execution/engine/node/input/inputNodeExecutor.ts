import type { InputNodeExecutionPorts } from '../../../application/ports/virtualIoNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import type { NodeExecutor } from '../nodeExecutor'
import { runInputNode } from './runInputNode'

export class InputNodeExecutor implements NodeExecutor<'input'> {
  readonly kind = 'input' as const
  constructor(private readonly ports: InputNodeExecutionPorts) {}
  execute(request: NodeStepRequest<'input'>): Promise<NodeStepOutcome> {
    return runInputNode(this.ports, request)
  }
}
