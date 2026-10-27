import { atomicScratch } from '../../sqlite/atomicScratch'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSchemaJson } from '../../schema/canonical'
import { decodeLogicalValue } from '../legacy/logicalDatabaseArtifact'
import { canonicalValue } from './migrationKey'
import { orderedDigest } from './digest'
import { ConversionContractError } from './blockCodes'
import type { CanonicalLogicalValue } from '../legacy/logicalDatabaseArtifact'
import type { SourcePhase, SourceRow, TargetValue } from './types'

// Tag containers as well as scalars, so source objects can never collide with codec tags.
export function encodeStagedValue(value: unknown): string {
  const encode = (value: unknown): unknown => {
    if (typeof value === 'bigint') return ['bigint', String(value)]
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      value instanceof Uint8Array
    )
      return ['scalar', canonicalValue(value)]
    if (Array.isArray(value)) return ['array', value.map(encode)]
    if (
      value &&
      typeof value === 'object' &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    )
      return [
        'object',
        Object.entries(value)
          .filter(([, cell]) => cell !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, cell]) => [key, encode(cell)]),
      ]
    throw new ConversionContractError(
      'v2-staging-value',
      'lookup/staging values must be scalar, array or plain object',
    )
  }
  return canonicalSchemaJson(encode(value))
}
export function decodeStagedValue<T>(text: string): T {
  const decode = (node: unknown): unknown => {
    const [kind, data] = node as [string, unknown]
    if (kind === 'bigint') return BigInt(data as string)
    if (kind === 'scalar') return decodeLogicalValue(data as CanonicalLogicalValue)
    if (kind === 'array') return (data as unknown[]).map(decode)
    return Object.fromEntries(
      (data as [string, unknown][]).map(([key, value]) => [key, decode(value)]),
    )
  }
  return decode(JSON.parse(text)) as T
}
export interface StagedReader {
  rows(table: string, phase?: SourcePhase): Iterable<SourceRow>
  read(
    table: string,
    options?: {
      readonly phase?: SourcePhase
      readonly afterKey?: string | null
      readonly limit?: number
    },
  ): readonly SourceRow[]
  get(table: string, key: string, phase?: SourcePhase): SourceRow | undefined
  group(
    table: string,
    column: string,
    value: TargetValue,
    phase?: SourcePhase,
  ): readonly SourceRow[]
  groupKeys(table: string, column: string, phase?: SourcePhase): readonly string[]
  count(table: string, phase?: SourcePhase): number
}
export interface StagedGroupColumn {
  readonly table: string
  readonly column: string
  readonly phase: SourcePhase
}
export interface StagingStore extends StagedReader {
  readonly path: string
  indexedColumns(): readonly StagedGroupColumn[]
  put(row: SourceRow): void
  putMany(rows: readonly SourceRow[]): void
  clear(table: string, phase?: SourcePhase): void
  putLookup(id: string, key: string, value: unknown): void
  lookup<V>(id: string, key: string): V | undefined
  lookupEntries<V>(id: string): Iterable<readonly [string, V]>
  digest(): string
  close(): void
}
export function createStagingStore(scratchRoot: string): StagingStore {
  mkdirSync(scratchRoot, { recursive: true })
  const directory = mkdtempSync(join(scratchRoot, 'conversion-'))
  const path = join(directory, 'staging.sqlite')
  const database = new Database(path)
  database.exec(`CREATE TABLE staged (phase TEXT NOT NULL, tab TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (phase,tab,key));
    CREATE TABLE grouped (phase TEXT NOT NULL, tab TEXT NOT NULL, col TEXT NOT NULL, val TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (phase,tab,col,val,key));
    CREATE TABLE lookups (id TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (id,key));`)
  const read = (
    table: string,
    options: { phase?: SourcePhase; afterKey?: string | null; limit?: number } = {},
  ): readonly SourceRow[] => {
    const limit = options.limit ?? Number.MAX_SAFE_INTEGER
    return database
      .query<{ payload: string }, [string, string, string, number]>(
        'SELECT payload FROM staged WHERE phase=? AND tab=? AND key>? ORDER BY key COLLATE BINARY LIMIT ?',
      )
      .all(options.phase ?? 'current', table, options.afterKey ?? '', limit)
      .map((row) => decodeStagedValue<SourceRow>(row.payload))
  }
  const indexes = new Map<string, StagedGroupColumn>()
  const indexValue = (row: SourceRow, column: string): void => {
    if (Object.hasOwn(row.values, column))
      database
        .query('INSERT INTO grouped VALUES (?,?,?,?,?)')
        .run(row.phase, row.table, column, encodeStagedValue(row.values[column]), row.encodedKey)
  }
  const ensureIndex = (table: string, column: string, phase: SourcePhase): void => {
    const key = JSON.stringify([phase, table, column])
    if (indexes.has(key)) return
    // Unit specs and lookup group queries declare their columns on first use.
    atomicScratch(database, () => {
      for (const row of store.rows(table, phase)) indexValue(row, column)
    })
    indexes.set(key, { table, column, phase })
  }
  const putRow = (row: SourceRow): void => {
    database
      .query('INSERT INTO staged VALUES (?,?,?,?)')
      .run(row.phase, row.table, row.encodedKey, encodeStagedValue(row))
    for (const entry of indexes.values())
      if (entry.table === row.table && entry.phase === row.phase) indexValue(row, entry.column)
  }
  const store: StagingStore = {
    path,
    indexedColumns: () =>
      [...indexes.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, entry]) => entry),
    read,
    *rows(table, phase = 'current') {
      let afterKey: string | null = null
      for (;;) {
        const rows = read(table, { phase, afterKey, limit: 1000 })
        if (!rows.length) return
        yield* rows
        afterKey = rows.at(-1)!.encodedKey
      }
    },
    get(table, key, phase = 'current') {
      const row = database
        .query<
          { payload: string },
          [string, string, string]
        >('SELECT payload FROM staged WHERE phase=? AND tab=? AND key=?')
        .get(phase, table, key)
      return row ? decodeStagedValue<SourceRow>(row.payload) : undefined
    },
    group(table, column, value, phase = 'current') {
      ensureIndex(table, column, phase)
      return database
        .query<{ payload: string }, [string, string, string, string]>(
          `SELECT s.payload FROM grouped g JOIN staged s ON s.phase=g.phase AND s.tab=g.tab AND s.key=g.key WHERE g.phase=? AND g.tab=? AND g.col=? AND g.val=? ORDER BY g.key COLLATE BINARY`,
        )
        .all(phase, table, column, encodeStagedValue(value))
        .map((row) => decodeStagedValue<SourceRow>(row.payload))
    },
    groupKeys(table, column, phase = 'current') {
      ensureIndex(table, column, phase)
      const values = database
        .query<
          { val: string },
          [string, string, string]
        >('SELECT DISTINCT val FROM grouped WHERE phase=? AND tab=? AND col=? ORDER BY val COLLATE BINARY')
        .all(phase, table, column)
      return values
        .map(({ val }) => {
          const value = decodeStagedValue<unknown>(val)
          if (typeof value !== 'string')
            throw new ConversionContractError('v2-group-key', `${table}.${column} must be text`)
          return value
        })
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    },
    count(table, phase = 'current') {
      return database
        .query<
          { count: number },
          [string, string]
        >('SELECT COUNT(*) AS count FROM staged WHERE phase=? AND tab=?')
        .get(phase, table)!.count
    },
    put(row) {
      atomicScratch(database, () => putRow(row))
    },
    putMany(rows) {
      // A bounded source page is one atomic scratch edit, not one disk commit per row.
      atomicScratch(database, () => {
        for (const row of rows) putRow(row)
      })
    },
    clear(table, phase = 'current') {
      atomicScratch(database, () => {
        database.query('DELETE FROM grouped WHERE phase=? AND tab=?').run(phase, table)
        database.query('DELETE FROM staged WHERE phase=? AND tab=?').run(phase, table)
      })
    },
    putLookup(id, key, value) {
      database.query('INSERT INTO lookups VALUES (?,?,?)').run(id, key, encodeStagedValue(value))
    },
    lookup<V>(id: string, key: string): V | undefined {
      const row = database
        .query<
          { payload: string },
          [string, string]
        >('SELECT payload FROM lookups WHERE id=? AND key=?')
        .get(id, key)
      return row ? decodeStagedValue<V>(row.payload) : undefined
    },
    *lookupEntries<V>(id: string): Iterable<readonly [string, V]> {
      let after: string | null = null
      for (;;) {
        const rows = database
          .query<
            { key: string; payload: string },
            [string, string | null, string | null]
          >('SELECT key,payload FROM lookups WHERE id=? AND (? IS NULL OR key>?) ORDER BY key COLLATE BINARY LIMIT 1000')
          .all(id, after, after)
        if (!rows.length) return
        for (const row of rows) yield [row.key, decodeStagedValue<V>(row.payload)] as const
        after = rows.at(-1)!.key
      }
    },
    digest() {
      function* fragments(): Iterable<string> {
        for (const row of database
          .query<
            { phase: string; tab: string; key: string; payload: string },
            []
          >('SELECT phase,tab,key,payload FROM staged ORDER BY phase COLLATE BINARY,tab COLLATE BINARY,key COLLATE BINARY')
          .iterate())
          yield canonicalSchemaJson(row)
      }
      return orderedDigest(fragments())
    },
    close() {
      database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
  return store
}
