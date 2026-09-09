import type { DbTxSync } from '@/db/txSync'
import {
  driveSyncProgram,
  executeTransactionStepSync,
} from '@/platform/persistence/transactionProgram'
import type { NodeRunMintInput } from '../application/ports/nodeRunLifecyclePersistence'
import { nodeRunMintProgram } from './nodeRunMintParticipant'

/** Provider-private participant for an already-reserved SQLite transaction. */
export interface SqliteNodeRunMintParticipantInTx {
  mint(input: NodeRunMintInput): string
}

export function createSqliteNodeRunMintParticipantInTx(
  tx: DbTxSync,
): SqliteNodeRunMintParticipantInTx {
  return Object.freeze({
    mint(input: NodeRunMintInput) {
      return driveSyncProgram(
        nodeRunMintProgram(tx, input, (query) => query.all()),
        executeTransactionStepSync,
      )
    },
  })
}
