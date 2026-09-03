// RFC-349 — the exhaustive per-provider decision table.
//
// Before this table, every provider-specific decision was an inline
// `if (provider === 'postgresql') … else …`. That shape has no forcing function:
// a third provider silently takes the `else` branch and inherits SQLite's
// behaviour. Measured on `1e5a47893`: adding a third member to
// `DatabaseProvider` produced 4 compile errors, all in the schema projection —
// none from the 31 provider forks. Two of those forks were already the exact
// defect class RFC-349 spent a session fixing on PostgreSQL:
//   - boolean DDL defaults rendered as SQLite's '1'/'0'
//   - retryable-write classification using SQLite error codes
//
// `satisfies Record<DatabaseProvider, DatabaseProviderTraits>` turns both into a
// compile error the moment a provider is added: the new provider cannot be
// declared without answering every field here.

import { postgresqlSerializationFailureCode } from '@/db/postgresqlSerializationRetry'
import { retryableSqliteWriteErrorCode } from '@/db/sqliteWriteRetry'

import { type DatabaseProvider } from './databaseProviders'

/**
 * How the daemon relates to the store. `embedded-file` means the daemon owns a
 * file it can stat, vacuum and back up in-process; `external-server` means a
 * separate server process the daemon only connects to.
 *
 * Ask this instead of `provider === 'sqlite'` whenever the question is really
 * "is there a local file?" — a new provider then answers correctly by
 * declaration rather than by falling through a branch.
 */
export type DatabaseStorageShape = 'embedded-file' | 'external-server'

export interface DatabaseProviderTraits {
  readonly storage: DatabaseStorageShape
  /**
   * Renders a boolean literal for DDL defaults. SQLite has no boolean type and
   * takes 1/0; PostgreSQL rejects those for a `boolean` column.
   */
  readonly booleanLiteral: (value: boolean) => string
  /**
   * Maps an error to a retryable-write code, or `undefined` when the write must
   * not be retried. Provider-specific: SQLite reports lock contention, and
   * PostgreSQL reports serialization/deadlock failures instead.
   */
  readonly classifyRetryable: (error: unknown) => string | undefined
}

export const DATABASE_PROVIDER_TRAITS = {
  sqlite: {
    storage: 'embedded-file',
    booleanLiteral: (value) => (value ? '1' : '0'),
    classifyRetryable: retryableSqliteWriteErrorCode,
  },
  postgresql: {
    storage: 'external-server',
    booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
    classifyRetryable: postgresqlSerializationFailureCode,
  },
} as const satisfies Record<DatabaseProvider, DatabaseProviderTraits>

export function databaseProviderTraits(provider: DatabaseProvider): DatabaseProviderTraits {
  return DATABASE_PROVIDER_TRAITS[provider]
}
