import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { engineOf } from '../../databaseTransaction'
import type { PersistenceDb } from '../../persistenceDb'
import { rawRows } from '../../queryHelpers'
import { metaTableName } from './meta'
import { databaseHandleContext } from '../../sessionTables'

export interface DispositionArchive {
  readonly runId: string
  readonly sourceTable: string
  readonly sourceKey: string
  readonly archiveRef: string
  readonly disposition: Readonly<Record<string, unknown>>
  readonly bytes: Uint8Array
  readonly values: Readonly<Record<string, unknown>>
}
/** Decode logical-row@1 source-journal containers without importing offline migration code. */
export function decodeDispositionArchive(bytes: Uint8Array): Readonly<Record<string, unknown>> {
  const decode = (node: unknown): unknown => {
    const tuple = z.tuple([z.string(), z.unknown()]).parse(node)
    const [kind, data] = tuple
    if (kind === 'bigint') return BigInt(z.string().parse(data))
    if (kind === 'array') return z.array(z.unknown()).parse(data).map(decode)
    if (kind === 'object')
      return Object.fromEntries(
        z
          .array(z.tuple([z.string(), z.unknown()]))
          .parse(data)
          .map(([key, value]) => [key, decode(value)]),
      )
    if (kind !== 'scalar') throw new Error('disposition-archive-container-invalid')
    const cell = z.object({ type: z.string(), value: z.unknown().optional() }).parse(data)
    switch (cell.type) {
      case 'null':
        return null
      case 'text':
        return z.string().parse(cell.value)
      case 'boolean':
        return z.boolean().parse(cell.value)
      case 'bytes':
        return Uint8Array.from(Buffer.from(z.string().parse(cell.value), 'base64'))
      case 'integer': {
        const value = BigInt(z.string().parse(cell.value))
        return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(value)
          : value
      }
      case 'real':
        return z.number().finite().parse(Number(cell.value))
      default:
        throw new Error('disposition-archive-cell-invalid')
    }
  }
  return z
    .record(z.string(), z.unknown())
    .parse(decode(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))))
}

const runtimeArchives = new WeakMap<object, Map<string, Promise<readonly DispositionArchive[]>>>()

function cacheDispositionArchives(
  tables: Map<string, Promise<readonly DispositionArchive[]>>,
  sourceTable: string,
  pending: Promise<readonly DispositionArchive[]>,
) {
  tables.set(sourceTable, pending)
  void pending.catch(() => {
    if (tables.get(sourceTable) === pending) tables.delete(sourceTable)
  })
  return pending
}

/** Begin a runtime on this connection, including a new admission after a fixture/restore. */
export function initializeDispositionArchives(
  db: PersistenceDb,
  sourceTable: string,
): Promise<readonly DispositionArchive[]> {
  const runtime = databaseHandleContext(db)
  let tables = runtimeArchives.get(runtime)
  if (!tables) {
    tables = new Map()
    runtimeArchives.set(runtime, tables)
  }
  return cacheDispositionArchives(tables, sourceTable, loadDispositionArchives(db, sourceTable))
}

/** Conversion metadata is immutable for the lifetime of an admitted generation. */
export function readDispositionArchives(
  db: PersistenceDb,
  sourceTable: string,
): Promise<readonly DispositionArchive[]> {
  const runtime = databaseHandleContext(db)
  let tables = runtimeArchives.get(runtime)
  if (!tables) {
    tables = new Map()
    runtimeArchives.set(runtime, tables)
  }
  let pending = tables.get(sourceTable)
  if (!pending) {
    pending = cacheDispositionArchives(
      tables,
      sourceTable,
      loadDispositionArchives(db, sourceTable),
    )
  }
  return pending
}

/** Metadata is a platform mechanism. Only archives on the active generation's lineage are visible. */
async function loadDispositionArchives(
  db: PersistenceDb,
  sourceTable: string,
): Promise<readonly DispositionArchive[]> {
  const provider = engineOf(db).provider
  const generations = sql.raw(metaTableName(provider, 'generations'))
  const dispositions = sql.raw(metaTableName(provider, 'migration_row_dispositions'))
  const archives = sql.raw(metaTableName(provider, 'migration_archives'))
  const lineage = sql`WITH RECURSIVE lineage AS (
      SELECT generation_id, source_generation_id, run_id FROM ${generations} WHERE state = 'active'
      UNION
      SELECT g.generation_id, g.source_generation_id, g.run_id FROM ${generations} g
      JOIN lineage l ON g.generation_id = l.source_generation_id
    )`
  const condition = sql`d.run_id IN (SELECT run_id FROM lineage WHERE run_id IS NOT NULL)
    AND d.source_table = ${sourceTable} AND d.source_phase = 'current' AND d.kind = 'history-only'`
  // A fresh installation never opens the archive table, even on its first read.
  const index = await rawRows(
    db,
    sql`${lineage} SELECT d.source_key FROM ${dispositions} d WHERE ${condition} LIMIT 1`,
  )
  if (index.length === 0) return []
  const rows = await rawRows<Record<string, unknown>>(
    db,
    sql`${lineage}
    SELECT d.*, a.format AS archive_format, a.byte_size AS archive_byte_size, a.bytes AS archive_bytes
    FROM ${dispositions} d LEFT JOIN ${archives} a ON a.run_id = d.run_id AND a.archive_ref = d.archive_ref
    WHERE ${condition} ORDER BY d.source_key, d.ordinal`,
  )
  return rows.map((row) => {
    if (row.archive_format !== 'logical-row@1' || !(row.archive_bytes instanceof Uint8Array))
      throw new Error(`disposition-archive-missing:${String(row.source_key)}`)
    const bytes = Uint8Array.from(row.archive_bytes)
    if (bytes.byteLength !== Number(row.archive_byte_size))
      throw new Error('disposition-archive-size-mismatch')
    const source = decodeDispositionArchive(bytes)
    if (source.table !== sourceTable || source.encodedKey !== row.source_key)
      throw new Error('disposition-archive-source-mismatch')
    const {
      archive_bytes: _bytes,
      archive_format: _format,
      archive_byte_size: _size,
      ...disposition
    } = row
    return {
      runId: String(row.run_id),
      sourceTable,
      sourceKey: String(row.source_key),
      archiveRef: String(row.archive_ref),
      disposition,
      bytes,
      values: z.record(z.string(), z.unknown()).parse(source.values),
    }
  })
}
