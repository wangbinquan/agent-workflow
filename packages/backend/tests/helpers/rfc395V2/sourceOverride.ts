// Malformed references cannot be inserted into the frozen FK-on database or pass V1 admission.
// Inject them only at the converter seam, retaining real frozen rows and canonical chunks.
import type {
  DecodedSourceRow,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { encodeLogicalRow } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import { sourceChunk } from '@/platform/persistence/migration/sourceReader'

export function overrideSourceValues(
  source: VersionedSourceReader,
  table: string,
  transform: (row: DecodedSourceRow) => DecodedSourceRow,
): VersionedSourceReader {
  const contract = frozenEpoch1Contract.tables.find((entry) => entry.id === table)!
  return {
    ...source,
    async readChunk(name, afterKey, limit) {
      const chunk = await source.readChunk(name, afterKey, limit)
      if (name !== table) return chunk
      return sourceChunk({
        sourceVersion: chunk.sourceVersion,
        table: contract,
        afterKey,
        rows: chunk.decodedRows.map((row) => encodeLogicalRow(contract, transform(row))),
      })
    },
  }
}
