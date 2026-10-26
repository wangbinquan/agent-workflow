import type { HistoryVersion } from './types'
import type { MetaTableDeclaration } from './meta'
import { HistoryCatalogCache, postgresqlCatalogLoader } from './catalog'

export interface SchemaHistoryRuntime {
  readonly head: () => HistoryVersion
  readonly metaTables: readonly MetaTableDeclaration[]
  readonly history?: () => readonly HistoryVersion[]
  readonly catalogCache?: () => HistoryCatalogCache
}
let binding: SchemaHistoryRuntime | undefined
export function registerSchemaHistoryRuntime(value: SchemaHistoryRuntime): void {
  binding = value
}
export function schemaHistoryRuntime(): SchemaHistoryRuntime {
  if (!binding) throw new Error('schema-history-runtime-unbound')
  return binding
}
export function runtimeHistoryAdmission() {
  const runtime = schemaHistoryRuntime()
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
