import { createAuthRuntime, type AuthRuntime } from './application/authRuntime'
import type { AuthRuntimeOptions } from './application/authPersistence'
import {
  createTokenCallAuditParticipant,
  type TokenCallAuditParticipant,
  type TokenCallRecord,
} from './application/tokenCallAudit'
import { allowsLegacyDaemonTestAccess, type DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { PostgresqlAuthPersistence } from './infrastructure/postgresqlAuthPersistence'
import { PostgresqlTokenCallAuditPersistence } from './infrastructure/postgresqlTokenCallAudit'
import { SqliteAuthPersistence } from './infrastructure/sqliteAuthPersistence'
import { SqliteTokenCallAuditPersistence } from './infrastructure/sqliteTokenCallAudit'

export function createSqliteAuthRuntime(input: {
  readonly db: DbClient
  readonly revalidate?: (reason: Parameters<typeof triggerRevalidation>[0]) => void
}): AuthRuntime {
  return createAuthRuntime({
    provider: 'sqlite',
    persistence: new SqliteAuthPersistence(input.db),
    options: {
      allowLegacyDaemonTestAccess: allowsLegacyDaemonTestAccess(input.db),
      onCredentialRevoked: (reason) => {
        if (input.revalidate !== undefined) input.revalidate(reason)
        else triggerRevalidation(reason)
      },
    },
  })
}

export function createPostgresqlAuthRuntime(input: {
  readonly db: PostgresqlDatabaseClient
  /** Required post-commit transport invalidation; never receives a DB handle. */
  readonly onCredentialRevoked: NonNullable<AuthRuntimeOptions['onCredentialRevoked']>
}): AuthRuntime {
  return createAuthRuntime({
    provider: 'postgresql',
    persistence: new PostgresqlAuthPersistence(input.db),
    options: { onCredentialRevoked: input.onCredentialRevoked },
  })
}

export function createSqliteTokenCallAudit(db: DbClient): TokenCallAuditParticipant {
  return createTokenCallAuditParticipant(new SqliteTokenCallAuditPersistence(db))
}

export function createPostgresqlTokenCallAudit(
  db: PostgresqlDatabaseClient,
): TokenCallAuditParticipant {
  return createTokenCallAuditParticipant(new PostgresqlTokenCallAuditPersistence(db))
}

/**
 * Compatibility bridge for callers not yet assembled by provider bootstrap.
 * The legacy service delegates here and therefore contains no SQL mechanism;
 * root composition can replace each call site with one long-lived participant.
 */
export const legacySqliteTokenCallAudit = Object.freeze({
  record(db: DbClient, record: TokenCallRecord, now?: number) {
    return createSqliteTokenCallAudit(db).record(record, now)
  },
  listForUser(db: DbClient, userId: string, limit?: number) {
    return createSqliteTokenCallAudit(db).listForUser(userId, limit)
  },
  list(db: DbClient, limit?: number) {
    return createSqliteTokenCallAudit(db).list(limit)
  },
  prune(db: DbClient, retentionDays: number, now?: number) {
    return createSqliteTokenCallAudit(db).prune(retentionDays, now)
  },
  pruneSlice(
    db: DbClient,
    retentionDays: number,
    cursor: unknown,
    now?: number,
    batchSize?: number,
  ) {
    return createSqliteTokenCallAudit(db).pruneSlice(retentionDays, cursor, now, batchSize)
  },
})
