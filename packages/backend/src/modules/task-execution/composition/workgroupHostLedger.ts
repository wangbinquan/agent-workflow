import type { WorkgroupHostLedgerParticipantInTx } from '../public/commands'
import { createPostgresqlWorkgroupHostLedgerParticipantInTx } from '../infrastructure/postgresqlWorkgroupHostLedgerParticipant'
import type { PostgresqlTaskExecutionTransaction } from '../infrastructure/postgresqlTaskLifecycleTransaction'
import type { PostgresqlWorkgroupTaskRoomClarifyParticipantFactory } from './workgroupTaskRoomTask'

export interface PostgresqlWorkgroupHostLedgerParticipantFactory {
  inTransaction(transaction: PostgresqlTaskExecutionTransaction): WorkgroupHostLedgerParticipantInTx
}

/**
 * PostgreSQL cross-context composition seam.  The Resource Catalog owner
 * reserves the transaction and receives only TaskExecution's closed host
 * ledger participant for that exact transaction.
 */
export function composePostgresqlWorkgroupHostLedgerParticipantFactory(input: {
  readonly collaboration: PostgresqlWorkgroupTaskRoomClarifyParticipantFactory
}): PostgresqlWorkgroupHostLedgerParticipantFactory {
  return Object.freeze({
    inTransaction: (transaction: PostgresqlTaskExecutionTransaction) =>
      createPostgresqlWorkgroupHostLedgerParticipantInTx(
        transaction,
        input.collaboration.inTransaction(transaction),
      ),
  })
}
