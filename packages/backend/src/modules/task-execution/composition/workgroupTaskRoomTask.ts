import type {
  WorkgroupTaskRoomClarifyParticipantInTx,
  WorkgroupTaskRoomTaskParticipantInTx,
} from '../public/commands'
import { createPostgresqlWorkgroupTaskRoomTaskParticipantInTx } from '../infrastructure/postgresqlWorkgroupTaskRoomTaskParticipant'
import type { PostgresqlTaskExecutionTransaction } from '../infrastructure/postgresqlTaskLifecycleTransaction'

export interface PostgresqlWorkgroupTaskRoomTaskParticipantFactory {
  inTransaction(
    transaction: PostgresqlTaskExecutionTransaction,
  ): WorkgroupTaskRoomTaskParticipantInTx
}

export interface PostgresqlWorkgroupTaskRoomClarifyParticipantFactory {
  inTransaction(
    transaction: PostgresqlTaskExecutionTransaction,
  ): WorkgroupTaskRoomClarifyParticipantInTx
}

export function composePostgresqlWorkgroupTaskRoomTaskParticipantFactory(input: {
  readonly collaboration: PostgresqlWorkgroupTaskRoomClarifyParticipantFactory
}): PostgresqlWorkgroupTaskRoomTaskParticipantFactory {
  return Object.freeze({
    inTransaction: (transaction: PostgresqlTaskExecutionTransaction) =>
      createPostgresqlWorkgroupTaskRoomTaskParticipantInTx(
        transaction,
        input.collaboration.inTransaction(transaction),
      ),
  })
}
