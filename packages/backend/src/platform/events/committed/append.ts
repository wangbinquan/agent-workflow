// The asynchronous transaction boundary for the shared committed-event append program.

import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
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
  tx: PersistenceTx,
  producer: CommittedEventProducer,
  family: CommittedEventFamily,
): Promise<CommittedEventCutover> {
  return await driveAsyncProgram(readCommittedEventCutoverProgram(tx, producer, family), (step) =>
    step(),
  )
}

export async function appendCommittedEvent<TType extends string, TPayload>(
  tx: PersistenceTx,
  input: AppendCommittedEventInput<TType, TPayload>,
): Promise<AppendCommittedEventReceipt> {
  return await driveAsyncProgram(
    appendCommittedEventProgram(tx, input, (key) => engineOf(tx).advisoryLock(tx, key)),
    (step) => step(),
  )
}
