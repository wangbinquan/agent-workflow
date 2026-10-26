import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSchemaJson, digestSchemaContract } from '../../../schema/canonical'
import { rawSourceChunk } from '../../rawSourceReader'
import type { SourceDispositionEvidence } from '../../sourceDispositionEvidence'
import {
  SourceBlockedError,
  type RawSourceChunk,
  type SourcePreflight,
  type VersionedSourceReader,
} from '../../sourceTypes'

/** Reopen V1's persisted pre-upgrade evidence after the frozen chain has removed its tables. */
export function openDispositionEvidenceSource(directory: string): VersionedSourceReader {
  const preflightText = readFileSync(join(directory, 'preflight.json'), 'utf8')
  const dispositionText = readFileSync(join(directory, 'dispositions.json'), 'utf8')
  const original = JSON.parse(preflightText) as SourcePreflight
  const evidence = JSON.parse(dispositionText) as readonly SourceDispositionEvidence[]
  const preflight: SourcePreflight = { ...original, tables: evidence.map((entry) => entry.table) }
  const read = (
    table: string,
    part: SourceDispositionEvidence['chunks'][number],
  ): RawSourceChunk => {
    const chunk = JSON.parse(readFileSync(part.path, 'utf8')) as RawSourceChunk
    const { sourceDigest, ...payload } = chunk
    if (
      chunk.table !== table ||
      chunk.sourceVersion !== original.sourceVersion ||
      sourceDigest !== part.digest ||
      digestSchemaContract(payload) !== sourceDigest
    )
      throw new SourceBlockedError(`Pre-upgrade disposition chunk differs: ${table}`)
    return chunk
  }
  const verify = (): void => {
    if (
      readFileSync(join(directory, 'preflight.json'), 'utf8') !== preflightText ||
      readFileSync(join(directory, 'dispositions.json'), 'utf8') !== dispositionText
    )
      throw new SourceBlockedError('Pre-upgrade disposition manifest changed')
    for (const entry of evidence) {
      if (
        !original.tables.some(
          (table) => canonicalSchemaJson(table) === canonicalSchemaJson(entry.table),
        )
      )
        throw new SourceBlockedError(
          `Pre-upgrade disposition not in original preflight: ${entry.table.table}`,
        )
      const count = entry.chunks.reduce(
        (sum, part) => sum + read(entry.table.table, part).rows.length,
        0,
      )
      if (count !== entry.rows || count !== entry.table.rows)
        throw new SourceBlockedError(`Pre-upgrade disposition census differs: ${entry.table.table}`)
    }
  }
  verify()
  return {
    kind: original.kind,
    async preflight() {
      verify()
      return preflight
    },
    async assertUnchanged(expected) {
      if (canonicalSchemaJson(expected) !== canonicalSchemaJson(preflight))
        throw new SourceBlockedError('Pre-upgrade disposition binding differs')
      verify()
    },
    async readChunk() {
      throw new SourceBlockedError('Pre-upgrade disposition evidence is raw-only')
    },
    async readRawChunk(table, afterKey, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
        throw new SourceBlockedError('Invalid pre-upgrade evidence chunk limit')
      const entry = evidence.find((entry) => entry.table.table === table)
      if (!entry) throw new SourceBlockedError(`No pre-upgrade disposition evidence: ${table}`)
      let found = afterKey === null
      const rows: RawSourceChunk['rows'][number][] = []
      let migrationKey: readonly string[] = []
      for (const part of entry.chunks) {
        const chunk = read(table, part)
        migrationKey = chunk.migrationKey
        for (const row of chunk.rows) {
          if (!found) {
            if (canonicalSchemaJson(row.key) === canonicalSchemaJson(afterKey)) found = true
          } else if (rows.length < limit) rows.push(row)
        }
        if (rows.length === limit) break
      }
      if (!found) throw new SourceBlockedError(`Unknown pre-upgrade raw cursor: ${table}`)
      return rawSourceChunk({
        sourceVersion: original.sourceVersion,
        table,
        migrationKey,
        afterKey,
        rows,
      })
    },
    async close() {},
  }
}
