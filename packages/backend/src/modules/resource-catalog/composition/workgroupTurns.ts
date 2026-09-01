import type { WorkgroupTurnsOperations } from '@/modules/task-execution/public/commands'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  createPostgresqlWorkgroupTurnsOperations,
  type PostgresqlWorkgroupHostLedgerParticipantFactory,
} from '../infrastructure/postgresqlWorkgroupTurnsOperations'

/**
 * Cross-context composition owns the TaskExecution factory dependency while
 * the Resource Catalog adapter reserves and shares each PostgreSQL transaction.
 */
export function composePostgresqlWorkgroupTurnsOperations(
  db: PostgresqlDatabaseClient,
  hostLedgerFactory: PostgresqlWorkgroupHostLedgerParticipantFactory,
): WorkgroupTurnsOperations {
  return createPostgresqlWorkgroupTurnsOperations({
    db,
    hostLedgerFactory: {
      inTransaction: (transaction) => hostLedgerFactory.inTransaction(transaction),
    },
  })
}
