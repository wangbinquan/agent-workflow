import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import type { IntegrationTriggerResourceRequest } from '@/modules/resource-catalog/public/types'
import type {
  IntegrationTriggerAuthorityPair,
  IntegrationTriggerResourceQueries,
} from '../application/ports/scheduledTaskPersistence'
import type { SqliteIntegrationTriggerTransactionBinding } from './sqliteScheduledTaskPersistence'

/** SQLite owns its synchronous transaction mechanism at the infrastructure edge.
 * Composition receives only the closed resource query contract. */
export function createSqliteIntegrationTriggerResources(
  db: DbClient,
  resources: SqliteIntegrationTriggerTransactionBinding,
): IntegrationTriggerResourceQueries {
  return Object.freeze({
    async loadAuthorized(
      pair: IntegrationTriggerAuthorityPair,
      requests: readonly IntegrationTriggerResourceRequest[],
    ) {
      return dbTxSync(db, (tx) =>
        resources.inTransaction(tx, pair).loadAuthorized(pair.authority, requests),
      )
    },
  })
}
