import type { SchemaRegistry } from '../../schema/registry'

export interface TargetTopology {
  readonly order: readonly string[]
  readonly selfReferences: readonly { readonly table: string; readonly foreignKey: string }[]
  readonly deferredForeignKeys: readonly {
    readonly table: string
    readonly foreignKey: string
    readonly target: string
  }[]
}
/** Cycles are explicitly deferred for V3, never mistaken for an insertable DAG. */
export function targetTopology(registry: SchemaRegistry): TargetTopology {
  const tables = new Map(registry.tables.map((table) => [table.id, table]))
  const remaining = new Set([...tables.keys()].sort())
  const order: string[] = []
  const selfReferences = registry.tables
    .flatMap((table) =>
      table.foreignKeys
        .filter((key) => key.foreignTable === table.id)
        .map((key) => ({ table: table.id, foreignKey: key.name })),
    )
    .sort((a, b) => `${a.table}/${a.foreignKey}`.localeCompare(`${b.table}/${b.foreignKey}`))
  const deferredForeignKeys: { table: string; foreignKey: string; target: string }[] = []
  while (remaining.size) {
    const ready = [...remaining].filter((id) =>
      tables
        .get(id)!
        .foreignKeys.every((key) => key.foreignTable === id || !remaining.has(key.foreignTable)),
    )
    if (!ready.length) {
      const id = [...remaining][0]!
      for (const key of tables.get(id)!.foreignKeys)
        if (key.foreignTable !== id && remaining.has(key.foreignTable))
          deferredForeignKeys.push({ table: id, foreignKey: key.name, target: key.foreignTable })
      ready.push(id)
    }
    for (const id of ready) {
      order.push(id)
      remaining.delete(id)
    }
  }
  return { order, selfReferences, deferredForeignKeys }
}
