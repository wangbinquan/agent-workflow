// RFC-333 — collaboration's offered, transaction-bound gate-open contract.

import type { HumanGateIdentity } from '../../domain/gateReceipt'
import type { PreparedHumanGateRef } from '../../domain/humanGateOperation'
import type { CollaborationPostCommitEventRef } from '../../domain/postCommitEventRef'

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
