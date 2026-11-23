import type { HistoryVersion } from './types'
import type { MetaTableDeclaration } from './meta'
import { HistoryCatalogCache, postgresqlCatalogLoader } from './catalog'

/**
 * The binary's schema history: its head, the lineage, the PostgreSQL catalogs and the epoch-2 meta tables. RFC-549: the
 * composition root hands it in (bootstrap's `persistenceSchemaBinding.history`); platform never reads it from module state.
 */
export interface SchemaHistoryRuntime {
  readonly head: () => HistoryVersion
  readonly metaTables: readonly MetaTableDeclaration[]
  readonly history?: (() => readonly HistoryVersion[]) | undefined
  readonly catalogCache?: (() => HistoryCatalogCache) | undefined
}
export function runtimeHistoryAdmission(runtime: SchemaHistoryRuntime) {
  const binary = runtime.head()
  return {
    binary,
    metaTables: runtime.metaTables,
    catalogCache:
      runtime.catalogCache?.() ??
      new HistoryCatalogCache(
        postgresqlCatalogLoader(binary.postgresqlCatalog ? [binary.postgresqlCatalog] : []),
      ),
  }
}
