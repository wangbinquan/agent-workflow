// Shared catalog values do not depend on provider collectors or catalog compilation.
import { canonicalSchemaJson } from '../canonical'

export interface CatalogEntry {
  readonly kind: string
  readonly relation: string
  readonly name: string
  readonly definition: string
}
export type HistoryCatalog = readonly CatalogEntry[]
export interface PostgresqlCatalogArtifact {
  readonly formatVersion: 1
  readonly schemaEpoch: 2
  readonly version: number
  readonly planDigest: string
  readonly metaDigest: string
  readonly postgresqlMajor: number
  readonly catalog: HistoryCatalog
  readonly digest: string
}

export function sortHistoryCatalog(rows: CatalogEntry[]): HistoryCatalog {
  return rows.sort((a, b) => canonicalSchemaJson(a).localeCompare(canonicalSchemaJson(b)))
}
