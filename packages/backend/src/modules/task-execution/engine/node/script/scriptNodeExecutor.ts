import type { NodeStepOutcome, NodeStepRequest } from '../../../domain/nodeExecution'
import type { NodeExecutor } from '../nodeExecutor'
import type { ScriptNodeExecutionPorts } from '../../../application/ports/scriptNodeExecution'
import { runScriptNode } from './runScriptNode'

export class ScriptNodeExecutor implements NodeExecutor<'script'> {
  readonly kind = 'script' as const
  constructor(private readonly ports: ScriptNodeExecutionPorts) {}
  execute(request: NodeStepRequest<'script'>): Promise<NodeStepOutcome> {
    return runScriptNode(this.ports, request)
  }
}
