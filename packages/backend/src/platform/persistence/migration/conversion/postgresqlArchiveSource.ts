// RFC-395 U-5: a PostgreSQL conversion reads both the active database and the
// retained RFC-349 archive. Physical absence is not evidence of empty history.
import { digestSchemaContract } from '../../schema/canonical'
import { SourceBlockedError, type VersionedSourceReader } from '../sourceTypes'

/** Both readers are owned by the returned source and are closed together. The
 * caller resolves the installation's retained archive before composing it here;
 * a born-PostgreSQL installation instead needs its never-installed proof. */
export async function composePostgresqlArchiveSource(input: {
  readonly source: VersionedSourceReader
  readonly archive: VersionedSourceReader
}): Promise<VersionedSourceReader> {
  const physical = await input.source.preflight()
  const archive = await input.archive.preflight()
  if (
    physical.kind !== 'postgresql-database' ||
    physical.fingerprint.provider !== 'postgresql' ||
    !physical.contract ||
    !archive.contract ||
    !['logical-artifact', 'logical-backup', 'hosted-backup'].includes(archive.kind)
  )
    throw new SourceBlockedError('PostgreSQL history requires a verified epoch-1 logical archive')
  const tables = physical.contract.tables.filter(
    (table) => table.disposition === 'ARCHIVE_THEN_OMIT',
  )
  for (const table of tables) {
    const archived = archive.contract.tables.find((entry) => entry.id === table.id)
    if (
      !physical.expectedAbsent.includes(table.id) ||
      physical.tables.some((entry) => entry.table === table.id) ||
      !archive.tables.some(
        (entry) => entry.table === table.id && entry.disposition === 'archived',
      ) ||
      !archived ||
      digestSchemaContract(archived) !== digestSchemaContract(table)
    )
      throw new SourceBlockedError(`PostgreSQL retained archive coverage differs: ${table.id}`)
  }
  const names = new Set(tables.map((table) => table.id))
  const preflight = {
    ...physical,
    tables: [...physical.tables, ...archive.tables.filter((entry) => names.has(entry.table))],
    expectedAbsent: physical.expectedAbsent.filter((table) => !names.has(table)),
    watermark: digestSchemaContract({
      database: physical.watermark,
      archive: archive.watermark,
    }),
  }
  let closed = false
  const assertOpen = () => {
    if (closed) throw new SourceBlockedError('Source reader is closed')
  }
  const reader: VersionedSourceReader = {
    kind: physical.kind,
    async preflight() {
      await reader.assertUnchanged(preflight)
      return preflight
    },
    async assertUnchanged(expected) {
      assertOpen()
      if (digestSchemaContract(expected) !== digestSchemaContract(preflight))
        throw new SourceBlockedError('PostgreSQL archive source preflight differs from the plan')
      await input.source.assertUnchanged(physical)
      await input.archive.assertUnchanged(archive)
    },
    readChunk(table, afterKey, limit) {
      assertOpen()
      return (names.has(table) ? input.archive : input.source).readChunk(table, afterKey, limit)
    },
    readRawChunk(table, afterKey, limit) {
      assertOpen()
      return (names.has(table) ? input.archive : input.source).readRawChunk(table, afterKey, limit)
    },
    async close() {
      if (closed) return
      closed = true
      try {
        await input.source.close()
      } finally {
        await input.archive.close()
      }
    },
  }
  return reader
}
