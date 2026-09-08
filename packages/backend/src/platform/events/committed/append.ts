// The asynchronous transaction boundary for the shared committed-event append program.

import { engineOf, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { driveAsyncProgram } from '@/platform/persistence/transactionProgram'
import { appendCommittedEventProgram, readCommittedEventCutoverProgram } from './appendProgram'
import type {
  AppendCommittedEventInput,
  AppendCommittedEventReceipt,
  CommittedEventCutover,
  CommittedEventFamily,
  CommittedEventProducer,
} from './types'

export async function readCommittedEventCutover(
  tx: DatabaseTransaction,
  producer: CommittedEventProducer,
  family: CommittedEventFamily,
): Promise<CommittedEventCutover> {
  return await driveAsyncProgram(readCommittedEventCutoverProgram(tx, producer, family), (step) =>
    step(),
  )
}

export async function appendCommittedEvent<TType extends string, TPayload>(
  tx: DatabaseTransaction,
  input: AppendCommittedEventInput<TType, TPayload>,
): Promise<AppendCommittedEventReceipt> {
  return await driveAsyncProgram(
    appendCommittedEventProgram(tx, input, (key) => engineOf(tx).advisoryLock(tx, key)),
    (step) => step(),
  )
}
