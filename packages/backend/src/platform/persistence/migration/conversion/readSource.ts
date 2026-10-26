import {
  LogicalDatabaseCodecError,
  decodeLogicalValue,
  encodeLogicalValue,
} from '../legacy/logicalDatabaseArtifact'
import type { LogicalTableContract } from '../../schema/contractTypes'
import type {
  DecodedSourceRow,
  RawSourceCell,
  RawSourceRow,
  SourcePreflight,
  VersionedSourceReader,
} from '../sourceTypes'
import type { CanonicalLogicalRow, CanonicalLogicalValue } from '../legacy/logicalDatabaseArtifact'
import type { SourcePhase, SourceRow, SourceCodecTakeover } from './types'
import type { StagingStore } from './staging'
import { encodeMigrationKey, canonicalValue } from './migrationKey'
import { ConversionContractError } from './blockCodes'

function rawValue(cell: RawSourceCell): unknown {
  const value = decodeLogicalValue(cell.value)
  if (typeof value !== 'string') return value
  // PostgreSQL's raw channel deliberately carries server text plus its physical type.
  if (/^(smallint|integer|bigint)$/.test(cell.storageClass)) return BigInt(value)
  if (/^(boolean)$/.test(cell.storageClass))
    return ['t', 'true'].includes(value) ? true : ['f', 'false'].includes(value) ? false : value
  if (/^(real|double precision|numeric(?:\(.*\))?)$/.test(cell.storageClass)) return Number(value)
  if (cell.storageClass === 'bytea' && value.startsWith('\\x'))
    return Buffer.from(value.slice(2), 'hex')
  return value
}
function fromRaw(
  table: string,
  phase: SourcePhase,
  raw: RawSourceRow,
  contract?: LogicalTableContract,
  takeovers: readonly string[] = [],
): SourceRow {
  const values = Object.fromEntries(
    Object.entries(raw.cells).map(([key, cell]) => [key, rawValue(cell)]),
  ) as DecodedSourceRow
  if (!contract) {
    const canonical = {
      key: [...raw.key],
      values: Object.keys(raw.cells)
        .sort()
        .map((column) => raw.cells[column]!.value),
    }
    return {
      table,
      phase,
      key: raw.key,
      encodedKey: encodeMigrationKey(table, raw.key),
      canonical,
      values,
      raw,
    }
  }
  const failures: string[] = []
  const codecTakeovers: SourceCodecTakeover[] = []
  const encoded = contract.columns.map((column) => {
    try {
      return encodeLogicalValue(table, column, values[column.name])
    } catch (error) {
      const cell = raw.cells[column.name]
      if (cell && takeovers.includes(column.name))
        codecTakeovers.push({
          column: column.name,
          raw: cell,
          message: error instanceof Error ? error.message : String(error),
        })
      else failures.push(column.name)
      return cell?.value ?? { type: 'null' as const }
    }
  })
  const byColumn = new Map(contract.columns.map((column, index) => [column.name, encoded[index]!]))
  const logicalKey = contract.migrationKey.map(
    (column) => byColumn.get(column) ?? { type: 'null' as const },
  )
  for (const [index, cell] of logicalKey.entries())
    if (cell.type === 'null' && !failures.includes(contract.migrationKey[index]!))
      failures.push(contract.migrationKey[index]!)
  const key = logicalKey.every((value) => value.type !== 'null') ? logicalKey : raw.key
  const canonical: CanonicalLogicalRow = { key: [...key], values: encoded }
  return {
    table,
    phase,
    key,
    encodedKey: encodeMigrationKey(table, key),
    canonical,
    values: Object.fromEntries(
      contract.columns.map((column, index) => [column.name, decodeLogicalValue(encoded[index]!)]),
    ) as DecodedSourceRow,
    raw,
    ...(codecTakeovers.length ? { codecTakeovers } : {}),
    ...(failures.length
      ? {
          codecFailure: {
            message: `Frozen source codec rejected ${failures.join(', ')}`,
            columns: failures,
          },
        }
      : {}),
  }
}
export function isSourceCodecFailure(error: unknown): boolean {
  return (
    error instanceof LogicalDatabaseCodecError ||
    (error instanceof Error && /logical database (codec|row|migration key)/.test(error.message))
  )
}
export async function stageSourceTable(input: {
  readonly source: VersionedSourceReader
  readonly preflight: SourcePreflight
  readonly table: string
  readonly phase: SourcePhase
  readonly raw: boolean
  readonly limit: number
  readonly staged: StagingStore
  readonly codecTakeovers?: readonly string[]
}): Promise<void> {
  const { source, preflight, table, phase, limit, staged } = input
  const contract = preflight.contract?.tables.find((entry) => entry.id === table)
  const raw = async (): Promise<void> => {
    let after: readonly CanonicalLogicalValue[] | null = null
    for (;;) {
      const chunk = await source.readRawChunk(table, after, limit)
      if (!chunk.rows.length) return
      if (!chunk.lastKey || JSON.stringify(chunk.lastKey) === JSON.stringify(after))
        throw new ConversionContractError('v2-source-cursor', table)
      for (const row of chunk.rows)
        staged.put(
          fromRaw(table, phase, row, input.raw ? undefined : contract, input.codecTakeovers),
        )
      after = chunk.lastKey
    }
  }
  if (input.raw || !contract) {
    await raw()
    return
  }
  let after: readonly CanonicalLogicalValue[] | null = null
  try {
    for (;;) {
      const chunk = await source.readChunk(table, after, limit)
      if (!chunk.rows.length) return
      if (chunk.decodedRows.length !== chunk.rows.length)
        throw new ConversionContractError('v2-source-row-count', table)
      if (!chunk.lastKey || JSON.stringify(chunk.lastKey) === JSON.stringify(after))
        throw new ConversionContractError('v2-source-cursor', table)
      for (const [index, canonical] of chunk.rows.entries()) {
        const values = chunk.decodedRows[index]!
        // Frozen V1 normalizes -0 in its canonical real cell; keep the decoded value where available.
        const normalized = {
          ...canonical,
          values: canonical.values.map((cell, i) =>
            Object.is(values[contract.columns[i]!.name], -0) ? canonicalValue(-0) : cell,
          ),
        }
        staged.put({
          table,
          phase,
          key: canonical.key,
          encodedKey: encodeMigrationKey(table, canonical.key),
          canonical: normalized,
          values,
        })
      }
      after = chunk.lastKey
    }
  } catch (error) {
    if (!isSourceCodecFailure(error)) throw error
    // Raw cursors are rowid/ordinal, not logical keys. Restage the admitted table,
    // then form deterministic logical key ranges; never pass a logical key to raw.
    staged.clear(table, phase)
    await raw()
  }
}
