import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSchemaJson } from '../../schema/canonical'
import { vacuumSqliteInto, quickCheckSqlite } from '../legacy/sqliteSnapshot'
import type { SourcePreflight, VersionedSourceReader } from '../sourceTypes'

export function captureLiveSqliteSnapshot(input: {
  readonly path: string
  readonly pointerPath: string
  readonly operationRoot: string
}): { readonly path: string; readonly pointerPath?: string; close(): void } {
  mkdirSync(input.operationRoot, { recursive: true })
  const root = mkdtempSync(join(input.operationRoot, 'plan-snapshot-'))
  const pointerBytes = () =>
    existsSync(input.pointerPath) ? readFileSync(input.pointerPath) : null
  const before = pointerBytes()
  try {
    const path = join(root, 'db.sqlite')
    vacuumSqliteInto({ dbPath: input.path, dest: path })
    quickCheckSqlite({ dbPath: path })
    const after = pointerBytes()
    if (before?.toString('base64') !== after?.toString('base64'))
      throw new Error('source-changed: pointer changed during live snapshot')
    if (before) writeFileSync(join(root, 'generation.json'), before)
    return {
      path,
      ...(before ? { pointerPath: join(root, 'generation.json') } : {}),
      close: () => rmSync(root, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

/** Keep V1's existing read-only transaction for live planning; do not refresh it
 * against a concurrently advancing database. Final freeze uses V1's strict reader. */
export function pinnedSnapshotReader(
  reader: VersionedSourceReader,
  preflight: SourcePreflight,
): VersionedSourceReader {
  return {
    kind: reader.kind,
    async preflight() {
      return preflight
    },
    async assertUnchanged(expected) {
      if (canonicalSchemaJson(expected) !== canonicalSchemaJson(preflight))
        throw new Error('source-changed: snapshot binding differs')
    },
    readChunk: (...args) => reader.readChunk(...args),
    readRawChunk: (...args) => reader.readRawChunk(...args),
    close: () => reader.close(),
  }
}
