import { nodeKindSettlesWithoutRow, type NodeKind } from '@agent-workflow/shared'
import type {
  WorkgroupHostExecutionRequest,
  WorkgroupHostExecutionResult,
} from '../../application/ports/workgroupHostExecution'
import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'
import { isAgentNodeExecutor } from './nodeExecutor'
import type { ClosedNodeExecutorRegistry } from './nodeExecutorRegistry'

export type NodeBranchActivationDecision =
  | Readonly<{ kind: 'active' }>
  | Readonly<{ kind: 'inactive'; outcome: NodeStepOutcome }>

/** Owns current branch judgment and branch-skip persistence, not branch policy. */
export interface NodeBranchActivationPort {
  judge<K extends NodeKind>(request: NodeStepRequest<K>): Promise<NodeBranchActivationDecision>
}

export class NodeExecutionGateway {
  constructor(
    private readonly registry: ClosedNodeExecutorRegistry,
    private readonly branchActivation: NodeBranchActivationPort,
  ) {}

  async executeNode<K extends NodeKind>(request: NodeStepRequest<K>): Promise<NodeStepOutcome> {
    if (request.execution.signal?.aborted === true) {
      return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
    }

    if (!nodeKindSettlesWithoutRow(request.node.kind)) {
      const decision = await this.branchActivation.judge(request)
      if (decision.kind === 'inactive') return decision.outcome
    }

    return this.registry.resolve(request.node.kind).execute(request)
  }

  async executeHost(request: WorkgroupHostExecutionRequest): Promise<WorkgroupHostExecutionResult> {
    const executor = this.registry.resolve('agent-single')
    if (!isAgentNodeExecutor(executor)) {
      throw new Error('node-executor-host-lane-unavailable:agent-single')
    }
    return executor.executeHost(request)
  }
}
