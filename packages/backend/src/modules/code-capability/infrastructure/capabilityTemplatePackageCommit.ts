import { eq } from 'drizzle-orm'

import { capabilityTemplates } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  CapabilityTemplatePackageCommit,
  PreparedCapabilityTemplateWrite,
} from '../application/ports/capabilityTemplatePersistence'

/** Provider-private SQLite participant for a surrounding synchronous aggregate transaction. */
export interface SqliteCapabilityTemplatePackageCommitSync {
  commit(prepared: PreparedCapabilityTemplateWrite): void
}

export function createSqliteCapabilityTemplatePackageCommitSync(
  tx: DbTxSync,
): SqliteCapabilityTemplatePackageCommitSync {
  return {
    commit(prepared) {
      if (prepared.existing === null) {
        tx.insert(capabilityTemplates).values(prepared.row).run()
        return
      }
      tx.update(capabilityTemplates)
        .set(prepared.row)
        .where(eq(capabilityTemplates.id, prepared.row.id))
        .run()
    },
  }
}

type PostgresqlTransaction = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]

/** Async participant bound to the caller's PostgreSQL aggregate transaction. */
export function createPostgresqlCapabilityTemplatePackageCommit(
  tx: PostgresqlTransaction,
): CapabilityTemplatePackageCommit {
  return {
    async commit(prepared) {
      if (prepared.existing === null) {
        await tx.insert(capabilityTemplates).values(prepared.row)
        return
      }
      await tx
        .update(capabilityTemplates)
        .set(prepared.row)
        .where(eq(capabilityTemplates.id, prepared.row.id))
    },
  }
}
