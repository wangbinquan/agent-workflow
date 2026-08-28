import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'
import type { NodeExecutor } from './nodeExecutor'

export interface CodeHostCallNodeExecutionPort {
  executeCodeHostCall(request: NodeStepRequest<'code-host-call'>): Promise<NodeStepOutcome>
}

export class CodeHostCallNodeExecutor implements NodeExecutor<'code-host-call'> {
  readonly kind = 'code-host-call' as const

  constructor(private readonly port: CodeHostCallNodeExecutionPort) {}

  execute(request: NodeStepRequest<'code-host-call'>): Promise<NodeStepOutcome> {
    return this.port.executeCodeHostCall(request)
  }
}
