// RFC-395: preserve every retired/metadata row before a frozen upgrade can drop its table.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSchemaJson } from '../schema/canonical'
import type { CanonicalLogicalValue } from './legacy/logicalDatabaseArtifact'
import {
  SourceBlockedError,
  type SourcePreflight,
  type SourceTableDisposition,
  type VersionedSourceReader,
} from './sourceTypes'
export interface SourceDispositionEvidence {
  readonly table: SourceTableDisposition
  readonly rows: number
  readonly chunks: readonly { readonly path: string; readonly digest: string }[]
}
export async function captureSourceDispositionRows(
  source: VersionedSourceReader,
  preflight: SourcePreflight,
  directory: string,
): Promise<readonly SourceDispositionEvidence[]> {
  mkdirSync(directory, { recursive: true })
  // Identity high-water belongs to the original source, even when an offline load resets sequences.
  writeFileSync(join(directory, 'preflight.json'), canonicalSchemaJson(preflight))
  const evidence: SourceDispositionEvidence[] = []
  for (const table of preflight.tables.filter(
    (table) => table.disposition === 'archived' || table.disposition === 'metadata',
  )) {
    const chunks: { path: string; digest: string }[] = []
    let rows = 0
    let afterKey: readonly CanonicalLogicalValue[] | null = null
    for (;;) {
      const chunk = await source.readRawChunk(table.table, afterKey, 1000)
      if (!chunk.rows.length) break
      const path = join(directory, `${chunk.sourceDigest.slice(7)}.json`)
      writeFileSync(path, canonicalSchemaJson(chunk))
      chunks.push({ path, digest: chunk.sourceDigest })
      rows += chunk.rows.length
      afterKey = chunk.lastKey
    }
    if (rows !== table.rows)
      throw new SourceBlockedError(`Pre-upgrade disposition census differs: ${table.table}`)
    evidence.push({ table, rows, chunks })
  }
  writeFileSync(join(directory, 'dispositions.json'), canonicalSchemaJson(evidence))
  return evidence
}
