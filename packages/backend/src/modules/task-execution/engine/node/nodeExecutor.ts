import type { NodeKind } from '@agent-workflow/shared'
import type { WorkgroupHostExecutionPort } from '../../application/ports/workgroupHostExecution'
import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'

export interface NodeExecutor<K extends NodeKind = NodeKind> {
  readonly kind: K
  execute(request: NodeStepRequest<K>): Promise<NodeStepOutcome>
}

export interface AgentNodeExecutor
  extends NodeExecutor<'agent-single'>, WorkgroupHostExecutionPort {}

export type NodeExecutorMap = {
  readonly [K in NodeKind]: NodeExecutor<K>
}

export function isAgentNodeExecutor(executor: NodeExecutor): executor is AgentNodeExecutor {
  return executor.kind === 'agent-single' && 'executeHost' in executor
}
