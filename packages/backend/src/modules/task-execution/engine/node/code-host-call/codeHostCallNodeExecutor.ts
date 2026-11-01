import type { CodeHostNodeExecutionPorts } from '../../../application/ports/codeHostNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import type { NodeExecutor } from '../nodeExecutor'
import { runCodeHostCallNode } from './runCodeHostCallNode'

export class CodeHostCallNodeExecutor implements NodeExecutor<'code-host-call'> {
  readonly kind = 'code-host-call' as const
  constructor(private readonly ports: CodeHostNodeExecutionPorts) {}
  execute(request: NodeStepRequest<'code-host-call'>): Promise<NodeStepOutcome> {
    return runCodeHostCallNode(this.ports, request)
  }
}
