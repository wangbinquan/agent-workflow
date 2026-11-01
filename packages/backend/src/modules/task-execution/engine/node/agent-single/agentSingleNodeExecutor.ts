import type { AgentNodeExecutionPorts } from '../../../application/ports/agentNodeExecution'
import type {
  WorkgroupHostExecutionRequest,
  WorkgroupHostExecutionResult,
} from '../../../application/ports/workgroupHostExecution'
import type { NodeStepOutcome, NodeStepRequest } from '../../../domain/nodeExecution'
import type { AgentNodeExecutor } from '../nodeExecutor'
import { runAgentSingleNode } from './runAgentSingleNode'
import { runWorkgroupHost } from './runWorkgroupHost'

/** RFC-405 / RFC-406: both lanes — the DAG agent and the workgroup host — run their own bodies. */
export class AgentSingleNodeExecutor implements AgentNodeExecutor {
  readonly kind = 'agent-single' as const

  constructor(private readonly ports: AgentNodeExecutionPorts) {}

  execute(request: NodeStepRequest<'agent-single'>): Promise<NodeStepOutcome> {
    return runAgentSingleNode(this.ports, request)
  }

  executeHost(request: WorkgroupHostExecutionRequest): Promise<WorkgroupHostExecutionResult> {
    return runWorkgroupHost(this.ports, request)
  }
}
