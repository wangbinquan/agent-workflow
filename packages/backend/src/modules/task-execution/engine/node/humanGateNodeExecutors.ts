import type { CollaborationNodeGatePort } from '../../application/ports/collaborationNodeGate'
import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'
import type { NodeExecutor } from './nodeExecutor'

export class ReviewNodeExecutor implements NodeExecutor<'review'> {
  readonly kind = 'review' as const

  constructor(private readonly gates: CollaborationNodeGatePort) {}

  execute(request: NodeStepRequest<'review'>): Promise<NodeStepOutcome> {
    return this.gates.requestReview(request)
  }
}

/** Graph visits are no-ops; runner-emitted questions use collaboration directly. */
export class ClarifyNodeExecutor implements NodeExecutor<'clarify'> {
  readonly kind = 'clarify' as const

  async execute(_request: NodeStepRequest<'clarify'>): Promise<NodeStepOutcome> {
    return { kind: 'ok', summary: '', message: '' }
  }
}

export class CrossClarifyNodeExecutor implements NodeExecutor<'clarify-cross-agent'> {
  readonly kind = 'clarify-cross-agent' as const

  constructor(private readonly gates: CollaborationNodeGatePort) {}

  execute(request: NodeStepRequest<'clarify-cross-agent'>): Promise<NodeStepOutcome> {
    return this.gates.inspectCrossClarify(request)
  }
}
