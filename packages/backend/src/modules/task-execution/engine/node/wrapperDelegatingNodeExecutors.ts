import type {
  WrapperNodeExecutionPort,
  WrapperNodeKind,
} from '../../application/ports/wrapperNodeExecution'
import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'
import type { WrapperScopeDescriptor } from '../../domain/executionScope'
import type { NodeExecutor } from './nodeExecutor'

interface WrapperScopeReadModel {
  find(wrapperId: string, kind: WrapperNodeKind): WrapperScopeDescriptor
}

class WrapperDelegatingNodeExecutor<K extends WrapperNodeKind> implements NodeExecutor<K> {
  constructor(
    readonly kind: K,
    private readonly port: WrapperNodeExecutionPort,
    private readonly scopes: WrapperScopeReadModel,
  ) {}

  execute(request: NodeStepRequest<K>): Promise<NodeStepOutcome> {
    const scope = this.scopes.find(request.node.id, this.kind)
    if (scope.kind !== this.kind) {
      throw new Error(
        `execution-scope-wrapper-kind-mismatch:${request.node.id}:${this.kind}:${scope.kind}`,
      )
    }
    return this.port.execute(this.kind, {
      ...request,
      scope: Object.freeze({
        wrapperId: scope.wrapperId,
        kind: this.kind,
        parentScopeId: scope.parentScopeId,
        directNodeIds: scope.directNodeIds,
        path: scope.path,
      }),
    })
  }
}

export function createWrapperDelegatingNodeExecutors(
  port: WrapperNodeExecutionPort,
  scopes: WrapperScopeReadModel,
): {
  readonly 'wrapper-git': NodeExecutor<'wrapper-git'>
  readonly 'wrapper-loop': NodeExecutor<'wrapper-loop'>
  readonly 'wrapper-fanout': NodeExecutor<'wrapper-fanout'>
} {
  return {
    'wrapper-git': new WrapperDelegatingNodeExecutor('wrapper-git', port, scopes),
    'wrapper-loop': new WrapperDelegatingNodeExecutor('wrapper-loop', port, scopes),
    'wrapper-fanout': new WrapperDelegatingNodeExecutor('wrapper-fanout', port, scopes),
  }
}
