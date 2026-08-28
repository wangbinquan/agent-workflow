import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'
import type { NodeExecutor } from './nodeExecutor'

export interface VirtualIoNodeExecutionPort {
  executeInput(request: NodeStepRequest<'input'>): Promise<NodeStepOutcome>
  executeOutput(request: NodeStepRequest<'output'>): Promise<NodeStepOutcome>
}

export class InputNodeExecutor implements NodeExecutor<'input'> {
  readonly kind = 'input' as const

  constructor(private readonly port: VirtualIoNodeExecutionPort) {}

  execute(request: NodeStepRequest<'input'>): Promise<NodeStepOutcome> {
    return this.port.executeInput(request)
  }
}

export class OutputNodeExecutor implements NodeExecutor<'output'> {
  readonly kind = 'output' as const

  constructor(private readonly port: VirtualIoNodeExecutionPort) {}

  execute(request: NodeStepRequest<'output'>): Promise<NodeStepOutcome> {
    return this.port.executeOutput(request)
  }
}
