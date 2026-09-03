import type { ClarifyQuestion, ClarifyTruncationWarning } from '@agent-workflow/shared'
import type { NodeStepOutcome, NodeStepRequest } from '../../domain/nodeExecution'

interface AgentClarifyGateRequestBase {
  readonly taskId: string
  readonly askingNodeId: string
  readonly askingNodeRunId: string
  /**
   * RFC-354 — the asking run's FRAME: the wrapper generation row it hangs off
   * (`containerRunId`, null at the top scope) and its round inside that frame
   * (`iteration`). The park row is minted in the same frame, so the
   * frame-scoped frontier finds it after the answer instead of visiting an
   * "empty" gate and settling it idle. Optional only for legacy fixtures
   * (⇒ top scope, round 0); production always passes it.
   */
  readonly frame?: { readonly containerRunId: string | null; readonly iteration: number }
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
  /**
   * RFC-354 D7 — a self-clarify gate visited by the graph: no open round means
   * nobody asked, so the node settles as a `skipped` row in its frame.
   */
  settleIdleClarify(request: NodeStepRequest<'clarify'>): Promise<NodeStepOutcome>
  inspectCrossClarify(request: NodeStepRequest<'clarify-cross-agent'>): Promise<NodeStepOutcome>
  openAgentClarify(request: AgentClarifyGateRequest): Promise<AgentClarifyGateReceipt>
}
