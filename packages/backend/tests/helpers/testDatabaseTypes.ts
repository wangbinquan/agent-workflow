// RFC-395 II-b W0: M-a implements testDatabase.ts; T/N/C/F/X/H/P/M consume. Types only.
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import type { EngineCapabilities } from '@/platform/persistence/capabilities'
import type { DatabaseSession } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HistoryVersion } from '@/platform/persistence/schema/history/types'

/** EPOCH2_META_TABLES: three R2 tables plus all eighteen V3 tables, including approvals. */
export type TestDatabaseMetaTables = readonly [
  'schema_history',
  'first_write',
  'schema_transform_receipts',
  'generations',
  'migration_operations',
  'migration_runs',
  'migration_approvals',
  'migration_units',
  'migration_unit_sources',
  'migration_table_receipts',
  'migration_row_dispositions',
  'migration_history_restrictions',
  'migration_artifact_receipts',
  'migration_archives',
  'migration_records',
  'migration_identity_high_water',
  'migration_blocks',
  'migration_operator_inputs',
  'migration_receipt_exports',
  'activation_receipts',
  'switch_receipts',
]

export type CreateTestDbOptions = {
  /** Existing fixture convention: default marks login bootstrap complete. */
  readonly bootstrap?: 'ready' | 'required'
  readonly now?: number
} & (
  | { readonly provider: 'sqlite'; readonly filename?: string }
  | {
      readonly provider: 'postgresql'
      /** Same environment-name convention as eachProvider; a missing URL is an error. */
      readonly urlEnv: string
    }
)

export interface TestDatabase {
  readonly db: PersistenceDb
  readonly session: DatabaseSession
  readonly capabilities: EngineCapabilities
  readonly provider: DatabaseProvider
  readonly baseline: {
    readonly schemaEpoch: 2
    readonly head: HistoryVersion
    readonly seeds: 'install-only'
    readonly metaTables: TestDatabaseMetaTables
    readonly binding: 'epoch-2'
  }
  /** Restore the installed head and seeds; discard prior test business/meta state. */
  reset(): Promise<void>
  close(): Promise<void>
}

/** Both providers install the live head and install-only seeds with all migration metadata.
 * SQLite shares the synchronous serialized baseline with createInMemoryDb; historical
 * callers use migration-freeze's separate source clients and accessor.
 */
export type CreateTestDb = (options?: CreateTestDbOptions) => Promise<TestDatabase>
