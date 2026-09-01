import type { DbTxSync } from '@/db/txSync'
import type { WorkgroupTaskRoomClarifyParticipantInTx } from '@/modules/task-execution/public/commands'
import type { PostgresqlCommittedEventTransaction } from '@/platform/events/committed/postgresqlPersistence'
import { createPostgresqlWorkgroupTaskRoomClarifyParticipantInTx } from '../infrastructure/postgresqlWorkgroupTaskRoomClarifyParticipant'
import { createSqliteWorkgroupTaskRoomClarifyParticipantInTx } from '../infrastructure/sqliteWorkgroupTaskRoomClarifyParticipant'

export interface SqliteWorkgroupTaskRoomClarifyParticipantFactory {
  inTransaction(transaction: DbTxSync): WorkgroupTaskRoomClarifyParticipantInTx
}

export interface PostgresqlWorkgroupTaskRoomClarifyParticipantFactory {
  inTransaction(
    transaction: PostgresqlCommittedEventTransaction,
  ): WorkgroupTaskRoomClarifyParticipantInTx
}

export function composeSqliteWorkgroupTaskRoomClarifyParticipantFactory(): SqliteWorkgroupTaskRoomClarifyParticipantFactory {
  return Object.freeze({
    inTransaction: createSqliteWorkgroupTaskRoomClarifyParticipantInTx,
  })
}

export function composePostgresqlWorkgroupTaskRoomClarifyParticipantFactory(): PostgresqlWorkgroupTaskRoomClarifyParticipantFactory {
  return Object.freeze({
    inTransaction: createPostgresqlWorkgroupTaskRoomClarifyParticipantInTx,
  })
}
