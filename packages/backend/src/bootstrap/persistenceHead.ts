// RFC-395 AD-3: one synchronous head source for runtime, installers and test factories.
import { resolve } from 'node:path'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/composition/schema'
import { IS_EMBEDDED, SCHEMA_HISTORY_FILES } from '@/embed.generated'
import {
  readSchemaHeadFile,
  readSchemaHistoryFiles,
  schemaHistoryFiles,
  readHistoryPostgresqlCatalogs,
} from '@/platform/persistence/schema/history/artifacts'
import {
  HistoryCatalogCache,
  postgresqlCatalogLoader,
  supportedPostgresqlMajors,
} from '@/platform/persistence/schema/history/catalog'
import {
  SchemaHistoryError,
  type HistoryVersion,
} from '@/platform/persistence/schema/history/types'

let files: Readonly<Record<string, string>> | undefined
const histories = new Map<number | undefined, readonly HistoryVersion[]>()
const heads = new Map<number | undefined, HistoryVersion>()
function artifactFiles(): Readonly<Record<string, string>> {
  return (files ??= IS_EMBEDDED
    ? SCHEMA_HISTORY_FILES
    : schemaHistoryFiles(resolve(import.meta.dir, '../../db/schema-history/epoch2')))
}
export function persistenceHistory(postgresqlMajor?: number): readonly HistoryVersion[] {
  const cached = histories.get(postgresqlMajor)
  if (cached) return cached
  const versions = readSchemaHistoryFiles(artifactFiles(), postgresqlMajor, EPOCH2_META_TABLES)
  if (!versions.length) throw new SchemaHistoryError('empty', 'embedded epoch-2 history is missing')
  const existingHead = heads.get(postgresqlMajor)
  const normalized =
    existingHead !== undefined &&
    versions.at(-1)!.contract.version === existingHead.contract.version
      ? Object.freeze([...versions.slice(0, -1), existingHead])
      : versions
  histories.set(postgresqlMajor, normalized)
  if (existingHead === undefined) heads.set(postgresqlMajor, normalized.at(-1)!)
  return normalized
}
export function persistenceHead(postgresqlMajor?: number): HistoryVersion {
  const cached = heads.get(postgresqlMajor) ?? histories.get(postgresqlMajor)?.at(-1)
  if (cached) return cached
  const head = readSchemaHeadFile(artifactFiles(), postgresqlMajor, EPOCH2_META_TABLES)
  heads.set(postgresqlMajor, head)
  return head
}
export function persistencePostgresqlCatalogs() {
  return persistenceHistory().flatMap((version) =>
    readHistoryPostgresqlCatalogs(artifactFiles(), version, EPOCH2_META_TABLES),
  )
}
export function persistencePostgresqlMajors(): readonly number[] {
  const catalogs = persistencePostgresqlCatalogs()
  // A major is supported only when every embedded version has its catalog.
  return supportedPostgresqlMajors(catalogs).filter((major) =>
    persistenceHistory().every((version) =>
      catalogs.some(
        (artifact) =>
          artifact.planDigest === version.postgresql.digest && artifact.postgresqlMajor === major,
      ),
    ),
  )
}
export function persistenceCatalogCache(): HistoryCatalogCache {
  return new HistoryCatalogCache(postgresqlCatalogLoader(persistencePostgresqlCatalogs()))
}
