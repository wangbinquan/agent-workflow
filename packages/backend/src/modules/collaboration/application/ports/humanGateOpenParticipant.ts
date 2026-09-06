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
  /** RFC-354 — the frame the park row lives in (the asking / reviewed run's frame). */
  readonly containerRunId?: string | null
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

/**
 * RFC-359 W4-D25 —— 同样窄的 node-run 停靠能力：把一条既有 run 从其唯一合法源状态 CAS 到
 * 停靠态。Task Execution 供给实现，collaboration 仍然拿不到任何 DB 句柄。
 */
export interface HumanGateNodeRunLifecycleParticipantInTx {
  set(input: {
    readonly nodeRunId: string
    readonly to: 'awaiting_review' | 'awaiting_human'
    readonly allowedFrom: readonly ('pending' | 'running')[]
    readonly extra?: Readonly<{
      startedAt?: number | null
      consumedUpstreamRunsJson?: string | null
    }>
    readonly reason?: string
  }): Promise<{ readonly from: string; readonly to: string }>
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
  }): Promise<HumanGateOpenParticipantResult>
  listPreparedManualQuestionParksTx(taskId: string): Promise<readonly string[]>
  consumeManualQuestionParkTx(input: {
    readonly operationId: string
    readonly taskId: string
    readonly now: number
  }): Promise<
    Readonly<{
      outstanding: boolean
      nodeProjectionDigest: string
      committedEventRef: string
    }>
  >
}
