import type { WorkgroupHostExecutionPort } from '../../application/ports/workgroupHostExecution'
import type {
  WorkgroupHostExecutionRequest,
  WorkgroupHostExecutionResult,
} from '../../application/ports/workgroupHostExecution'
import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'
import type { AgentNodeExecutor } from './nodeExecutor'

export interface DagAgentNodeExecutionPort {
  executeAgent(request: NodeStepRequest<'agent-single'>): Promise<NodeStepOutcome>
}

export class AgentSingleNodeExecutor implements AgentNodeExecutor {
  readonly kind = 'agent-single' as const

  constructor(
    private readonly dag: DagAgentNodeExecutionPort,
    private readonly host: WorkgroupHostExecutionPort,
  ) {}

  execute(request: NodeStepRequest<'agent-single'>): Promise<NodeStepOutcome> {
    return this.dag.executeAgent(request)
  }

  executeHost(request: WorkgroupHostExecutionRequest): Promise<WorkgroupHostExecutionResult> {
    return this.host.executeHost(request)
  }
}
