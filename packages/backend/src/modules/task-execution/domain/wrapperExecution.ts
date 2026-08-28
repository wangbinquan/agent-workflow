import type { WRAPPER_NODE_KINDS } from '@agent-workflow/shared'
import type { NodeStepOutcome, NodeStepRequest } from './nodeExecution'
import type { WrapperScopeDescriptor } from './executionScope'

export type WrapperNodeKind = (typeof WRAPPER_NODE_KINDS)[number]

export type WrapperExecutionRequest<K extends WrapperNodeKind = WrapperNodeKind> = Omit<
  NodeStepRequest<K>,
  'scope'
> & {
  readonly scope: WrapperScopeDescriptor<K>
}

export interface WrapperRunSnapshot {
  readonly id: string
  readonly status: string
  readonly wrapperProgressJson: string | null
  readonly consumedUpstreamRunsJson: string | null
  readonly mergeState: string | null
  readonly isoBaseSnapshot: string | null
  readonly isoBaseSnapshotReposJson: string | null
  readonly isoSubmodulesJson: string | null
  readonly isoSubmodulesReposJson: string | null
}

export interface OpenWrapperGeneration<K extends WrapperNodeKind = WrapperNodeKind> {
  readonly kind: K
  readonly runId: string
  readonly resumed: boolean
  readonly enteredRunning: boolean
  readonly previous: WrapperRunSnapshot | null
}

export type WrapperRowSettlementStatus =
  | 'done'
  | 'failed'
  | 'canceled'
  | 'exhausted'
  | 'awaiting_human'
  | 'awaiting_review'

export interface WrapperSettlement {
  readonly rowStatus: WrapperRowSettlementStatus
  readonly outcome: NodeStepOutcome
  readonly errorMessage?: string
}

export type WrapperPreparation<K extends WrapperNodeKind = WrapperNodeKind> =
  | { readonly kind: 'rejected'; readonly outcome: NodeStepOutcome }
  | {
      readonly kind: 'ready'
      execute(generation: OpenWrapperGeneration<K>): Promise<WrapperSettlement>
    }

export interface WrapperStrategy<K extends WrapperNodeKind = WrapperNodeKind> {
  readonly kind: K
  prepare(request: WrapperExecutionRequest<K>): Promise<WrapperPreparation<K>>
}

export type WrapperStrategyMap = {
  readonly [K in WrapperNodeKind]: WrapperStrategy<K>
}

/**
 * A legal external terminal winner is carried to the one runtime boundary.
 * Illegal transitions and infrastructure failures continue to throw normally.
 */
export class WrapperSupersededSignal extends Error {
  constructor(readonly outcome: NodeStepOutcome) {
    super(outcome.message)
    this.name = 'WrapperSupersededSignal'
  }
}
