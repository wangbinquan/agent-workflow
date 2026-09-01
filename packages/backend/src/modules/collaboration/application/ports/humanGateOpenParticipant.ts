// RFC-333 — collaboration's offered, transaction-bound gate-open contract.

import type { HumanGateIdentity } from '../../domain/gateReceipt'
import type { PreparedHumanGateRef } from '../../domain/humanGateOperation'
import type { CollaborationPostCommitEventRef } from '../../domain/postCommitEventRef'
import type { RerunCause } from '@agent-workflow/shared'

/**
 * Narrow node-run mint capability consumed by collaboration while the task
 * owner already holds the provider transaction. Task Execution supplies the
 * provider-specific implementation; collaboration never receives a DB handle.
 */
export interface HumanGateNodeRunMintInput {
  readonly id: string
  readonly taskId: string
  readonly nodeId: string
  readonly status: 'awaiting_review' | 'awaiting_human'
  readonly cause: RerunCause
  readonly iteration: number
  readonly overrides?: Readonly<{
    reviewIteration?: number
    consumedUpstreamRunsJson?: string | null
    parentNodeRunId?: string | null
    shardKey?: string | null
    startedAt?: number | null
  }>
}

export interface HumanGateNodeRunMintParticipantInTx<Result extends string | Promise<string>> {
  mint(input: HumanGateNodeRunMintInput): Result
}

export interface HumanGateOpenParticipantResult {
  readonly gate: HumanGateIdentity
  readonly gateRevision: number
  readonly nodeProjectionDigest: string
  readonly committedEventRef: string
  readonly eventRefs: readonly CollaborationPostCommitEventRef[]
}

export interface HumanGateOpenParticipantInTx {
  consumePreparedGateTx(input: {
    readonly prepared: PreparedHumanGateRef
    readonly taskRevision: number
    readonly now: number
  }): HumanGateOpenParticipantResult
  listPreparedManualQuestionParksTx(taskId: string): readonly string[]
  consumeManualQuestionParkTx(input: {
    readonly operationId: string
    readonly taskId: string
    readonly now: number
  }): Readonly<{
    outstanding: boolean
    nodeProjectionDigest: string
    committedEventRef: string
  }>
}
