import type { ChildCallNodeExecutionPorts } from '../../../application/ports/childCallNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import type { NodeExecutor } from '../nodeExecutor'
import { runChildCallNode } from '../shared/child-call/runChildCallNode'

export class CallWorkflowNodeExecutor implements NodeExecutor<'call-workflow'> {
  readonly kind = 'call-workflow' as const
  constructor(private readonly ports: ChildCallNodeExecutionPorts) {}
  execute(request: NodeStepRequest<'call-workflow'>): Promise<NodeStepOutcome> {
    return runChildCallNode(this.ports, request)
  }
}
