import { activeGenerationLineage } from './generationLineage'
import { sql } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { digestSchemaContract } from '@/platform/persistence/schema/canonical'
import type { LogicalSchemaContract } from '@/platform/persistence/schema/contractTypes'

export async function readActiveEpochInstallation(db: PersistenceDb) {
  const provider = engineOf(db).provider
  const { active, source: row } = await activeGenerationLineage(db)
  if (Number(row.schema_epoch) !== 2 || row.activated_at === null)
    throw new Error('epoch2-installation-not-activated')
  const writer = {
    activeGeneration: Number(row.schema_epoch),
    updatedAt: Number(active.activated_at),
  }
  if (row.role === 'installed')
    return {
      writer,
      generationId: String(active.generation_id),
      history: { kind: 'fresh-install' as const },
    }
  const runs = sql.raw(metaTableName(provider, 'migration_runs'))
  const records = await rawRows<Record<string, unknown>>(
    db,
    sql`SELECT binding_json, binding_digest FROM ${runs} WHERE run_id = ${String(row.run_id)} AND target_generation_id = ${String(row.generation_id)}`,
  )
  if (records.length !== 1) throw new Error('epoch2-installation-run-missing')
  const binding = JSON.parse(String(records[0]!.binding_json)) as {
    sourceContract?: LogicalSchemaContract
    sourceGenerationId: string
  }
  if (
    digestSchemaContract(binding) !== records[0]!.binding_digest ||
    binding.sourceGenerationId !== row.source_generation_id
  )
    throw new Error('epoch2-installation-binding-mismatch')
  if (!binding.sourceContract) throw new Error('epoch2-history-source-contract-missing')
  const { digest, ...contract } = binding.sourceContract
  if (digestSchemaContract(contract) !== digest)
    throw new Error('epoch2-history-source-contract-mismatch')
  return {
    writer,
    generationId: String(active.generation_id),
    history: {
      kind: 'converted' as const,
      source: { sourceGeneration: binding.sourceGenerationId, contract: binding.sourceContract },
    },
  }
}
