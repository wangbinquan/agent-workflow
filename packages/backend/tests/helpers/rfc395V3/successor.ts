// A restore successor extends the installed binary artifact, independently of live registry WIP.
import { column } from '@/platform/persistence/schema/dsl'
import { compileContract } from '@/platform/persistence/schema/contract'
import { createHistoryVersion } from '@/platform/persistence/schema/history/compiler'
import { deriveSchemaEdge } from '@/platform/persistence/schema/history/edgeDiff'
import type { HistoryVersion } from '@/platform/persistence/schema/history/types'
import type { SchemaRegistry } from '@/platform/persistence/schema/registry'

export function restoreArtifactRegistry(previous: HistoryVersion): SchemaRegistry {
  const contract = previous.contract.contract
  const declaredNulls = new Set(
    contract.contributions.flatMap((c) =>
      (c.columnUniqueNulls ?? []).map((rule) => `${rule.table}.${rule.column}`),
    ),
  )
  const tables = contract.tables.map((table) => {
    const columns = new Map(
      Object.entries(table.columns).map(([key, value]) => [value.name, [key, value] as const]),
    )
    const order =
      'columnOrder' in table ? (table.columnOrder as readonly string[]) : [...columns.keys()]
    return {
      ...table,
      columns: Object.fromEntries(
        order.map((name) => {
          const [key, value] = columns.get(name)!
          if (!declaredNulls.has(`${table.id}.${name}`)) return [key, value]
          const { uniqueNulls: _resolved, ...declared } = value
          return [key, declared]
        }),
      ),
    }
  })
  const registry: SchemaRegistry = {
    schemaEpoch: 2,
    tables,
    contributions: contract.contributions.map((c) => ({
      ...c,
      tables: tables.filter((t) => t.owner === c.owner),
    })),
  }
  if (compileContract(registry).digest !== contract.digest)
    throw new Error('successor-fixture-baseline-mismatch')
  return registry
}

export function createRestoreSuccessor(previous: HistoryVersion, probe: string, slug: string) {
  const registry = restoreArtifactRegistry(previous)
  const contract = previous.contract.contract
  const extended = registry.tables.map((table) =>
    table.id === 'maintenance_state'
      ? {
          ...table,
          columns: { ...table.columns, successorProbe: column.text(probe, { nullable: true }) },
        }
      : table,
  )
  const byId = new Map(extended.map((t) => [t.id, t]))
  const next: SchemaRegistry = {
    ...registry,
    tables: extended,
    contributions: registry.contributions.map((c) => ({
      ...c,
      tables: c.tables.map((t) => byId.get(t.id)!),
    })),
  }
  return createHistoryVersion({
    registry: next,
    previous,
    edge: deriveSchemaEdge('add-column', contract, compileContract(next)),
    slug,
  })
}
