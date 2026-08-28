import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'
import type { NodeExecutor } from './nodeExecutor'

export interface ChildCallNodeExecutionPort {
  executeWorkflow(request: NodeStepRequest<'call-workflow'>): Promise<NodeStepOutcome>
  executeWorkgroup(request: NodeStepRequest<'call-workgroup'>): Promise<NodeStepOutcome>
}

export class CallWorkflowNodeExecutor implements NodeExecutor<'call-workflow'> {
  readonly kind = 'call-workflow' as const

  constructor(private readonly port: ChildCallNodeExecutionPort) {}

  execute(request: NodeStepRequest<'call-workflow'>): Promise<NodeStepOutcome> {
    return this.port.executeWorkflow(request)
  }
}

export class CallWorkgroupNodeExecutor implements NodeExecutor<'call-workgroup'> {
  readonly kind = 'call-workgroup' as const

  constructor(private readonly port: ChildCallNodeExecutionPort) {}

  execute(request: NodeStepRequest<'call-workgroup'>): Promise<NodeStepOutcome> {
    return this.port.executeWorkgroup(request)
  }
}
