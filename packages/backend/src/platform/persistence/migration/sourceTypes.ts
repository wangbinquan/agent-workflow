// RFC-395 II-b V1: source-side contracts; run/receipt persistence belongs to V3.
import type { DatabaseProvider } from '../databaseProviders'
import type { CanonicalLogicalRow, CanonicalLogicalValue } from './legacy/logicalDatabaseArtifact'
import type { LogicalSchemaContract } from '../schema/contractTypes'
import type { HistoryCatalog } from '../schema/history/catalog'

export type SourceKind =
  | 'sqlite-file'
  | 'sqlite-backup'
  | 'logical-artifact'
  | 'logical-backup'
  | 'hosted-backup'
  | 'postgresql-database'
export type TableDisposition = 'converted' | 'preserved' | 'archived' | 'metadata' | 'blocked'
export interface SourceJournalEntry {
  readonly identity: string
  readonly digest: string
  readonly planDigest?: string
}
export interface SourceFingerprint {
  readonly version: 1
  readonly evidence: 'physical-catalog-and-journal' | 'legacy-logical-artifact'
  readonly provider: DatabaseProvider
  readonly postgresqlMajor?: number
  readonly catalog: HistoryCatalog
  readonly catalogDigest: string
  readonly journal: readonly SourceJournalEntry[]
  /** Diagnostic only, never a version selector. */
  readonly journalEntryCount: number
  readonly tableRows: Readonly<Record<string, number>>
  readonly digest: string
}
export interface SourceDifference {
  readonly path: string
  readonly expected: string | null
  readonly actual: string | null
}
export interface SourceTableDisposition {
  readonly table: string
  readonly rows: number
  readonly physicalTable: string
  readonly destination: SourceDestination
  readonly disposition: TableDisposition
  readonly reason: string
}
export interface SourceContentPresence {
  readonly path: 'runs/' | 'logs/' | 'evidence/'
  readonly state: 'originally-absent' | 'supplied' | 'not-inventoried' | 'external-not-inventoried'
  readonly evidence: string
}
export interface SourcePreflight {
  readonly version: 1
  readonly kind: SourceKind
  readonly sourceVersion: string
  readonly contract: LogicalSchemaContract | null
  readonly fingerprint: SourceFingerprint
  readonly sourceGenerationId: string
  readonly identityHighWater: readonly SourceIdentityHighWater[]
  readonly identityEvidence: 'physical' | 'not-recorded-by-epoch1-artifact'
  readonly logicalBackupVerification?: 'verified' | 'raw-sqlite-only'
  readonly watermark: string
  readonly requiresOfflineUpgrade: boolean
  readonly tables: readonly SourceTableDisposition[]
  readonly expectedAbsent: readonly string[]
  readonly content: readonly SourceContentPresence[]
}
export interface SourceChunk {
  readonly version: 1
  readonly sourceVersion: string
  readonly table: string
  readonly migrationKey: readonly string[]
  readonly afterKey: readonly CanonicalLogicalValue[] | null
  readonly firstKey: readonly CanonicalLogicalValue[] | null
  readonly lastKey: readonly CanonicalLogicalValue[] | null
  /** Frozen codecs preserve lossless integer tags and original text/bytes. */
  readonly rows: readonly CanonicalLogicalRow[]
  readonly decodedRows: readonly DecodedSourceRow[]
  readonly sourceDigest: string
}
export interface VersionedSourceReader {
  readonly kind: SourceKind
  preflight(): Promise<SourcePreflight>
  assertUnchanged(expected: SourcePreflight): Promise<void>
  readChunk(
    table: string,
    afterKey: readonly CanonicalLogicalValue[] | null,
    limit: number,
  ): Promise<SourceChunk>
  readRawChunk(
    table: string,
    afterKey: readonly CanonicalLogicalValue[] | null,
    limit: number,
  ): Promise<RawSourceChunk>
  close(): Promise<void>
}
export type DecodedSourceValue = string | number | bigint | boolean | Uint8Array | null
export type DecodedSourceRow = Readonly<Record<string, DecodedSourceValue>>
export class SourceBlockedError extends Error {
  readonly code = 'source-blocked'
  constructor(
    message: string,
    readonly differences: readonly SourceDifference[] = [],
    readonly tables: readonly SourceTableDisposition[] = [],
  ) {
    super(message)
    this.name = 'SourceBlockedError'
  }
}

export type SourceDestination =
  | { readonly kind: 'business'; readonly tables: readonly string[] }
  | {
      readonly kind: 'migration-records'
      readonly records: readonly ('migration' | 'activation' | 'identity')[]
    }
  | { readonly kind: 'archive' }
  | { readonly kind: 'blocked' }
export interface SourceIdentityHighWater {
  readonly name: string
  readonly table: string | null
  readonly column: string | null
  readonly value: string
  readonly isCalled: boolean
  readonly increment: string
}
export interface RawSourceCell {
  readonly storageClass: string
  readonly value: CanonicalLogicalValue
}
export interface RawSourceRow {
  readonly key: readonly CanonicalLogicalValue[]
  readonly cells: Readonly<Record<string, RawSourceCell>>
}
export interface RawSourceChunk {
  readonly version: 1
  readonly sourceVersion: string
  readonly table: string
  readonly migrationKey: readonly string[]
  readonly afterKey: readonly CanonicalLogicalValue[] | null
  readonly firstKey: readonly CanonicalLogicalValue[] | null
  readonly lastKey: readonly CanonicalLogicalValue[] | null
  readonly rows: readonly RawSourceRow[]
  readonly sourceDigest: string
}
export function sourceFailure(error: unknown): SourceBlockedError {
  return error instanceof SourceBlockedError
    ? error
    : new SourceBlockedError(error instanceof Error ? error.message : String(error))
}
