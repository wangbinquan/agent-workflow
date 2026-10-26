// RFC-395 I-b: bootstrap builds the two immutable native table sets from the same contributions.
import type { DatabaseProvider } from '../databaseProviders'
import type { SchemaRegistry } from './registry'
import {
  materializeDrizzle,
  type MaterializedTable,
  type MaterializedPostgresqlTable,
} from './drizzle'
import type { TableDefinition } from './contribution'
import { resolveColumnUniqueNulls } from './targetDefinition'

type NativeSet<T extends readonly TableDefinition[], P extends DatabaseProvider> = {
  readonly [D in T[number] as D['schemaSymbol']]: P extends 'sqlite'
    ? MaterializedTable<D>
    : MaterializedPostgresqlTable<D>
}

export function materializeTableSets<const R extends SchemaRegistry>(
  registry: R,
): {
  readonly sqlite: NativeSet<R['tables'], 'sqlite'>
  readonly postgresql: NativeSet<R['tables'], 'postgresql'>
} {
  const entries = registry.tables.map((definition) => ({
    definition,
    native: materializeDrizzle(resolveColumnUniqueNulls(registry, definition), {
      schemaEpoch: registry.schemaEpoch,
    }),
  }))
  return Object.freeze({
    sqlite: Object.freeze(
      Object.fromEntries(
        entries.map(({ definition, native }) => [definition.schemaSymbol, native.sqlite]),
      ),
    ),
    postgresql: Object.freeze(
      Object.fromEntries(
        entries.map(({ definition, native }) => [definition.schemaSymbol, native.postgresql]),
      ),
    ),
  }) as {
    readonly sqlite: NativeSet<R['tables'], 'sqlite'>
    readonly postgresql: NativeSet<R['tables'], 'postgresql'>
  }
}
