import { and, eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { contentRefColumns, type ContentStore } from '@/platform/content/contentStore'
import type { CodeHistoryReader } from '../../application/ports/historyReader'
import {
  CodeHistoryReadError,
  codeHistoryOriginalId,
  decodeCodeHistoryPackage,
  projectCodeHistoryRow,
  type CodeHistorySource,
  type CodeHistoryTable,
} from '../../domain/codeHistoryPackage'

export type CodeHistoryInstallation =
  | { readonly kind: 'fresh-install' }
  | { readonly kind: 'converted'; readonly source: CodeHistorySource }

export function createCodeHistoryPackageReader(input: {
  readonly db: Pick<PersistenceDb, 'select'>
  readonly content: Pick<ContentStore, 'read'>
  readonly installation: CodeHistoryInstallation
}): CodeHistoryReader {
  const { db, content, installation } = input
  async function load(table: CodeHistoryTable) {
    if (installation.kind === 'fresh-install') return null
    const { source } = installation
    const { codeHistoryArchives } = tablesOf(db)
    const archives = await db
      .select()
      .from(codeHistoryArchives)
      .where(
        and(
          eq(codeHistoryArchives.sourceGeneration, source.sourceGeneration),
          eq(codeHistoryArchives.sourceContract, source.contract.digest),
          eq(codeHistoryArchives.sourceTable, table),
        ),
      )
    if (archives.length !== 1)
      throw new CodeHistoryReadError(
        archives.length === 0 ? 'code-history-package-missing' : 'code-history-package-conflict',
        table,
      )
    const archive = archives[0]!
    try {
      const ref = contentRefColumns.decode(archive.contentRefJson, archive.contentInlineBytes)
      if (ref === null) throw new CodeHistoryReadError('code-history-content-missing', table)
      const records = decodeCodeHistoryPackage(await content.read(ref), archive, source)
      return { archive, records }
    } catch (error) {
      if (error instanceof CodeHistoryReadError) throw error
      throw new CodeHistoryReadError('code-history-content-invalid', `${table}: ${String(error)}`)
    }
  }
  return {
    async rows(table) {
      const loaded = await load(table)
      return loaded?.records.map((record) => projectCodeHistoryRow(table, record.row)) ?? []
    },
    async find(table, originalId) {
      const loaded = await load(table)
      if (loaded === null) return null
      const { codeHistoryIdIndex } = tablesOf(db)
      const entries = await db
        .select()
        .from(codeHistoryIdIndex)
        .where(
          and(
            eq(codeHistoryIdIndex.sourceTable, table),
            eq(codeHistoryIdIndex.originalId, originalId),
            eq(codeHistoryIdIndex.sourceContract, loaded.archive.sourceContract),
          ),
        )
      const fail = (): never => {
        throw new CodeHistoryReadError('code-history-index-invalid', `${table}/${originalId}`)
      }
      if (entries.length === 0) {
        if (
          loaded.records.some((record) => codeHistoryOriginalId(table, record.key) === originalId)
        )
          fail()
        return null
      }
      if (entries.length !== 1) return fail()
      const entry = entries[0]!
      const record = loaded.records[entry.recordOrdinal]
      if (
        entry.archiveId !== loaded.archive.id ||
        !Number.isSafeInteger(entry.recordOrdinal) ||
        record === undefined ||
        codeHistoryOriginalId(table, record.key) !== originalId
      )
        return fail()
      try {
        if (
          canonicalSchemaJson(JSON.parse(entry.originalKeyJson)) !== canonicalSchemaJson(record.key)
        )
          return fail()
      } catch {
        return fail()
      }
      return record
    },
  }
}
