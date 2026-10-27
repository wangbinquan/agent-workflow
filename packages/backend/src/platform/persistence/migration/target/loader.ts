import { persistenceDialect } from '../../nativeDialect'
import type { DatabaseProvider } from '../../databaseProviders'
import type { ColumnDefinition, TableDefinition } from '../../schema/contribution'
import type { SchemaRegistry } from '../../schema/registry'
import { quoteSchemaIdentifier as quote } from '../../schema/expressions'
import { parameters, type HistoryConnection } from '../../schema/history/connection'
import { canonicalValue, encodeMigrationKey } from '../conversion/migrationKey'
import type { TargetRow, TargetValue, UnitOutput } from '../conversion/types'
import type { TargetInsertRejection } from '../run/types'

export function targetTableName(provider: DatabaseProvider, table: string): string {
  return persistenceDialect(provider).tableName(table)
}
export function encodeTargetValue(
  column: ColumnDefinition,
  value: TargetValue,
  provider: DatabaseProvider,
): TargetValue {
  if (value === null) return null
  const dialect = persistenceDialect(provider)
  if (column.codec === 'bool') return dialect.boolean(Boolean(value))
  if (column.codec === 'bigint') return dialect.bigInteger(value as string | number | bigint)
  if (column.codec === 'bytes') return Buffer.from(value as Uint8Array)
  if (column.codec === 'real') return dialect.real(value as number)
  // jsonDoc is already JSON text in V2; the dialect binds it as text and casts ::text::jsonb (see nativeDialect).
  return value
}
export function targetRowKey(table: TableDefinition, row: TargetRow) {
  return encodeMigrationKey(
    table.id,
    table.primaryKey.map((name) => canonicalValue(row[name] ?? null)),
  )
}
export class TargetLoadError extends Error {
  constructor(readonly rejection: { constraint: string | null; message: string }) {
    super(rejection.message)
    this.name = 'TargetLoadError'
  }
}
export function constraintRejection(error: unknown): TargetLoadError | null {
  if (error instanceof TargetLoadError) return error
  if (!error || typeof error !== 'object') return null
  const native = error as {
    code?: string
    errno?: number | string
    constraint?: string
    message?: string
  }
  if (
    !/^(22|23)/u.test(native.code ?? '') &&
    !(typeof native.errno === 'string' && /^(22|23)/u.test(native.errno)) &&
    !native.code?.startsWith('SQLITE_CONSTRAINT') &&
    (typeof native.errno !== 'number' || (native.errno & 255) !== 19)
  )
    return null
  return new TargetLoadError({
    constraint: native.constraint ?? native.code ?? null,
    message: native.message ?? 'target storage rejected row',
  })
}
export interface TargetLoader {
  insert(tx: HistoryConnection, rows: UnitOutput['rows']): Promise<void>
  locate(tx: HistoryConnection, rows: UnitOutput['rows']): Promise<readonly TargetInsertRejection[]>
}
export function createTargetLoader(input: {
  registry: SchemaRegistry
  provider: DatabaseProvider
  batchRows?: number
}): TargetLoader {
  const tables = new Map(input.registry.tables.map((table) => [table.id, table]))
  const batchRows = input.batchRows ?? 100
  if (!Number.isSafeInteger(batchRows) || batchRows < 1) throw new Error('v3-loader-batch-rows')
  const insertRows = async (tx: HistoryConnection, name: string, rows: readonly TargetRow[]) => {
    if (tx.provider !== input.provider) throw new Error('v3-loader-provider-mismatch')
    const table = tables.get(name)
    if (!table) throw new Error(`v3-loader-unknown-table: ${name}`)
    for (let start = 0; start < rows.length; ) {
      const columns = Object.values(table.columns).filter((column) =>
        Object.hasOwn(rows[start]!, column.name),
      )
      if (!columns.length || Object.keys(rows[start]!).length !== columns.length)
        throw new Error(`v3-loader-columns: ${name}`)
      const limit = Math.min(batchRows, Math.max(1, Math.floor(900 / columns.length)))
      let end = start + 1
      while (
        end < rows.length &&
        end - start < limit &&
        Object.keys(rows[end]!).length === columns.length &&
        columns.every((column) => Object.hasOwn(rows[end]!, column.name))
      )
        end++
      const values: TargetValue[] = []
      const groups = rows.slice(start, end).map(
        (row) =>
          `(${columns
            .map((column) => {
              values.push(encodeTargetValue(column, row[column.name]!, input.provider))
              return persistenceDialect(input.provider).parameter(values.length, column.codec)
            })
            .join(', ')})`,
      )
      try {
        await tx.execute(
          `INSERT INTO ${targetTableName(input.provider, name)} (${columns.map((column) => quote(column.name)).join(', ')}) VALUES ${groups.join(', ')}`,
          values,
        )
      } catch (error) {
        throw constraintRejection(error) ?? error
      }
      for (const row of rows.slice(start, end)) {
        const signed = columns.filter(
          (column) => column.codec === 'real' && Object.is(row[column.name], -0),
        )
        if (!signed.length) continue
        const keys = table.primaryKey.map(
          (name) => Object.values(table.columns).find((column) => column.name === name)!,
        )
        const slots = parameters(tx, keys.length).split(', ')
        const saved = await tx.execute(
          `SELECT ${signed.map((column) => quote(column.name)).join(', ')} FROM ${targetTableName(tx.provider, name)} WHERE ${keys.map((column, i) => `${quote(column.name)} = ${slots[i]}`).join(' AND ')}`,
          keys.map((column) => encodeTargetValue(column, row[column.name]!, tx.provider)),
        )
        if (
          saved.length !== 1 ||
          signed.some((column) => !Object.is(Number(saved[0]![column.name]), -0))
        )
          throw new TargetLoadError({
            constraint: 'codec:real:negative-zero',
            message: 'native storage did not preserve negative zero',
          })
      }
      start = end
    }
  }
  return {
    async insert(tx, groups) {
      for (const group of groups) await insertRows(tx, group.table, group.rows)
    },
    async locate(tx, groups) {
      const rejections: TargetInsertRejection[] = []
      await tx.execute('SAVEPOINT v3_locate_unit')
      try {
        for (const group of groups)
          for (const row of group.rows) {
            await tx.execute('SAVEPOINT v3_locate_row')
            try {
              await insertRows(tx, group.table, [row])
            } catch (error) {
              await tx.execute('ROLLBACK TO SAVEPOINT v3_locate_row')
              const rejected = constraintRejection(error)
              if (!rejected) throw error
              rejections.push({
                table: group.table,
                targetKey: targetRowKey(tables.get(group.table)!, row),
                ...rejected.rejection,
              })
            } finally {
              await tx.execute('RELEASE SAVEPOINT v3_locate_row')
            }
          }
      } finally {
        await tx.execute('ROLLBACK TO SAVEPOINT v3_locate_unit')
        await tx.execute('RELEASE SAVEPOINT v3_locate_unit')
      }
      return rejections
    },
  }
}
export async function probeTargetRow(
  tx: HistoryConnection,
  table: TableDefinition,
  values: readonly TargetValue[],
): Promise<boolean> {
  if (values.length !== table.primaryKey.length) return false
  const columns = table.primaryKey.map(
    (name) => Object.values(table.columns).find((column) => column.name === name)!,
  )
  const args = columns.map((column, i) => encodeTargetValue(column, values[i]!, tx.provider))
  const slots = parameters(tx, args.length).split(', ')
  const where = columns.map((column, i) => `${quote(column.name)} = ${slots[i]}`).join(' AND ')
  return (
    (
      await tx.execute(
        `SELECT 1 FROM ${targetTableName(tx.provider, table.id)} WHERE ${where} LIMIT 1`,
        args,
      )
    ).length > 0
  )
}
