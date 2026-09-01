import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { mcpProbes, mcps } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ValidationError } from '@/util/errors'
import type { McpProbeStore } from '../public/participants'
import type { McpProbeWrite } from '../public/types'
import { mcpProbeFromPersistence, mcpProbePersistenceValues } from './mcpProbePersistence'
import { runPostgresqlResourceCatalogTransaction } from './postgresql/repositorySupport'

export function createPostgresqlMcpProbeStore(db: PostgresqlDatabaseClient): McpProbeStore {
  return Object.freeze({
    async list() {
      const rows = await db
        .select({ probe: mcpProbes, mcpName: mcps.name })
        .from(mcpProbes)
        .innerJoin(mcps, eq(mcpProbes.mcpId, mcps.id))
        .all()
      rows.sort((left, right) => left.mcpName.localeCompare(right.mcpName))
      return Object.freeze(rows.map((row) => mcpProbeFromPersistence(row.probe, row.mcpName)))
    },
    async getByMcpId(mcpId: string) {
      const row = await db
        .select({ probe: mcpProbes, mcpName: mcps.name })
        .from(mcpProbes)
        .innerJoin(mcps, eq(mcpProbes.mcpId, mcps.id))
        .where(eq(mcpProbes.mcpId, mcpId))
        .limit(1)
        .get()
      return row === undefined ? null : mcpProbeFromPersistence(row.probe, row.mcpName)
    },
    async upsert(mcpId: string, measurement: McpProbeWrite) {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const parent = await transaction
          .select({ id: mcps.id })
          .from(mcps)
          .where(eq(mcps.id, mcpId))
          .get()
        if (parent === undefined) {
          throw new ValidationError('mcp-not-found', `mcp id '${mcpId}' not found for probe upsert`)
        }
        const existing = await transaction
          .select({ id: mcpProbes.id })
          .from(mcpProbes)
          .where(eq(mcpProbes.mcpId, mcpId))
          .get()
        const now = Date.now()
        const values = mcpProbePersistenceValues(mcpId, measurement, now)
        if (existing === undefined) {
          await transaction
            .insert(mcpProbes)
            .values({ ...values, id: ulid(), createdAt: now })
            .run()
        } else {
          await transaction.update(mcpProbes).set(values).where(eq(mcpProbes.mcpId, mcpId)).run()
        }
        const after = await transaction
          .select({ probe: mcpProbes, mcpName: mcps.name })
          .from(mcpProbes)
          .innerJoin(mcps, eq(mcpProbes.mcpId, mcps.id))
          .where(eq(mcpProbes.mcpId, mcpId))
          .get()
        if (after === undefined) throw new Error('probe row disappeared after upsert')
        return mcpProbeFromPersistence(after.probe, after.mcpName)
      })
    },
  })
}
