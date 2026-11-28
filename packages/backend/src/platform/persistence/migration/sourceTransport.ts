// RFC-626 §3.3: reading source rows to move them, not to use them.
//
// The copy into the scratch database and the backup export only carry rows from one place to
// another; neither interprets a value. Under the strict value rule, a JSON-text cell that is not
// JSON or a real that is not finite ended both — and with them the upgrade — although the
// conversion has a way out for exactly such a row (it reads the table raw and sets the row
// aside). A reader that can move such values offers `readTransportChunk`; every other reader is
// read the strict way it always was.
import type {
  CanonicalLogicalRow,
  CanonicalLogicalValue,
  LogicalValueRule,
} from './legacy/logicalDatabaseArtifact'
import type { VersionedSourceReader } from './sourceTypes'

export interface TransportChunk {
  readonly rows: readonly CanonicalLogicalRow[]
  readonly lastKey: readonly CanonicalLogicalValue[] | null
}
export interface TransportSourceReader {
  /**
   * The rows `readChunk` would return, in the same order and with the same representation,
   * read under the transport value rule when the reader was opened for an automatic upgrade.
   * The decoded values `readChunk` adds are absent: moving rows never needs them.
   */
  readTransportChunk(
    table: string,
    afterKey: readonly CanonicalLogicalValue[] | null,
    limit: number,
  ): Promise<TransportChunk>
}

export function offersTransportRead(
  source: VersionedSourceReader,
): source is VersionedSourceReader & TransportSourceReader {
  return typeof (source as Partial<TransportSourceReader>).readTransportChunk === 'function'
}

/**
 * One chunk of `table` for a copy made under `rule`. The strict rule, and a reader that has no
 * transport read, give exactly what `readChunk` gives.
 */
export async function readChunkForTransport(
  source: VersionedSourceReader,
  rule: LogicalValueRule,
  table: string,
  afterKey: readonly CanonicalLogicalValue[] | null,
  limit: number,
): Promise<TransportChunk> {
  if (rule === 'transport' && offersTransportRead(source))
    return source.readTransportChunk(table, afterKey, limit)
  const chunk = await source.readChunk(table, afterKey, limit)
  return { rows: chunk.rows, lastKey: chunk.lastKey }
}
