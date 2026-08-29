// RFC-333 — task-execution owns this required SPI because TaskParkTx is its
// consumer. The provider receives only a live, opaque transaction scope; the
// SQLite handle stays inside the two persistence adapters.

import type { HumanGateIdentity, PreparedHumanGateRef } from '@/modules/collaboration/public/types'
import type { TransactionScope } from '@/platform/persistence/transactionScope'
import type { TaskExecutionPostCommitEventRef } from '../../domain/postCommitEventRef'

export interface HumanGateOpenParticipantResult {
  readonly gate: HumanGateIdentity
  readonly gateRevision: number
  readonly nodeProjectionDigest: string
  readonly committedEventRef: string
  readonly eventRefs: readonly TaskExecutionPostCommitEventRef[]
}

export interface HumanGateOpenParticipant {
  consumePreparedGateTx(input: {
    readonly transactionScope: TransactionScope
    readonly prepared: PreparedHumanGateRef
    readonly taskRevision: number
    readonly now: number
  }): HumanGateOpenParticipantResult
  listPreparedManualQuestionParksTx(input: {
    readonly transactionScope: TransactionScope
    readonly taskId: string
  }): readonly string[]
  consumeManualQuestionParkTx(input: {
    readonly transactionScope: TransactionScope
    readonly operationId: string
    readonly taskId: string
    readonly now: number
  }): Readonly<{
    outstanding: boolean
    nodeProjectionDigest: string
    committedEventRef: string
  }>
}
