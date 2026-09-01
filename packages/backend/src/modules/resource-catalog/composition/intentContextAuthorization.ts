import type { DbTxSync } from '@/db/txSync'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import {
  createIntentContextResourceAuthorizationSession,
  createIntentContextResourceAuthorizationSyncSession,
  type IntentContextResourceAuthorizationSyncSession,
} from '../application/participants/intentContextResourceAuthorization'
import type {
  IntentContextResourceAuthorizationSession,
  ResourceRequestContext,
} from '../public/participants'
import { createPostgresqlIntentContextResourceAuthorizationReadPort } from '../infrastructure/postgresqlIntentContextResourceAuthorization'
import type { PostgresqlResourceCatalogTransaction } from '../infrastructure/postgresql/repositorySupport'
import {
  createSqliteIntentContextResourceAuthorizationReadPort,
  createSqliteIntentContextResourceAuthorizationSyncReadPort,
} from '../infrastructure/sqliteIntentContextResourceAuthorization'

export interface IntentContextResourceAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: DirectAuthenticatedAuthority
}

export interface SqliteIntentContextResourceAuthorizationFactory {
  inTransaction(
    transaction: DbTxSync,
    pair: IntentContextResourceAuthorityPair,
  ): IntentContextResourceAuthorizationSession
}

/** Provider-private SQLite seam for a synchronous dbTxSync owner. */
export interface SqliteIntentContextResourceAuthorizationSyncFactory {
  inTransaction(
    transaction: DbTxSync,
    pair: IntentContextResourceAuthorityPair,
  ): IntentContextResourceAuthorizationSyncSession
}

export interface PostgresqlIntentContextResourceAuthorizationFactory {
  inTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
    pair: IntentContextResourceAuthorityPair,
  ): IntentContextResourceAuthorizationSession
}

function currentAuthorityResolver(pair: IntentContextResourceAuthorityPair) {
  return Object.freeze({
    resolve(authority: ResourceRequestContext): DirectAuthenticatedAuthority {
      if (authority !== pair.authority) {
        throw new Error('foreign-intent-context-resource-authority')
      }
      return pair.actor
    },
  })
}

/** SQLite bootstrap seam; it never opens or owns the surrounding transaction. */
export function composeSqliteIntentContextResourceAuthorizationFactory(): SqliteIntentContextResourceAuthorizationFactory {
  return Object.freeze({
    inTransaction(transaction: DbTxSync, pair: IntentContextResourceAuthorityPair) {
      return createIntentContextResourceAuthorizationSession(
        currentAuthorityResolver(pair),
        createSqliteIntentContextResourceAuthorizationReadPort(transaction),
      )
    },
  })
}

/** SQLite-only composition seam that never returns a Promise inside dbTxSync. */
export function composeSqliteIntentContextResourceAuthorizationSyncFactory(): SqliteIntentContextResourceAuthorizationSyncFactory {
  return Object.freeze({
    inTransaction(transaction: DbTxSync, pair: IntentContextResourceAuthorityPair) {
      return createIntentContextResourceAuthorizationSyncSession(
        currentAuthorityResolver(pair),
        createSqliteIntentContextResourceAuthorizationSyncReadPort(transaction),
      )
    },
  })
}

/** PostgreSQL bootstrap seam; the external Intent owner supplies its live tx. */
export function composePostgresqlIntentContextResourceAuthorizationFactory(): PostgresqlIntentContextResourceAuthorizationFactory {
  return Object.freeze({
    inTransaction(
      transaction: PostgresqlResourceCatalogTransaction,
      pair: IntentContextResourceAuthorityPair,
    ) {
      return createIntentContextResourceAuthorizationSession(
        currentAuthorityResolver(pair),
        createPostgresqlIntentContextResourceAuthorizationReadPort(transaction),
      )
    },
  })
}
