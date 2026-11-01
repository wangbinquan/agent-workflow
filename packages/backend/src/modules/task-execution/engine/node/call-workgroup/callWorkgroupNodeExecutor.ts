import type { ChildCallNodeExecutionPorts } from '../../../application/ports/childCallNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import type { NodeExecutor } from '../nodeExecutor'
import { runChildCallNode } from '../shared/child-call/runChildCallNode'

export class CallWorkgroupNodeExecutor implements NodeExecutor<'call-workgroup'> {
  readonly kind = 'call-workgroup' as const
  constructor(private readonly ports: ChildCallNodeExecutionPorts) {}
  execute(request: NodeStepRequest<'call-workgroup'>): Promise<NodeStepOutcome> {
    return runChildCallNode(this.ports, request)
  }
}
