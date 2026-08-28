import type {
  WrapperNodeExecutionPort,
  WrapperNodeKind,
} from '../../application/ports/wrapperNodeExecution'
import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'
import type { NodeExecutor } from './nodeExecutor'

class WrapperDelegatingNodeExecutor<K extends WrapperNodeKind> implements NodeExecutor<K> {
  constructor(
    readonly kind: K,
    private readonly port: WrapperNodeExecutionPort,
  ) {}

  execute(request: NodeStepRequest<K>): Promise<NodeStepOutcome> {
    return this.port.execute(this.kind, request)
  }
}

export function createWrapperDelegatingNodeExecutors(port: WrapperNodeExecutionPort): {
  readonly 'wrapper-git': NodeExecutor<'wrapper-git'>
  readonly 'wrapper-loop': NodeExecutor<'wrapper-loop'>
  readonly 'wrapper-fanout': NodeExecutor<'wrapper-fanout'>
} {
  return {
    'wrapper-git': new WrapperDelegatingNodeExecutor('wrapper-git', port),
    'wrapper-loop': new WrapperDelegatingNodeExecutor('wrapper-loop', port),
    'wrapper-fanout': new WrapperDelegatingNodeExecutor('wrapper-fanout', port),
  }
}
