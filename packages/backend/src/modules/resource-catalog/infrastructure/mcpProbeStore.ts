// RFC-359 W4-B2 —— MCP 探测记录存储：一份实现，两个 provider 共用。

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { mcpProbes, mcps } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { ValidationError } from '@/util/errors'
import type { McpProbeStore } from '../public/participants'
import type { McpProbeWrite } from '../public/types'
import { mcpProbeFromPersistence, mcpProbePersistenceValues } from './mcpProbePersistence'
import { runResourceCatalogTransaction } from './resourceCatalogTransaction'

export function createMcpProbeStore(db: ProviderNeutralDatabase): McpProbeStore {
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
      return runResourceCatalogTransaction(db, async (transaction) => {
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
