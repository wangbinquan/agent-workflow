import { quoteSchemaIdentifier as quote } from './schema/expressions'
import type { DatabaseProvider } from './databaseProviders'

/** Native SQL and storage capabilities shared by live persistence and offline conversion. */
interface PersistenceDialect {
  readonly sourceLocationKind: 'sqlite-file' | 'postgresql-database'
  readonly targetLocationKind: 'sqlite-file' | 'postgresql-target'
  readonly switchBackupKind: 'sqlite-vacuum' | 'postgresql-logical'
  readonly externalArchive: boolean
  readonly requiresScratchProfile: boolean
  readonly deferredForeignKeys: boolean
  readonly rowLock: string
  readonly readOnly: string
  readonly endReadOnly: readonly string[]
  readonly enforceForeignKeys: readonly string[]
  readonly suspendForeignKeys: readonly string[]
  readonly integrityCheck: { readonly sql: string; readonly result: string } | null
  readonly identityStorage: 'sequence-table' | 'native-sequence'
  tableName(table: string): string
  bigInteger(value: string | number | bigint): string | bigint
  real(value: number): string | number
  parameter(index: number, codec?: string): string
  boolean(value: boolean): number | boolean
  integer(value: number | bigint): number | bigint | string
  target(
    generationId: string,
    profileRef: string,
  ):
    | { readonly kind: 'sqlite-file'; readonly relativePath: string }
    | { readonly kind: 'postgresql-target'; readonly profileRef: string }
}
const dialects: Readonly<Record<DatabaseProvider, PersistenceDialect>> = {
  sqlite: {
    tableName: quote,
    bigInteger: (value) => BigInt(value),
    real: (value) => value,
    suspendForeignKeys: ['PRAGMA foreign_keys = OFF'],
    integrityCheck: { sql: 'PRAGMA integrity_check', result: 'integrity_check' },
    identityStorage: 'sequence-table',
    sourceLocationKind: 'sqlite-file',
    targetLocationKind: 'sqlite-file',
    switchBackupKind: 'sqlite-vacuum',
    externalArchive: false,
    requiresScratchProfile: false,
    deferredForeignKeys: false,
    rowLock: '',
    readOnly: 'PRAGMA query_only = ON',
    endReadOnly: ['PRAGMA query_only = OFF'],
    enforceForeignKeys: ['PRAGMA foreign_keys = ON', 'PRAGMA foreign_keys'],
    parameter: () => '?',
    boolean: (value) => (value ? 1 : 0),
    integer: (value) => value,
    target: (generationId) => ({
      kind: 'sqlite-file',
      relativePath: `databases/${generationId}/db.sqlite`,
    }),
  },
  postgresql: {
    tableName: (table) => `${quote('agent_workflow')}.${quote(table)}`,
    bigInteger: (value) => String(value),
    real: (value) => (Object.is(value, -0) ? '-0' : value),
    suspendForeignKeys: [],
    integrityCheck: null,
    identityStorage: 'native-sequence',
    sourceLocationKind: 'postgresql-database',
    targetLocationKind: 'postgresql-target',
    switchBackupKind: 'postgresql-logical',
    externalArchive: true,
    requiresScratchProfile: true,
    deferredForeignKeys: true,
    rowLock: ' FOR UPDATE',
    readOnly: 'SET TRANSACTION READ ONLY',
    endReadOnly: [],
    enforceForeignKeys: [],
    parameter: (index, codec) => `$${index}${codec === 'jsonDoc' ? '::jsonb' : ''}`,
    boolean: (value) => value,
    integer: (value) => (typeof value === 'bigint' ? String(value) : value),
    target: (_generationId, profileRef) => ({ kind: 'postgresql-target', profileRef }),
  },
}
export function persistenceDialect(provider: DatabaseProvider): PersistenceDialect {
  return dialects[provider]
}
