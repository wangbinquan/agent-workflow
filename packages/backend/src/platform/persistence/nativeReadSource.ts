// RFC-395 II-b O3 — read-only views of the native handles already opened by diagnostics.
import type { Database } from 'bun:sqlite'
import type { PostgresqlPool } from './postgresqlRuntime'

export type NativeDatabaseReadSource =
  | { readonly provider: 'sqlite'; readonly db: Pick<Database, 'query'> }
  | { readonly provider: 'postgresql'; readonly pool: Pick<PostgresqlPool, 'unsafe'> }
