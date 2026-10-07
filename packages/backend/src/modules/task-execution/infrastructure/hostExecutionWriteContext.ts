import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type {
  HostExecutionWriteContext,
  HostExecutionWriteContextParticipant,
  HostExecutionWriteReceipt,
} from '@/modules/system-operations/public/participants'
import type {
  TaskHostWriteContext,
  TaskHostWriteReceipt,
  TaskHostWriteTransaction,
} from '../application/ports/taskHostWriteContext'

/** Task's independent adapter retains the SO binding and original transaction identities. */
export function createTaskHostWriteContextAdapter(input: {
  readonly context: HostExecutionWriteContext
  readonly participant: HostExecutionWriteContextParticipant
}): Readonly<{
  port: TaskHostWriteContext
  transactionFor(tx: DatabaseTransaction): TaskHostWriteTransaction
}> {
  if (input.context === undefined || input.participant === undefined) {
    throw new Error('task-host-write-context-incomplete')
  }
  const receipts = new WeakMap<TaskHostWriteReceipt, HostExecutionWriteReceipt>()
  const captured = new WeakMap<HostExecutionWriteReceipt, TaskHostWriteReceipt>()
  const transactions = new WeakMap<TaskHostWriteTransaction, DatabaseTransaction>()
  const wrapped = new WeakMap<DatabaseTransaction, TaskHostWriteTransaction>()
  const context = input.context
  const participant = input.participant
  const forGrant = context.forGrant
  const newWork = participant.consumeNewWork
  const recovery = participant.consumeRecovery
  const issuedAck = participant.consumeIssuedAck
  if (
    [forGrant, newWork, recovery, issuedAck].some((operation) => typeof operation !== 'function')
  ) {
    throw new Error('task-host-write-context-incomplete')
  }
  const consume = async (
    tx: TaskHostWriteTransaction,
    receipt: TaskHostWriteReceipt,
    operation: HostExecutionWriteContextParticipant['consumeNewWork'],
  ): Promise<void> => {
    const originalTx = transactions.get(tx)
    const originalReceipt = receipts.get(receipt)
    if (originalTx === undefined || originalReceipt === undefined) {
      throw new Error('task-host-write-context-unavailable')
    }
    await operation.call(participant, originalTx, originalReceipt)
  }
  const port = Object.freeze<TaskHostWriteContext>({
    capture(grant) {
      const original = forGrant.call(context, grant)
      if (original === undefined) throw new Error('task-host-write-context-unavailable')
      let receipt = captured.get(original)
      if (receipt === undefined) {
        receipt = Object.freeze({}) as TaskHostWriteReceipt
        receipts.set(receipt, original)
        captured.set(original, receipt)
      }
      return receipt
    },
    consumeNewWork: (tx, receipt) => consume(tx, receipt, newWork),
    consumeRecovery: (tx, receipt) => consume(tx, receipt, recovery),
    consumeIssuedAck: (tx, receipt) => consume(tx, receipt, issuedAck),
  })
  return Object.freeze({
    port,
    transactionFor(tx) {
      let reference = wrapped.get(tx)
      if (reference === undefined) {
        reference = Object.freeze({}) as TaskHostWriteTransaction
        wrapped.set(tx, reference)
        transactions.set(reference, tx)
      }
      return reference
    },
  })
}
