import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { DatabaseHumanGateOperationJournal } from './humanGateOperationJournal'
import { DatabaseHumanGateOpenParticipantInTx } from './humanGateOpenParticipant'

/** One journal per task lifecycle persistence; participants stay inside its transaction. */
export function createHumanGateOpenParticipantScope(input: {
  readonly taskPersistenceInTransaction: ConstructorParameters<
    typeof DatabaseHumanGateOperationJournal
  >[0]
  readonly historyRestrictions: ConstructorParameters<typeof DatabaseHumanGateOperationJournal>[1]
}) {
  const journal = new DatabaseHumanGateOperationJournal(
    input.taskPersistenceInTransaction,
    input.historyRestrictions,
  )
  return {
    inTransaction: (
      tx: PersistenceTx,
      participants: {
        readonly mint: ConstructorParameters<typeof DatabaseHumanGateOpenParticipantInTx>[2]
        readonly lifecycle: ConstructorParameters<typeof DatabaseHumanGateOpenParticipantInTx>[3]
        readonly consumedInputs: ConstructorParameters<
          typeof DatabaseHumanGateOpenParticipantInTx
        >[4]
      },
    ) =>
      new DatabaseHumanGateOpenParticipantInTx(
        tx,
        journal,
        participants.mint,
        participants.lifecycle,
        participants.consumedInputs,
        input.historyRestrictions,
      ),
  }
}
