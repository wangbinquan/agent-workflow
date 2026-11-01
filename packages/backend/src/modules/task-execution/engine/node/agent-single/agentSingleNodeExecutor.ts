import type { AgentNodeExecutionPorts } from '../../../application/ports/agentNodeExecution'
import type {
  WorkgroupHostExecutionPort,
  WorkgroupHostExecutionRequest,
  WorkgroupHostExecutionResult,
} from '../../../application/ports/workgroupHostExecution'
import type { NodeStepOutcome, NodeStepRequest } from '../../../domain/nodeExecution'
import type { AgentNodeExecutor } from '../nodeExecutor'
import { runAgentSingleNode } from './runAgentSingleNode'

/** RFC-405: the DAG agent runs its own body; the workgroup host lane is still handed over (RFC-406). */
export class AgentSingleNodeExecutor implements AgentNodeExecutor {
  readonly kind = 'agent-single' as const

  constructor(
    private readonly ports: AgentNodeExecutionPorts,
    private readonly host: WorkgroupHostExecutionPort,
  ) {}

  execute(request: NodeStepRequest<'agent-single'>): Promise<NodeStepOutcome> {
    return runAgentSingleNode(this.ports, request)
  }

  executeHost(request: WorkgroupHostExecutionRequest): Promise<WorkgroupHostExecutionResult> {
    return this.host.executeHost(request)
  }
}
