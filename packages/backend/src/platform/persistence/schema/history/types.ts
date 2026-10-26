// RFC-395 II-b R2: immutable, provider-paired epoch-2 history. No runtime registration.
import type { compileContract } from '../contract'
import type { SchemaExpression } from '../expressions'
import type { PostgresqlCatalogArtifact } from './catalog'
import type { DatabaseProvider } from '../../databaseProviders'

export type CompiledContract = ReturnType<typeof compileContract>
export const SCHEMA_EDGE_KINDS = [
  'add-table',
  'add-column',
  'add-index',
  'replace-check',
  'add-fk',
  'retire-table',
  'rebuild-table',
  'seed-delta',
  'data-transform',
  'owner-metadata',
] as const
export type SchemaEdgeKind = (typeof SCHEMA_EDGE_KINDS)[number]
export type SeedValue = string | number | boolean | null
export type SchemaEdge =
  | { readonly kind: 'add-table' | 'retire-table' | 'owner-metadata'; readonly tableId: string }
  | { readonly kind: 'add-column'; readonly tableId: string; readonly column: string }
  | {
      readonly kind: 'add-index' | 'replace-check' | 'add-fk'
      readonly tableId: string
      readonly name: string
    }
  | {
      readonly kind: 'rebuild-table'
      readonly tableId: string
      /** Target column -> source expression. Omitted columns copy by physical name or use their default. */
      readonly copy?: Readonly<Record<string, SchemaExpression>>
    }
  | {
      readonly kind: 'seed-delta'
      readonly tableId: string
      readonly upsert: readonly Readonly<Record<string, SeedValue>>[]
      readonly remove: readonly Readonly<Record<string, SeedValue>>[]
    }
  | {
      readonly kind: 'data-transform'
      readonly receiptId: string
      readonly idempotent: true
      readonly review: string
      readonly sqlite: readonly string[]
      readonly postgresql: readonly string[]
    }

export interface HistoryStatement {
  readonly kind: string
  readonly logicalId: string
  readonly sql: string
}
export interface ContractArtifact {
  readonly formatVersion: 1
  readonly schemaEpoch: 2
  readonly version: number
  readonly slug: string
  readonly previousDigest: string | null
  readonly edge: SchemaEdge | null
  readonly contract: CompiledContract
  readonly digest: string
}
export interface HistoryPlanArtifact {
  readonly formatVersion: 1
  readonly schemaEpoch: 2
  readonly version: number
  readonly provider: DatabaseProvider
  readonly contractDigest: string
  /** Full compiled head, used for admission without replaying edges. */
  readonly head: readonly HistoryStatement[]
  readonly statements: readonly string[]
  readonly digest: string
}
export interface HistoryVersion {
  readonly contract: ContractArtifact
  readonly sqlite: HistoryPlanArtifact
  readonly postgresql: HistoryPlanArtifact
  /** Stored with the receipt so an older binary can admit an expand-only successor. */
  readonly postgresqlCatalog?: PostgresqlCatalogArtifact
}
export interface SchemaHistoryRow {
  readonly version: number
  readonly contractDigest: string
  readonly sqlitePlanDigest: string
  readonly postgresqlPlanDigest: string
  readonly appliedAt: number
  readonly artifact: HistoryVersion
}
export class SchemaHistoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`schema-history ${code}: ${message}`)
    this.name = 'SchemaHistoryError'
  }
}
