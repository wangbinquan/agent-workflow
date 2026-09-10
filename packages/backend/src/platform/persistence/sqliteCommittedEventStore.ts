// Native synchronous callers keep their existing DbTxSync boundary.
// Append and cutover SQL and decisions live in appendProgram.

import type { DbTxSync } from '@/db/txSync'
import {
  driveSyncProgram,
  executeTransactionStepSync,
} from '@/platform/persistence/transactionProgram'
import {
  appendCommittedEventProgram,
  changeCommittedEventCutoverProgram,
  readCommittedEventCutoverProgram,
} from '@/platform/events/committed/appendProgram'
import type {
  AppendCommittedEventInput,
  AppendCommittedEventReceipt,
  CommittedEventCutover,
  CommittedEventFamily,
  CommittedEventProducer,
} from '@/platform/events/committed/types'

export function readCommittedEventCutoverTx(
  tx: DbTxSync,
  producer: CommittedEventProducer,
  family: CommittedEventFamily,
): CommittedEventCutover {
  return driveSyncProgram(
    readCommittedEventCutoverProgram(tx, producer, family),
    executeTransactionStepSync,
  )
}

export function changeCommittedEventCutoverTx(
  tx: DbTxSync,
  input: Readonly<{
    producer: CommittedEventProducer
    family: CommittedEventFamily
    expectedMode: CommittedEventCutover['mode']
    expectedEpoch: number
    mode: CommittedEventCutover['mode']
    changedAt: number
    changeRef: string
  }>,
): CommittedEventCutover {
  return driveSyncProgram(changeCommittedEventCutoverProgram(tx, input), executeTransactionStepSync)
}

export function appendCommittedEventTx<TType extends string, TPayload>(
  tx: DbTxSync,
  input: AppendCommittedEventInput<TType, TPayload>,
): AppendCommittedEventReceipt {
  return driveSyncProgram(
    // The incoming native transaction already holds the SQLite writer.
    appendCommittedEventProgram(tx, input, () => {}),
    executeTransactionStepSync,
  )
}
