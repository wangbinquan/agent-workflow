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

/**
 * RFC-354 D7 — a graph visit finds no open round (runner-emitted questions
 * open their own round through collaboration and park the node), so the gate
 * settles as a `skipped` row: every node's lifecycle is row-backed.
 */
export class ClarifyNodeExecutor implements NodeExecutor<'clarify'> {
  readonly kind = 'clarify' as const

  constructor(private readonly gates: CollaborationNodeGatePort) {}

  execute(request: NodeStepRequest<'clarify'>): Promise<NodeStepOutcome> {
    return this.gates.settleIdleClarify(request)
  }
}

export class CrossClarifyNodeExecutor implements NodeExecutor<'clarify-cross-agent'> {
  readonly kind = 'clarify-cross-agent' as const

  constructor(private readonly gates: CollaborationNodeGatePort) {}

  execute(request: NodeStepRequest<'clarify-cross-agent'>): Promise<NodeStepOutcome> {
    return this.gates.inspectCrossClarify(request)
  }
}
