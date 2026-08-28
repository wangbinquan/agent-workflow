import type { ClarifyQuestion, ClarifyTruncationWarning } from '@agent-workflow/shared'
import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'

interface AgentClarifyGateRequestBase {
  readonly taskId: string
  readonly askingNodeId: string
  readonly askingNodeRunId: string
  readonly intermediaryNodeId: string
  readonly questions: readonly ClarifyQuestion[]
  readonly truncationWarnings?: readonly ClarifyTruncationWarning[]
}

export type AgentClarifyGateRequest =
  | Readonly<
      AgentClarifyGateRequestBase & {
        kind: 'self'
        askingShardKey: string | null
        iteration: number
        parentNodeRunId?: string | null
      }
    >
  | Readonly<
      AgentClarifyGateRequestBase & {
        kind: 'cross'
        targetConsumerNodeId: string | null
        loopIter: number
      }
    >

export interface AgentClarifyGateReceipt {
  readonly intermediaryNodeRunId: string
}

export interface CollaborationNodeGatePort {
  requestReview(request: NodeStepRequest<'review'>): Promise<NodeStepOutcome>
  inspectCrossClarify(request: NodeStepRequest<'clarify-cross-agent'>): Promise<NodeStepOutcome>
  openAgentClarify(request: AgentClarifyGateRequest): Promise<AgentClarifyGateReceipt>
}
