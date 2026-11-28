import type { MigrationProgressCallback } from '../run/progress'
import { atomicScratch } from '../../sqlite/atomicScratch'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalSchemaJson } from '../../schema/canonical'
import { decodeLogicalValue } from '../legacy/logicalDatabaseArtifact'
import type { DecodedSourceRow } from '../sourceTypes'
import { canonicalValue } from './migrationKey'
import { bytesDigest, orderedDigest } from './digest'
import { ConversionContractError } from './blockCodes'
import type { CanonicalLogicalValue } from '../legacy/logicalDatabaseArtifact'
import type { SettlementRewrite, SourcePhase, SourceRow, TargetValue } from './types'

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
/**
 * RFC-626: how a staged row is stored. Evidence (`encodeStagedValue`) stays canonical and sorted;
 * storage only has to give the same row back, so it is plain JSON with three tags for the
 * decoded values JSON cannot carry. Staging wrote and re-read every row through the canonical
 * form before, which was a tenth of a conversion on a 1 GB database.
 */
type PackedValue =
  | string
  | number
  | boolean
  | null
  | readonly ['b', string]
  | readonly ['x', string]
  | readonly ['n', string]
function packValue(value: TargetValue): PackedValue {
  if (typeof value === 'bigint') return ['b', String(value)]
  if (value instanceof Uint8Array) return ['x', Buffer.from(value).toString('base64')]
  if (typeof value === 'number' && (Object.is(value, -0) || !Number.isFinite(value)))
    return ['n', Object.is(value, -0) ? '-0' : String(value)]
  return value
}
function unpackValue(value: PackedValue): TargetValue {
  if (!Array.isArray(value)) return value as string | number | boolean | null
  const [tag, data] = value as readonly [string, string]
  if (tag === 'b') return BigInt(data)
  if (tag === 'x') return Uint8Array.from(Buffer.from(data, 'base64'))
  return Number(data)
}
export function packStagedRow(row: SourceRow): string {
  const { values, ...rest } = row
  return JSON.stringify({
    ...rest,
    values: Object.fromEntries(Object.entries(values).map(([key, cell]) => [key, packValue(cell)])),
  })
}
export function unpackStagedRow(text: string): SourceRow {
  const stored = JSON.parse(text) as Omit<SourceRow, 'values'> & {
    values: Record<string, PackedValue>
  }
  return {
    ...stored,
    values: Object.fromEntries(
      Object.entries(stored.values).map(([key, cell]) => [key, unpackValue(cell)]),
    ) as DecodedSourceRow,
  }
}
/** The per-row evidence digest of table receipts: the source row as stored, never the rewrite. */
export function stagedRowDigest(row: Pick<SourceRow, 'canonical' | 'raw'>): string {
  return bytesDigest(canonicalSchemaJson({ canonical: row.canonical, raw: row.raw ?? null }))
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
  readonly peakBytes: number
  indexedColumns(): readonly StagedGroupColumn[]
  put(row: SourceRow): void
  putMany(rows: readonly SourceRow[]): void
  clear(table: string, phase?: SourcePhase): void
  putLookup(id: string, key: string, value: unknown): void
  lookup<V>(id: string, key: string): V | undefined
  lookupEntries<V>(id: string): Iterable<readonly [string, V]>
  /** RFC-626: drop one lookup so it can be rebuilt after staged rows were rewritten. */
  clearLookup(id: string): void
  /**
   * RFC-626: replace the decoded values of staged rows that belong to a task the upgrade ends.
   * The stored evidence (`canonical`, `raw`) and the row digest do not change.
   */
  rewrite(
    rows: readonly {
      readonly table: string
      readonly phase: SourcePhase
      readonly key: string
      readonly values: DecodedSourceRow
      readonly settlement: SettlementRewrite
    }[],
  ): void
  /** RFC-626: source tables that have rewritten rows, as `[phase, table]`. */
  rewrittenTables(): readonly (readonly [SourcePhase, string])[]
  /** RFC-626: encoded keys of one table in key order, without decoding any row. */
  keys(table: string, phase?: SourcePhase): Iterable<string>
  /** RFC-626: row digests of one table in digest order, without decoding any row. */
  rowDigests(table: string, phase?: SourcePhase): Iterable<string>
  /** RFC-626: distinct target rows linked from one source table, counted in the scratch file. */
  noteTargets(
    source: string,
    phase: SourcePhase,
    targets: readonly { readonly table: string; readonly key: string }[],
  ): void
  targetCounts(
    source: string,
    phase: SourcePhase,
  ): readonly { readonly table: string; readonly rows: number }[]
  digest(): string
  close(): void
}
export function createStagingStore(
  scratchRoot: string,
  progress?: MigrationProgressCallback,
): StagingStore {
  mkdirSync(scratchRoot, { recursive: true })
  const directory = mkdtempSync(join(scratchRoot, 'conversion-'))
  const path = join(directory, 'staging.sqlite')
  const database = new Database(path)
  // `digest` is the row's evidence digest, computed once when the row is staged.
  database.exec(`CREATE TABLE staged (phase TEXT NOT NULL, tab TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, rewritten INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (phase,tab,key));
    CREATE TABLE grouped (phase TEXT NOT NULL, tab TEXT NOT NULL, col TEXT NOT NULL, val TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (phase,tab,col,val,key));
    CREATE TABLE lookups (id TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (id,key));
    CREATE TABLE linked (phase TEXT NOT NULL, tab TEXT NOT NULL, target TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (phase,tab,target,key)) WITHOUT ROWID;`)
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
      .map((row) => unpackStagedRow(row.payload))
  }
  let peakBytes = 0
  const measure = () => {
    if (!closed)
      peakBytes = Math.max(
        peakBytes,
        readdirSync(directory).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0),
      )
    return peakBytes
  }
  let closed = false
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
      measure()
    })
    indexes.set(key, { table, column, phase })
  }
  const putRow = (row: SourceRow): void => {
    database
      .query('INSERT INTO staged (phase,tab,key,payload,digest) VALUES (?,?,?,?,?)')
      .run(row.phase, row.table, row.encodedKey, packStagedRow(row), stagedRowDigest(row))
    for (const entry of indexes.values())
      if (entry.table === row.table && entry.phase === row.phase) indexValue(row, entry.column)
  }
  const store: StagingStore = {
    path,
    get peakBytes() {
      return measure()
    },
    indexedColumns: () =>
      [...indexes.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, entry]) => entry),
    read,
    *rows(table, phase = 'current') {
      let completed = 0
      let afterKey: string | null = null
      for (;;) {
        const rows = read(table, { phase, afterKey, limit: 1000 })
        if (!rows.length) return
        yield* rows
        completed += rows.length
        progress?.({
          phase: 'conversion',
          detail: `scan ${phase}/${table}`,
          completed,
          unit: 'rows',
        })
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
      return row ? unpackStagedRow(row.payload) : undefined
    },
    group(table, column, value, phase = 'current') {
      ensureIndex(table, column, phase)
      return database
        .query<{ payload: string }, [string, string, string, string]>(
          `SELECT s.payload FROM grouped g JOIN staged s ON s.phase=g.phase AND s.tab=g.tab AND s.key=g.key WHERE g.phase=? AND g.tab=? AND g.col=? AND g.val=? ORDER BY g.key COLLATE BINARY`,
        )
        .all(phase, table, column, encodeStagedValue(value))
        .map((row) => unpackStagedRow(row.payload))
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
      atomicScratch(database, () => {
        putRow(row)
        measure()
      })
    },
    putMany(rows) {
      // A bounded source page is one atomic scratch edit, not one disk commit per row.
      atomicScratch(database, () => {
        for (const row of rows) putRow(row)
        measure()
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
    clearLookup(id) {
      database.query('DELETE FROM lookups WHERE id=?').run(id)
    },
    rewrite(rows) {
      atomicScratch(database, () => {
        for (const entry of rows) {
          const stored = store.get(entry.table, entry.key, entry.phase)
          if (!stored)
            throw new ConversionContractError(
              'v2-settlement-row',
              `${entry.phase}/${entry.table}/${entry.key}`,
            )
          const next: SourceRow = { ...stored, values: entry.values, settlement: entry.settlement }
          database
            .query('UPDATE staged SET payload=?, rewritten=1 WHERE phase=? AND tab=? AND key=?')
            .run(packStagedRow(next), entry.phase, entry.table, entry.key)
          database
            .query('DELETE FROM grouped WHERE phase=? AND tab=? AND key=?')
            .run(entry.phase, entry.table, entry.key)
          for (const index of indexes.values())
            if (index.table === entry.table && index.phase === entry.phase)
              indexValue(next, index.column)
        }
        measure()
      })
    },
    rewrittenTables() {
      return database
        .query<{ phase: SourcePhase; tab: string }, []>(
          'SELECT DISTINCT phase,tab FROM staged WHERE rewritten=1 ORDER BY phase COLLATE BINARY,tab COLLATE BINARY',
        )
        .all()
        .map((row) => [row.phase, row.tab] as const)
    },
    *keys(table, phase = 'current') {
      for (const row of database
        .query<
          { key: string },
          [string, string]
        >('SELECT key FROM staged WHERE phase=? AND tab=? ORDER BY key COLLATE BINARY')
        .iterate(phase, table))
        yield row.key
    },
    *rowDigests(table, phase = 'current') {
      // Hex text: binary order and JavaScript string order agree, so this is the sorted multiset.
      for (const row of database
        .query<
          { digest: string },
          [string, string]
        >('SELECT digest FROM staged WHERE phase=? AND tab=? ORDER BY digest COLLATE BINARY')
        .iterate(phase, table))
        yield row.digest
    },
    noteTargets(source, phase, targets) {
      if (!targets.length) return
      atomicScratch(database, () => {
        const insert = database.query('INSERT OR IGNORE INTO linked VALUES (?,?,?,?)')
        for (const target of targets) insert.run(phase, source, target.table, target.key)
      })
    },
    targetCounts(source, phase) {
      return database
        .query<{ target: string; rows: number }, [string, string]>(
          'SELECT target, COUNT(*) AS rows FROM linked WHERE phase=? AND tab=? GROUP BY target',
        )
        .all(phase, source)
        .map((row) => ({ table: row.target, rows: row.rows }))
        .sort((a, b) => a.table.localeCompare(b.table))
    },
    digest() {
      // RFC-626: over each row's key and evidence digest. It binds one run to the staged
      // source it converted; rewrites are bound by the settlements in the plan digest.
      function* fragments(): Iterable<string> {
        let completed = 0
        for (const row of database
          .query<
            { phase: string; tab: string; key: string; digest: string },
            []
          >('SELECT phase,tab,key,digest FROM staged ORDER BY phase COLLATE BINARY,tab COLLATE BINARY,key COLLATE BINARY')
          .iterate()) {
          yield `${row.phase}\n${row.tab}\n${row.key}\n${row.digest}`
          if (++completed % 1000 === 0)
            progress?.({ phase: 'conversion', detail: 'staging digest', completed, unit: 'rows' })
        }
      }
      return orderedDigest(fragments())
    },
    close() {
      measure()
      closed = true
      database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
  return store
}
