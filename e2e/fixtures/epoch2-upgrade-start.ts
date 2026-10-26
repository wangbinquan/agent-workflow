// Bun child only. Exercise a real next-version boot without rewriting released receipts.
import '../../packages/backend/src/bootstrap/persistenceSchema'
import { restoreArtifactRegistry } from '../../packages/backend/tests/helpers/rfc395V3/successor'
import {
  schemaHistoryRuntime,
  registerSchemaHistoryRuntime,
} from '../../packages/backend/src/platform/persistence/schema/history/runtime'
import { column } from '../../packages/backend/src/platform/persistence/schema/dsl'
import { compileContract } from '../../packages/backend/src/platform/persistence/schema/contract'
import { createHistoryVersion } from '../../packages/backend/src/platform/persistence/schema/history/compiler'
import { deriveSchemaEdge } from '../../packages/backend/src/platform/persistence/schema/history/edgeDiff'

const original = schemaHistoryRuntime()
const previous = original.head()
const baseline = restoreArtifactRegistry(previous)
const tables = baseline.tables.map((table) =>
  table.id === 'tasks'
    ? {
        ...table,
        columns: {
          ...table.columns,
          ops030UpgradeProbe: column.text('ops030_upgrade_probe', { nullable: true }),
        },
      }
    : table,
)
const registry = {
  ...baseline,
  tables,
  contributions: baseline.contributions.map((contribution) => ({
    ...contribution,
    tables: tables.filter((table) => table.owner === contribution.owner),
  })),
}
const successor = createHistoryVersion({
  registry,
  previous,
  edge: deriveSchemaEdge('add-column', previous.contract.contract, compileContract(registry)),
  slug: 'ops030-upgrade',
})
registerSchemaHistoryRuntime({
  ...original,
  head: () => successor,
  history: () => [...(original.history?.() ?? [previous]), successor],
})
await import('../../packages/backend/src/main')
