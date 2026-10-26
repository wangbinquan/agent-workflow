import type { V1Harness } from './rfc395V1Harness'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { parameters } from '@/platform/persistence/schema/history/connection'
import { quoteSchemaIdentifier } from '@/platform/persistence/schema/expressions'
import { databaseProviderTraits } from '@/platform/persistence/providerTraits'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'

/** Write physical epoch-1 rows after h.install(); deliberately bypass logical codecs for malformed fixtures. */
export async function writeV2SourceRows(
  h: V1Harness,
  table: string,
  rows: readonly DecodedSourceRow[],
): Promise<void> {
  const definition = frozenEpoch1Contract.tables.find((definition) => definition.id === table)
  if (!definition) throw new Error(`Unknown frozen source table: ${table}`)
  const columns = new Set(definition.columns.map((column) => column.name))
  for (const row of rows) {
    const names = Object.keys(row)
    if (!names.length || names.some((name) => !columns.has(name)))
      throw new Error(`Unknown frozen source column: ${table}`)
    const values = names.map((name) => {
      const value = row[name]!
      return typeof value === 'boolean' &&
        databaseProviderTraits(h.provider).booleanLiteral(true) === '1'
        ? Number(value)
        : value
    })
    await h.native.execute(
      `INSERT INTO ${h.table(table)} (${names.map(quoteSchemaIdentifier).join(',')}) VALUES (${parameters(h.native, names.length)})`,
      values,
    )
  }
}
