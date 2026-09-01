// RFC-333 — provider adapter for task-execution's consumer-owned HumanGate
// required port. Both sides resolve the same short-lived TransactionScope;
// neither bounded-context contract exposes the raw SQLite transaction.

import type { HumanGateOpenParticipant } from '@/modules/task-execution/composition/required-ports'
import { createSqliteNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/sqliteNodeRunMintParticipant'
import { withSQLiteTransaction } from '@/platform/persistence/sqlite/existingTransactionScope'
import { SqliteHumanGateOpenParticipantInTx } from '../../infrastructure/sqliteHumanGateOpenParticipant'
import { SqliteHumanGateOperationStore } from '../../infrastructure/sqliteHumanGateOperationStore'

export function composeTaskExecutionHumanGateAdapter(): HumanGateOpenParticipant {
  const operations = new SqliteHumanGateOperationStore()
  return {
    consumePreparedGateTx(input) {
      let result: ReturnType<HumanGateOpenParticipant['consumePreparedGateTx']> | undefined
      withSQLiteTransaction(input.transactionScope, (tx): undefined => {
        result = new SqliteHumanGateOpenParticipantInTx(
          tx,
          operations,
          createSqliteNodeRunMintParticipantInTx(tx),
        ).consumePreparedGateTx({
          prepared: input.prepared,
          taskRevision: input.taskRevision,
          now: input.now,
        })
        return undefined
      })
      if (result === undefined) throw new Error('human-gate participant returned no result')
      return result
    },

    listPreparedManualQuestionParksTx(input) {
      let operationIds: readonly string[] | undefined
      withSQLiteTransaction(input.transactionScope, (tx): undefined => {
        operationIds = new SqliteHumanGateOpenParticipantInTx(
          tx,
          operations,
          createSqliteNodeRunMintParticipantInTx(tx),
        ).listPreparedManualQuestionParksTx(input.taskId)
        return undefined
      })
      if (operationIds === undefined) throw new Error('human-gate participant returned no parks')
      return operationIds
    },

    consumeManualQuestionParkTx(input) {
      let result: ReturnType<HumanGateOpenParticipant['consumeManualQuestionParkTx']> | undefined
      withSQLiteTransaction(input.transactionScope, (tx): undefined => {
        result = new SqliteHumanGateOpenParticipantInTx(
          tx,
          operations,
          createSqliteNodeRunMintParticipantInTx(tx),
        ).consumeManualQuestionParkTx({
          operationId: input.operationId,
          taskId: input.taskId,
          now: input.now,
        })
        return undefined
      })
      if (result === undefined) throw new Error('human-gate participant returned no result')
      return result
    },
  }
}
