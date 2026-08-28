import type { WrapperNodeKind, WrapperRowSettlementStatus } from '../../domain/wrapperExecution'

export interface WrapperStatusReceipt {
  readonly taskId: string
  readonly nodeRunId: string
  readonly nodeId: string
  readonly kind: WrapperNodeKind
  readonly status: 'running' | WrapperRowSettlementStatus
}

/** Publishes only after the matching ledger transition has committed. */
export interface WrapperStatusPublisherPort {
  publish(receipt: WrapperStatusReceipt): void
}
