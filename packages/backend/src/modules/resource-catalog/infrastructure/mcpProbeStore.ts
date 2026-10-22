// RFC-359 W4-B2 —— MCP 探测记录存储：一份实现，两个 provider 共用。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { ValidationError } from '@/util/errors'
import type { McpProbeStore } from '../public/participants'
import type { McpProbeWrite } from '../public/types'
import { mcpProbeFromPersistence, mcpProbePersistenceValues } from './mcpProbePersistence'
import { runResourceCatalogTransaction } from './resourceCatalogTransaction'

export function createMcpProbeStore(db: PersistenceDb): McpProbeStore {
  return Object.freeze({
    async list() {
      const { mcpProbes, mcps } = tablesOf(db)
      const rows = await db
        .select({ probe: mcpProbes, mcpName: mcps.name })
        .from(mcpProbes)
        .innerJoin(mcps, eq(mcpProbes.mcpId, mcps.id))
      rows.sort((left, right) => left.mcpName.localeCompare(right.mcpName))
      return Object.freeze(rows.map((row) => mcpProbeFromPersistence(row.probe, row.mcpName)))
    },
    async getByMcpId(mcpId: string) {
      const { mcpProbes, mcps } = tablesOf(db)
      const row = await first(
        db
          .select({ probe: mcpProbes, mcpName: mcps.name })
          .from(mcpProbes)
          .innerJoin(mcps, eq(mcpProbes.mcpId, mcps.id))
          .where(eq(mcpProbes.mcpId, mcpId))
          .limit(1),
      )
      return row === undefined ? null : mcpProbeFromPersistence(row.probe, row.mcpName)
    },
    async upsert(mcpId: string, measurement: McpProbeWrite) {
      return runResourceCatalogTransaction(db, async (transaction) => {
        const { mcps, mcpProbes } = tablesOf(transaction)
        const parent = await first(
          transaction.select({ id: mcps.id }).from(mcps).where(eq(mcps.id, mcpId)),
        )
        if (parent === undefined) {
          throw new ValidationError('mcp-not-found', `mcp id '${mcpId}' not found for probe upsert`)
        }
        const existing = await first(
          transaction
            .select({ id: mcpProbes.id })
            .from(mcpProbes)
            .where(eq(mcpProbes.mcpId, mcpId)),
        )
        const now = Date.now()
        const values = mcpProbePersistenceValues(mcpId, measurement, now)
        if (existing === undefined) {
          await insertOne(transaction, mcpProbes, { ...values, id: ulid(), createdAt: now })
        } else {
          await transaction.update(mcpProbes).set(values).where(eq(mcpProbes.mcpId, mcpId))
        }
        const after = await first(
          transaction
            .select({ probe: mcpProbes, mcpName: mcps.name })
            .from(mcpProbes)
            .innerJoin(mcps, eq(mcpProbes.mcpId, mcps.id))
            .where(eq(mcpProbes.mcpId, mcpId)),
        )
        if (after === undefined) throw new Error('probe row disappeared after upsert')
        return mcpProbeFromPersistence(after.probe, after.mcpName)
      })
    },
  })
}
