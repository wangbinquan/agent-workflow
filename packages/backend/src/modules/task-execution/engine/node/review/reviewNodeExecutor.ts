import type { ReviewNodeExecutionPorts } from '../../../application/ports/humanGateNodeExecution'
import type { NodeStepRequest, NodeStepOutcome } from '../../../domain/nodeExecution'
import type { NodeExecutor } from '../nodeExecutor'

export class ReviewNodeExecutor implements NodeExecutor<'review'> {
  readonly kind = 'review' as const
  constructor(private readonly ports: ReviewNodeExecutionPorts) {}
  execute(request: NodeStepRequest<'review'>): Promise<NodeStepOutcome> {
    const { ports } = this
    return ports.dispatchReviewNode({
      taskId: ports.taskId,
      appHome: ports.appHome,
      definition: ports.definition,
      node: request.node,
      containerRunId: request.containerRunId,
      iteration: request.iteration,
      // RFC-193 D9: the review's fallback read root is THIS scope's canonical.
      scopeRoot: ports.scopeRoot,
      repoDirName: ports.portFallbackMount(ports.repoMounts),
    })
  }
}
