// RFC-395: codec-less storage evidence; rowid cursors belong only to this immutable copy.
import type { Database, SQLQueryBindings } from 'bun:sqlite'
import { createSha256DigestBuilder } from '@/util/hash'
import { canonicalSchemaJson, digestSchemaContract } from '../schema/canonical'
import { decodeLogicalValue, type CanonicalLogicalValue } from './legacy/logicalDatabaseArtifact'
import { quoteSourceIdentifier as quote } from './sourceCatalog'
import { assertSourceChunkRequest } from './sourceReader'
import {
  SourceBlockedError,
  type RawSourceCell,
  type RawSourceChunk,
  type RawSourceRow,
  type SourceIdentityHighWater,
} from './sourceTypes'

export function rawSourceCell(storageClass: string, value: unknown): RawSourceCell {
  let encoded: CanonicalLogicalValue
  if (value === null) encoded = { type: 'null' }
  else if (value instanceof Uint8Array)
    encoded = { type: 'bytes', value: Buffer.from(value).toString('base64') }
  else if (typeof value === 'bigint') encoded = { type: 'integer', value: String(value) }
  else if (typeof value === 'number') encoded = { type: 'real', value: String(value) }
  else if (typeof value === 'boolean') encoded = { type: 'boolean', value }
  else if (typeof value === 'string') encoded = { type: 'text', value }
  else throw new SourceBlockedError(`Unsupported raw storage value: ${storageClass}`)
  return { storageClass, value: encoded }
}
export function rawSourceChunk(input: {
  sourceVersion: string
  table: string
  migrationKey: readonly string[]
  afterKey: readonly CanonicalLogicalValue[] | null
  rows: readonly RawSourceRow[]
}): RawSourceChunk {
  const payload = {
    version: 1 as const,
    ...input,
    firstKey: input.rows[0]?.key ?? null,
    lastKey: input.rows.at(-1)?.key ?? null,
  }
  return { ...payload, sourceDigest: digestSchemaContract(payload) }
}
function columns(database: Database, table: string) {
  return database
    .query<{ name: string; pk: number; hidden: number }, []>(`PRAGMA table_xinfo(${quote(table)})`)
    .all()
    .filter((row) => row.hidden !== 1)
}
function rawSelection(names: readonly string[]): string {
  return names
    .map(
      (name, index) =>
        `${quote(name)} AS ${quote(`v${index}`)}, typeof(${quote(name)}) AS ${quote(`t${index}`)}`,
    )
    .join(', ')
}
function rawCells(names: readonly string[], row: Record<string, unknown>) {
  return Object.fromEntries(
    names.map((name, index) => [name, rawSourceCell(String(row[`t${index}`]), row[`v${index}`])]),
  )
}
export function readSqliteRawChunk(input: {
  database: Database
  sourceVersion: string
  table: string
  afterKey: readonly CanonicalLogicalValue[] | null
  limit: number
}): RawSourceChunk {
  const fields = columns(input.database, input.table)
  if (!fields.length) throw new SourceBlockedError(`Unknown raw source table ${input.table}`)
  const names = fields.map((field) => field.name)
  const info = input.database
    .query<{ wr: number }, []>(`PRAGMA table_list(${quote(input.table)})`)
    .all()
    .find((row) => row.wr !== undefined)
  const rowid = info?.wr
    ? undefined
    : ['_rowid_', 'rowid', 'oid'].find((name) => !names.includes(name))
  const key = rowid
    ? [rowid]
    : fields
        .filter((field) => field.pk)
        .sort((a, b) => a.pk - b.pk)
        .map((field) => field.name)
  if (!key.length)
    throw new SourceBlockedError(`No deterministic raw migration key for ${input.table}`)
  assertSourceChunkRequest({ id: input.table, migrationKey: key }, input.afterKey, input.limit)
  const order = key.map(quote).join(', ')
  const where =
    input.afterKey === null ? '' : ` WHERE (${order}) > (${key.map(() => '?').join(', ')})`
  const query = input.database.query(
    `SELECT ${rawSelection(names)}, ${key.map((name, i) => `${quote(name)} AS ${quote(`k${i}`)}`).join(', ')} FROM ${quote(input.table)}${where} ORDER BY ${order} LIMIT ${input.limit}`,
  )
  ;(query as typeof query & { safeIntegers(enabled: boolean): void }).safeIntegers(true)
  const rows = query.all(
    ...(input.afterKey?.map((value) => decodeLogicalValue(value) as SQLQueryBindings) ?? []),
  ) as Record<string, unknown>[]
  return rawSourceChunk({
    sourceVersion: input.sourceVersion,
    table: input.table,
    migrationKey: key,
    afterKey: input.afterKey,
    rows: rows.map((row) => ({
      key: key.map((_, i) => rawSourceCell('key', row[`k${i}`]).value),
      cells: rawCells(names, row),
    })),
  })
}
export function sqliteIdentityHighWater(database: Database): readonly SourceIdentityHighWater[] {
  if (!database.query("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get()) return []
  const query = database.query<{ name: string; seq: bigint }, []>(
    'SELECT name, seq FROM sqlite_sequence ORDER BY name',
  )
  ;(query as typeof query & { safeIntegers(enabled: boolean): void }).safeIntegers(true)
  return query.all().map((row) => ({
    name: row.name,
    table: row.name,
    column: null,
    value: String(row.seq),
    isCalled: true,
    increment: '1',
  }))
}
/** Stable across reopen, relocation, VACUUM and WAL checkpoints. Includes schema,
 * journal, identity high-water and every storage value; excludes inode, clocks,
 * connection data_version and synthetic rowids. Any included fact invalidates it. */
export function sqliteContentDigest(database: Database): string {
  const hash = createSha256DigestBuilder()
  const frame = (value: unknown) => {
    const text = canonicalSchemaJson(value)
    hash.update(`${Buffer.byteLength(text)}:`)
    hash.update(text)
  }
  database.exec('BEGIN')
  try {
    frame(
      database.query('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    )
    for (const name of ['user_version', 'application_id', 'encoding'])
      frame([name, database.query(`PRAGMA ${name}`).get()])
    const tables = database
      .query<
        { name: string },
        []
      >("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all()
    for (const { name } of tables) {
      const names = columns(database, name).map((field) => field.name)
      frame([name, names])
      const query = database.query(
        `SELECT ${rawSelection(names)} FROM ${quote(name)} ORDER BY ${names.map((column) => `${quote(column)} COLLATE BINARY`).join(', ')}`,
      )
      ;(query as typeof query & { safeIntegers(enabled: boolean): void }).safeIntegers(true)
      for (const row of query.iterate()) frame(rawCells(names, row as Record<string, unknown>))
    }
    return `sha256:${hash.digestHex()}`
  } finally {
    database.exec('ROLLBACK')
  }
}
export function assertSqliteIntegrity(database: Database): void {
  const checks = database.query('PRAGMA quick_check').all() as { quick_check: string }[]
  if (checks.length !== 1 || checks[0]?.quick_check !== 'ok')
    throw new SourceBlockedError('SQLite source failed quick_check')
  const foreignKeys = database.query('PRAGMA foreign_key_check').all()
  if (foreignKeys.length)
    throw new SourceBlockedError(`SQLite source has ${foreignKeys.length} foreign-key violation(s)`)
}
