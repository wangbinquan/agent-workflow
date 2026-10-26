import type { DecodedSourceRow } from '../sourceTypes'
import type { StagedReader, StagingStore } from './staging'
import { encodeStagedValue } from './staging'
import type { LookupVersion, SourcePhase, TargetValue, SourceRef, SourceRow } from './types'
import { bytesDigest, unorderedDigest } from './digest'
import { canonicalValue, encodeMigrationKey } from './migrationKey'
import { BLOCK_CODES, ConversionContractError } from './blockCodes'

export interface LookupKey<V> {
  readonly id: string
  readonly version: number
  readonly _v?: V
}
export function lookupKey<V>(id: string, version: number): LookupKey<V> {
  return Object.freeze({ id, version })
}
export function lookupIdentity(key: LookupKey<unknown>): string {
  return JSON.stringify([key.id, key.version])
}
export interface LookupSourceStatus {
  readonly state: 'present-but-undecodable'
  readonly source: SourceRef
  readonly columns: readonly string[]
  readonly takenOverColumns: readonly string[]
}
interface StoredLookupEntry<V> {
  readonly value: V
  readonly sourceStatus?: LookupSourceStatus
}
export interface LookupReader<V> {
  get(key: string): V | undefined
  sourceStatus(key: string): LookupSourceStatus | undefined
  require(key: string): V
  entries(): Iterable<readonly [string, V]>
  readonly version: LookupVersion
}
export interface LookupResolver {
  <V>(key: LookupKey<V>): LookupReader<V>
}
export interface LookupBuilder<V> {
  readonly key: LookupKey<V>
  readonly sources: readonly string[]
  readonly sourcePhase?: SourcePhase
  readonly dependsOn?: readonly LookupKey<unknown>[]
  build(
    staged: StagedReader,
    put: (key: string, value: V, sourceStatus?: LookupSourceStatus) => void,
    lookups: LookupResolver,
  ): void | Promise<void>
}
export function orderLookupBuilders(
  builders: readonly LookupBuilder<unknown>[],
): readonly LookupBuilder<unknown>[] {
  const byId = new Map<string, LookupBuilder<unknown>>()
  for (const builder of builders) {
    const id = lookupIdentity(builder.key)
    if (byId.has(id)) throw new ConversionContractError('v2-duplicate-lookup', id)
    if (!builder.key.id || !Number.isSafeInteger(builder.key.version) || builder.key.version < 1)
      throw new ConversionContractError('v2-lookup-version', id)
    byId.set(id, builder)
  }
  const visiting = new Set<string>()
  const done = new Set<string>()
  const result: LookupBuilder<unknown>[] = []
  const visit = (id: string): void => {
    if (done.has(id)) return
    if (visiting.has(id)) throw new ConversionContractError('v2-lookup-cycle', id)
    const builder = byId.get(id)
    if (!builder) throw new ConversionContractError(BLOCK_CODES.missingLookup, id)
    visiting.add(id)
    for (const key of [...(builder.dependsOn ?? [])].sort((a, b) =>
      lookupIdentity(a).localeCompare(lookupIdentity(b)),
    ))
      visit(lookupIdentity(key))
    visiting.delete(id)
    done.add(id)
    result.push(builder)
  }
  for (const id of [...byId.keys()].sort()) visit(id)
  return result
}
export function restrictLookups(
  resolve: LookupResolver,
  keys: readonly LookupKey<unknown>[],
): LookupResolver {
  const allowed = new Set(keys.map(lookupIdentity))
  return <V>(key: LookupKey<V>): LookupReader<V> => {
    if (!allowed.has(lookupIdentity(key)))
      throw new ConversionContractError('v2-undeclared-lookup', key.id)
    return resolve(key)
  }
}
export async function buildLookups(
  builders: readonly LookupBuilder<unknown>[],
  staged: StagingStore,
): Promise<LookupResolver> {
  const versions = new Map<string, LookupVersion>()
  const resolve: LookupResolver = <V>(key: LookupKey<V>): LookupReader<V> => {
    const id = lookupIdentity(key)
    const version = versions.get(id)
    if (!version) throw new ConversionContractError(BLOCK_CODES.missingLookup, id)
    return {
      version,
      get: (key) => staged.lookup<StoredLookupEntry<V>>(id, key)?.value,
      sourceStatus: (key) => staged.lookup<StoredLookupEntry<V>>(id, key)?.sourceStatus,
      require(key) {
        const entry = staged.lookup<StoredLookupEntry<V>>(id, key)
        if (entry === undefined)
          throw new ConversionContractError(BLOCK_CODES.missingLookup, `${id}/${key}`)
        return entry.value
      },
      *entries() {
        for (const [key, entry] of staged.lookupEntries<StoredLookupEntry<V>>(id))
          yield [key, entry.value] as const
      },
    }
  }
  for (const builder of orderLookupBuilders(builders)) {
    const id = lookupIdentity(builder.key)
    const allowed = new Set(builder.sources)
    const check = (table: string, phase?: SourcePhase): void => {
      if (!allowed.has(table) || (phase ?? 'current') !== (builder.sourcePhase ?? 'current'))
        throw new ConversionContractError('v2-undeclared-lookup-source', table)
    }
    const reader: StagedReader = {
      rows(table, phase) {
        check(table, phase)
        return staged.rows(table, phase)
      },
      read(table, options) {
        check(table, options?.phase)
        return staged.read(table, options)
      },
      get(table, key, phase) {
        check(table, phase)
        return staged.get(table, key, phase)
      },
      group(table, column, value, phase) {
        check(table, phase)
        return staged.group(table, column, value, phase)
      },
      groupKeys(table, column, phase) {
        check(table, phase)
        return staged.groupKeys(table, column, phase)
      },
      count(table, phase) {
        check(table, phase)
        return staged.count(table, phase)
      },
    }
    await builder.build(
      reader,
      (key, value, sourceStatus) => {
        if (typeof key !== 'string') throw new ConversionContractError('v2-lookup-key', id)
        if (staged.lookup(id, key) !== undefined)
          throw new ConversionContractError('v2-duplicate-lookup-key', `${id}/${key}`)
        staged.putLookup(id, key, { value, ...(sourceStatus ? { sourceStatus } : {}) })
      },
      restrictLookups(resolve, builder.dependsOn ?? []),
    )
    function* fragments(): Iterable<string> {
      for (const entry of staged.lookupEntries(id)) yield bytesDigest(encodeStagedValue(entry))
    }
    versions.set(id, {
      id: builder.key.id,
      version: builder.key.version,
      digest: unorderedDigest(fragments()),
    })
  }
  return resolve
}
function sourceStatus(row: SourceRow): LookupSourceStatus | undefined {
  const takenOverColumns = (row.codecTakeovers ?? []).map((failure) => failure.column)
  const columns = [...new Set([...(row.codecFailure?.columns ?? []), ...takenOverColumns])].sort()
  return columns.length
    ? {
        state: 'present-but-undecodable',
        source: { table: row.table, key: row.encodedKey, phase: row.phase },
        columns,
        takenOverColumns: [...takenOverColumns].sort(),
      }
    : undefined
}
export function idSetLookup(table: string, column: string): LookupBuilder<true> {
  return {
    key: lookupKey(`id-set:${JSON.stringify([table, column])}`, 2),
    sources: [table],
    build(staged, put) {
      const ids = new Set<string>()
      for (const row of staged.rows(table))
        if (!sourceStatus(row)?.columns.includes(column)) {
          const value = row.values[column]
          if (typeof value !== 'string')
            throw new ConversionContractError('v2-lookup-key', `${table}.${column}`)
          if (!ids.has(value)) {
            put(value, true, sourceStatus(row))
            ids.add(value)
          }
        }
    },
  }
}
export function columnLookup(
  table: string,
  keys: readonly string[],
  columns: readonly string[],
): LookupBuilder<DecodedSourceRow> {
  return {
    key: lookupKey(`columns:${JSON.stringify([table, keys, columns])}`, 2),
    sources: [table],
    build(staged, put) {
      for (const row of staged.rows(table)) {
        const status = sourceStatus(row)
        if (!keys.some((column) => status?.columns.includes(column))) {
          const values = Object.fromEntries(
            columns
              .filter((column) => !status?.columns.includes(column))
              .map((column) => {
                if (!Object.hasOwn(row.values, column))
                  throw new ConversionContractError('v2-lookup-column', `${table}.${column}`)
                return [column, row.values[column]!]
              }),
          )
          put(
            columnLookupKey(
              table,
              keys.map((column) => row.values[column]!),
            ),
            values,
            status,
          )
        }
      }
    },
  }
}
export function columnLookupKey(table: string, values: readonly TargetValue[]): string {
  if (values.length === 1 && typeof values[0] === 'string') return values[0]
  return encodeMigrationKey(table, values.map(canonicalValue))
}
