// RFC-349 — PostgreSQL atomic adapter for capability-template upstream sync.

import { eq, sql } from 'drizzle-orm'
import { capabilityTemplates } from '@/db/schema'
import type {
  TemplateUpstreamPersistence,
  TemplateUpstreamRecord,
} from '../application/ports/templateUpstreamPersistence'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

const fields = {
  id: capabilityTemplates.id,
  name: capabilityTemplates.name,
  description: capabilityTemplates.description,
  capability: capabilityTemplates.capability,
  scriptsJson: capabilityTemplates.scriptsJson,
  hooksJson: capabilityTemplates.hooksJson,
  paramSchemaJson: capabilityTemplates.paramSchemaJson,
  paramDefaultsJson: capabilityTemplates.paramDefaultsJson,
  agentBySlotJson: capabilityTemplates.agentBySlotJson,
  promptBySlotJson: capabilityTemplates.promptBySlotJson,
  paramsJson: capabilityTemplates.paramsJson,
  stageContractVer: capabilityTemplates.stageContractVer,
  upstreamId: capabilityTemplates.upstreamId,
  upstreamVersion: capabilityTemplates.upstreamVersion,
  baseDigest: capabilityTemplates.baseDigest,
  baseSnapshotJson: capabilityTemplates.baseSnapshotJson,
  updatedAt: capabilityTemplates.updatedAt,
}

export function createPostgresqlTemplateUpstreamPersistence(
  db: PostgresqlDatabaseClient,
): TemplateUpstreamPersistence {
  return {
    async load(templateId) {
      const [row] = await db
        .select(fields)
        .from(capabilityTemplates)
        .where(eq(capabilityTemplates.id, templateId))
        .limit(1)
      return row ?? null
    },
    async decideAndPersist(templateId, decide) {
      return await db.transaction(async (transaction) => {
        // The decision reads and rewrites one local row, and may advance it to
        // an upstream row's exact version. Lock both rows before observing
        // them: a transaction without row locks is still atomic at commit, but
        // under READ COMMITTED it can decide from a pair that another writer
        // changes between the two SELECTs.
        await transaction.run(sql`
          SELECT ${capabilityTemplates.id}
          FROM ${capabilityTemplates}
          WHERE ${capabilityTemplates.id} = ${templateId}
          FOR UPDATE
        `)
        const [local] = await transaction
          .select(fields)
          .from(capabilityTemplates)
          .where(eq(capabilityTemplates.id, templateId))
          .limit(1)
        if (local === undefined) return null
        let upstream: TemplateUpstreamRecord | null = null
        if (local.upstreamId !== null) {
          await transaction.run(sql`
            SELECT ${capabilityTemplates.id}
            FROM ${capabilityTemplates}
            WHERE ${capabilityTemplates.id} = ${local.upstreamId}
            FOR UPDATE
          `)
          upstream =
            (
              await transaction
                .select(fields)
                .from(capabilityTemplates)
                .where(eq(capabilityTemplates.id, local.upstreamId))
                .limit(1)
            )[0] ?? null
        }
        const decision = decide({
          local,
          upstream,
        })
        if (decision.patch !== null) {
          await transaction
            .update(capabilityTemplates)
            .set(decision.patch)
            .where(eq(capabilityTemplates.id, templateId))
        }
        return decision.result
      })
    },
  }
}
