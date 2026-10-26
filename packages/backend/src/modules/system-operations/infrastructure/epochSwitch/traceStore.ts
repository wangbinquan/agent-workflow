import type { ConversionTargetConnection } from '@/platform/persistence/migration/run/types'
import type { SchemaRegistry } from '@/platform/persistence/schema/registry'
import type { MigrationMetaReadPort } from '../../application/ports/epochSwitch'
import { createMigrationMetaStore } from './metaStore'

/** Expose only reads to trace; transaction and receipt writers remain in infrastructure. */
export function createMigrationTraceStore(input: {
  target: ConversionTargetConnection
  registry: SchemaRegistry
}): MigrationMetaReadPort {
  const meta = createMigrationMetaStore(input)
  return {
    migrationRun: meta.migrationRun,
    approvals: meta.approvals,
    runs: meta.runs,
    units: meta.units,
    unitSources: meta.unitSources,
    tableReceipts: meta.tableReceipts,
    dispositions: meta.dispositions,
    artifacts: meta.artifacts,
    restrictions: meta.restrictions,
    blocks: meta.blocks,
    records: meta.records,
    identityHighWater: meta.identityHighWater,
    archive: meta.archive,
    probeTarget: meta.probeTarget,
    receiptExport: meta.receiptExport,
  }
}
