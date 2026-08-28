import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'
import type { NodeExecutor } from './nodeExecutor'

export interface ScriptNodeExecutionPort {
  executeScript(request: NodeStepRequest<'script'>): Promise<NodeStepOutcome>
}

export class ScriptNodeExecutor implements NodeExecutor<'script'> {
  readonly kind = 'script' as const

  constructor(private readonly port: ScriptNodeExecutionPort) {}

  execute(request: NodeStepRequest<'script'>): Promise<NodeStepOutcome> {
    return this.port.executeScript(request)
  }
}
