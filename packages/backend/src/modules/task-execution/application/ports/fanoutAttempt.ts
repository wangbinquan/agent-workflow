import type { Agent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import type { FailureCode } from '@agent-workflow/shared'
import type { ShardScope } from '../../domain/fanoutScope'

export interface FanoutShardSpec {
  readonly shardKey: string
  readonly value: string
}

export interface FanoutShardAttemptResult {
  readonly kind: 'ok' | 'failed' | 'canceled'
  readonly shardKey: string
  readonly outputs: Record<string, string>
  readonly message: string
  readonly retry?: {
    readonly retryIndex: number
    readonly failureCode: FailureCode | null
    readonly processUnreaped?: true
  }
}

export interface FanoutAggregatorAttemptResult {
  readonly kind: 'ok' | 'failed' | 'canceled' | 'awaiting_human' | 'awaiting_review'
  readonly summary: string
  readonly message: string
  readonly outputs: Record<string, string>
  readonly aggRunId?: string
}

export interface FanoutAttemptPort {
  dispatchShard(input: {
    readonly wrapperId: string
    readonly wrapperRunId: string
    readonly innerNode: WorkflowNode
    readonly innerAgent: Agent
    readonly iteration: number
    readonly shard: FanoutShardSpec | null
    readonly shardSourcePortName: string
    readonly boundaryEdges: readonly WorkflowEdge[]
    readonly broadcastInputs: Readonly<Record<string, string>>
    readonly reuseDisabled: boolean
  }): Promise<FanoutShardAttemptResult>

  dispatchAggregator(input: {
    readonly wrapperId: string
    readonly wrapperRunId: string
    readonly node: WorkflowNode
    readonly agent: Agent
    readonly iteration: number
    readonly shards: readonly FanoutShardSpec[]
    readonly definition: WorkflowDefinition
    readonly scope: ShardScope
    readonly reuseDisabled: boolean
  }): Promise<FanoutAggregatorAttemptResult>
}
