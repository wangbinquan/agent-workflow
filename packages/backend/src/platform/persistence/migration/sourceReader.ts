// RFC-395 II-b V1: common frozen-codec chunks and artifact presence evidence.
import { createSha256DigestBuilder } from '@/util/hash'
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  compareCanonicalLogicalKeys,
  decodeLogicalRow,
  encodeLogicalRow,
  type CanonicalLogicalRow,
  type CanonicalLogicalValue,
} from './legacy/logicalDatabaseArtifact'
import { digestSchemaContract } from '../schema/canonical'
import type { LogicalTableContract } from '../schema/contractTypes'
import {
  SourceBlockedError,
  sourceFailure,
  type SourceChunk,
  type SourceKind,
  type SourceContentPresence,
  type DecodedSourceRow,
} from './sourceTypes'

export function sourceChunk(input: {
  readonly sourceVersion: string
  readonly table: LogicalTableContract
  readonly afterKey: readonly CanonicalLogicalValue[] | null
  readonly rows: readonly CanonicalLogicalRow[]
}): SourceChunk {
  try {
    let previous = input.afterKey
    const decodedRows = input.rows.map((row) => {
      const decoded = decodeLogicalRow(input.table, row)
      const encoded = encodeLogicalRow(input.table, decoded)
      if (previous !== null && compareCanonicalLogicalKeys(previous, encoded.key) >= 0)
        throw new SourceBlockedError(`Non-deterministic migration-key order in ${input.table.id}`)
      previous = encoded.key
      return decoded as DecodedSourceRow
    })
    const payload = {
      version: 1 as const,
      sourceVersion: input.sourceVersion,
      table: input.table.id,
      migrationKey: input.table.migrationKey,
      afterKey: input.afterKey,
      firstKey: input.rows[0]?.key ?? null,
      lastKey: input.rows.at(-1)?.key ?? null,
      rows: input.rows,
    }
    return { ...payload, decodedRows, sourceDigest: digestSchemaContract(payload) }
  } catch (error) {
    throw sourceFailure(error)
  }
}
export function assertSourceChunkRequest(
  table: Pick<LogicalTableContract, 'id' | 'migrationKey'>,
  afterKey: readonly CanonicalLogicalValue[] | null,
  limit: number,
): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)
    throw new SourceBlockedError('Source chunk limit must be between 1 and 10000')
  if (afterKey !== null && afterKey.length !== table.migrationKey.length)
    throw new SourceBlockedError(`Source migration-key shape differs: ${table.id}`)
}
export function sourceContentPresence(input: {
  readonly root: string
  readonly kind: SourceKind
}): readonly SourceContentPresence[] {
  return (['runs/', 'logs/', 'evidence/'] as const).map((path) => {
    const supplied =
      existsSync(join(input.root, path)) && statSync(join(input.root, path)).isDirectory()
    const state = supplied
      ? 'supplied'
      : input.kind === 'sqlite-backup' || input.kind === 'logical-backup'
        ? 'originally-absent'
        : input.kind === 'hosted-backup'
          ? 'external-not-inventoried'
          : 'not-inventoried'
    return {
      path,
      state,
      evidence: supplied
        ? 'directory present in the actual source tree'
        : state === 'originally-absent'
          ? 'epoch-1 SQLite portable backup never included this directory; absence checked'
          : 'V3 must inventory referenced content at the freeze watermark',
    }
  })
}
/** File content watermarks also detect same-size chunk/manifest edits. */
export async function sourceFilesDigest(root: string): Promise<string> {
  const hash = createSha256DigestBuilder()
  const visit = async (path: string, relative: string): Promise<void> => {
    const info = statSync(path)
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort())
        await visit(join(path, name), `${relative}/${name}`)
    } else {
      hash.update(JSON.stringify([relative, info.size]))
      for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer)
    }
  }
  await visit(root, '')
  return `sha256:${hash.digestHex()}`
}
