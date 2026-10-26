// RFC-395 I-a: the explicit contract is distinct from the frozen epoch-1 artifact projection.
import { digestSchemaContract } from './canonical'
import { validateSchemaRegistry, type SchemaRegistry } from './registry'
import { resolveColumnUniqueNulls } from './targetDefinition'

export function compileContract(registry: SchemaRegistry) {
  validateSchemaRegistry(registry)
  const payload = {
    contractVersion: 3 as const,
    ...(registry.schemaEpoch && registry.schemaEpoch !== 1
      ? { schemaEpoch: registry.schemaEpoch }
      : {}),
    contributions: registry.contributions.map(
      ({ owner, version, seeds, columnUniqueNulls, indexUniqueNulls }) => ({
        owner,
        version,
        ...(seeds ? { seeds } : {}),
        ...(columnUniqueNulls ? { columnUniqueNulls } : {}),
        ...(indexUniqueNulls ? { indexUniqueNulls } : {}),
      }),
    ),
    tables:
      (registry.schemaEpoch ?? 1) > 1
        ? registry.tables.map((table) => ({
            ...resolveColumnUniqueNulls(registry, table),
            columnOrder: Object.values(table.columns).map((column) => column.name),
          }))
        : registry.tables,
  }
  return Object.freeze({ ...payload, digest: digestSchemaContract(payload) })
}

/** Recover declarations from canonical JSON without reapplying contribution-level NULL rules. */
export function registryFromContract(contract: ReturnType<typeof compileContract>): SchemaRegistry {
  const tables = contract.tables.map((table) => ({
    ...table,
    columns:
      'columnOrder' in table
        ? Object.fromEntries(
            (table.columnOrder as readonly string[]).map(
              (name) => Object.entries(table.columns).find(([, column]) => column.name === name)!,
            ),
          )
        : table.columns,
  }))
  return {
    schemaEpoch: contract.schemaEpoch ?? 1,
    tables,
    contributions: contract.contributions.map((entry) => ({
      ...entry,
      columnUniqueNulls: [],
      tables: tables.filter((table) => table.owner === entry.owner),
    })),
  }
}
