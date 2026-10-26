import { sql } from 'drizzle-orm'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
export async function activeGenerationLineage(db: PersistenceDb | PersistenceTx) {
  const table = sql.raw(metaTableName(engineOf(db).provider, 'generations'))
  const rows = await rawRows<Record<string, unknown>>(
    db,
    sql`SELECT * FROM ${table} WHERE state = 'active'`,
  )
  if (rows.length !== 1) throw new Error('epoch2-active-generation-required')
  const active = rows[0]!
  const seen = new Set<string>()
  let source = active
  while (source.role === 'installed' && source.source_generation_id !== null) {
    const id = String(source.source_generation_id)
    if (seen.has(id)) throw new Error('epoch2-generation-lineage-cycle')
    seen.add(id)
    const parents = await rawRows<Record<string, unknown>>(
      db,
      sql`SELECT * FROM ${table} WHERE generation_id = ${id}`,
    )
    if (parents.length !== 1) throw new Error('epoch2-generation-lineage-missing')
    source = parents[0]!
  }
  return { active, source }
}
