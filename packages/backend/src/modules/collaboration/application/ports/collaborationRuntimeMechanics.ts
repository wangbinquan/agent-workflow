import type {
  ClarifyDirective,
  ClarifyQuestion,
  ClarifyTruncationWarning,
  ReviewPromptContext,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

import type { TaskExecutionContextRef } from '@/modules/task-execution/public/commands'
import type { PreparedHumanGateRef } from '../../domain/humanGateOperation'

export interface CollaborationReviewDispatchInput {
  readonly taskId: string
  readonly appHome: string
  readonly definition: WorkflowDefinition
  readonly node: WorkflowNode
  /**
   * RFC-354 — the frame the review node is dispatched in; its park row lives
   * there. Optional only for legacy fixtures; production always passes it.
   */
  readonly containerRunId?: string | null
  readonly iteration: number
  readonly scopeRoot: string
  readonly repoDirName?: string
  readonly executionContext?: TaskExecutionContextRef
}

export interface CollaborationReviewDispatchResult {
  readonly kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review'
  readonly summary: string
  readonly message: string
}

export interface CollaborationCrossClarifyInspectInput {
  readonly taskId: string
  readonly crossClarifyNodeId: string
  readonly nodeRunId: string
  readonly definition: WorkflowDefinition
  readonly executionContext?: TaskExecutionContextRef
}

export interface CollaborationCrossClarifyInspectResult {
  readonly kind: 'short-circuit-stop' | 'awaiting' | 'no-questioner'
}

interface CollaborationAgentClarifyOpenBase {
  readonly taskId: string
  readonly askingNodeId: string
  readonly askingNodeRunId: string
  /**
   * RFC-354 — the asking run's frame; the park row is minted in the same
   * frame. Optional only for legacy fixtures; production always passes it.
   */
  readonly containerRunId?: string | null
  readonly intermediaryNodeId: string
  readonly questions: readonly ClarifyQuestion[]
  readonly truncationWarnings?: readonly ClarifyTruncationWarning[]
  readonly executionContext?: TaskExecutionContextRef
}

export type CollaborationAgentClarifyOpenInput =
  | Readonly<
      CollaborationAgentClarifyOpenBase & {
        kind: 'self'
        askingShardKey: string | null
        iteration: number
        parentNodeRunId?: string | null
      }
    >
  | Readonly<
      CollaborationAgentClarifyOpenBase & {
        kind: 'cross'
        targetConsumerNodeId: string | null
        loopIter: number
      }
    >

export interface CollaborationAgentClarifyOpenReceipt {
  readonly intermediaryNodeRunId: string
}

export interface CollaborationBorrowResolutionInput {
  readonly taskId: string
  readonly nodeId: string
  readonly iteration: number
  readonly definition: WorkflowDefinition
}

export interface CollaborationReviewPromptInput {
  readonly appHome: string
  readonly upstreamNodeId: string
  readonly taskId: string
  readonly iteration: number
}

export interface CollaborationClarifyDirectiveInput {
  readonly taskId: string
  readonly nodeId: string
  readonly shardKey?: string | null
}

export interface CollaborationClarifyQueueInput {
  readonly definition: WorkflowDefinition
  readonly taskId: string
  readonly consumerNodeId: string
  readonly dispatchedRunId: string
  readonly shardKey?: string | null
  readonly iteration: number
  readonly envelopeNonce?: string
  readonly currentRunOnly?: boolean
}

export interface CollaborationClarifyQueueContext {
  readonly block: string
  readonly sourceRunIds: readonly string[]
}

export interface CollaborationClarifySuppressionInput {
  readonly taskId: string
  readonly nodeId?: string
  readonly shardKey?: string | null
}

export interface CollaborationAutonomousDismissalInput {
  readonly taskId: string
  readonly mode?: string
}

export interface CollaborationAutonomousDismissalResult {
  readonly dismissedSessions: number
  readonly canceledParkRuns: readonly Readonly<{ nodeRunId: string; nodeId: string }>[]
  readonly requeuedAssignments: readonly Readonly<{ id: string; to: string }>[]
}

/**
 * Task-owned human-gate transaction coordinator needed by the PostgreSQL
 * collaboration runtime. Review/clarify mechanics never receive a database
 * client through this public contract.
 */
export interface CollaborationTaskRuntimeOperations {
  readonly humanGates: {
    parkPrepared(input: {
      readonly prepared: PreparedHumanGateRef
      readonly token?: TaskExecutionContextRef['token']
      readonly now: number
    }): Promise<unknown>
  }
}

/**
 * Collaboration's provider-selected mechanics used by Task Execution while a
 * DAG node is running. The contract contains business identities and immutable
 * workflow values only; provider clients and transactions remain captured by
 * the SQLite/PostgreSQL infrastructure factory.
 */
export interface CollaborationRuntimeMechanics {
  dispatchReviewNode(
    input: CollaborationReviewDispatchInput,
  ): Promise<CollaborationReviewDispatchResult>
  inspectCrossClarify(
    input: CollaborationCrossClarifyInspectInput,
  ): Promise<CollaborationCrossClarifyInspectResult>
  openAgentClarify(
    input: CollaborationAgentClarifyOpenInput,
  ): Promise<CollaborationAgentClarifyOpenReceipt>
  resolveBorrowForNode(input: CollaborationBorrowResolutionInput): Promise<string | null>
  buildReviewPromptContext(
    input: CollaborationReviewPromptInput,
  ): Promise<ReviewPromptContext | undefined>
  getNodeClarifyDirective(
    input: CollaborationClarifyDirectiveInput,
  ): Promise<ClarifyDirective | undefined>
  buildClarifyQueueContext(
    input: CollaborationClarifyQueueInput,
  ): Promise<CollaborationClarifyQueueContext | undefined>
  isTaskClarifySuppressed(input: CollaborationClarifySuppressionInput): Promise<boolean>
  dismissOpenClarifyParksForAutonomous(
    input: CollaborationAutonomousDismissalInput,
  ): Promise<CollaborationAutonomousDismissalResult>
}
