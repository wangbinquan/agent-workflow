// RFC-395 II-b R1: install inputs are provider neutral; conversion never invokes this compiler.
import { CODECS } from './codecs'
import type { SchemaRegistry } from './registry'
import { canonicalSchemaJson, digestSchemaContract } from './canonical'
import { renderSchemaExpression, quoteSchemaIdentifier as quote } from './expressions'
import { unhandledDatabaseProvider, type DatabaseProvider } from '../databaseProviders'

export const installTime = { kind: 'install-time', codec: 'epochMs' } as const
export type SeedValue = string | number | boolean | null | typeof installTime
export interface InstallSeed {
  readonly table: string
  readonly mode: 'install-only'
  /** Physical column names; omitted cells resolve declared literal defaults or NULL. */
  readonly rows: readonly Readonly<Record<string, SeedValue>>[]
}
export type InstallPath = 'new-install' | 'test-baseline' | 'hosted-installation'
export interface CompiledSeedRow {
  readonly table: string
  readonly values: Readonly<Record<string, string | number | boolean | null>>
}
export function compileInstallSeeds(
  registry: SchemaRegistry,
  input: { readonly path: InstallPath; readonly installedAt: number },
) {
  if (!['new-install', 'test-baseline', 'hosted-installation'].includes(input.path))
    throw new Error('RFC-395 seeds are install-only')
  if (!Number.isSafeInteger(input.installedAt)) throw new Error('RFC-395 invalid installation time')
  const rows: CompiledSeedRow[] = []
  for (const contribution of registry.contributions)
    for (const seed of contribution.seeds ?? []) {
      const table = contribution.tables.find((table) => table.id === seed.table)
      if (!table || seed.mode !== 'install-only')
        throw new Error(`RFC-395 invalid seed table: ${seed.table}`)
      for (const row of seed.rows) {
        const columns = Object.values(table.columns)
        if (Object.keys(row).some((name) => !columns.some((column) => column.name === name)))
          throw new Error(`RFC-395 unknown seed column: ${seed.table}`)
        const values: Record<string, string | number | boolean | null> = {}
        for (const column of columns) {
          const value = row[column.name] ?? (Object.hasOwn(row, column.name) ? null : undefined)
          const resolved =
            value === undefined
              ? column.default.kind === 'literal'
                ? column.default.value
                : column.nullable
                  ? null
                  : undefined
              : typeof value === 'object' && value !== null
                ? value.kind === 'install-time' &&
                  value.codec === 'epochMs' &&
                  column.codec === 'epochMs'
                  ? input.installedAt
                  : undefined
                : value
          if (resolved === undefined || (resolved === null && !column.nullable))
            throw new Error(`RFC-395 missing/invalid seed value: ${table.id}.${column.name}`)
          if (resolved !== null) {
            const type = CODECS[column.codec].dataType
            if (
              (type === 'number' &&
                (typeof resolved !== 'number' || !Number.isSafeInteger(resolved))) ||
              (type === 'boolean' && typeof resolved !== 'boolean') ||
              (type === 'string' && typeof resolved !== 'string') ||
              (column.enumValues && !column.enumValues.includes(String(resolved)))
            )
              throw new Error(`RFC-395 seed codec mismatch: ${table.id}.${column.name}`)
          }
          values[column.name] = resolved
        }
        rows.push({ table: table.id, values })
      }
    }
  return { rows, canonicalJson: canonicalSchemaJson(rows), digest: digestSchemaContract(rows) }
}
export function renderInstallSeedStatements(
  rows: readonly CompiledSeedRow[],
  provider: DatabaseProvider,
): readonly string[] {
  return rows.map((row) => {
    let table: string
    switch (provider) {
      case 'sqlite':
        table = quote(row.table)
        break
      case 'postgresql':
        table = `${quote('agent_workflow')}.${quote(row.table)}`
        break
      default:
        return unhandledDatabaseProvider(provider)
    }
    return `INSERT INTO ${table} (${Object.keys(row.values).map(quote).join(', ')}) VALUES (${Object.values(
      row.values,
    )
      .map((value) => renderSchemaExpression({ kind: 'literal', value }, provider))
      .join(', ')})`
  })
}
