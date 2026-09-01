// RFC-349 — SQLite atomic adapter for capability-template upstream sync.

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { capabilityTemplates } from '@/db/schema'
import type {
  TemplateUpstreamPersistence,
  TemplateUpstreamRecord,
} from '../application/ports/templateUpstreamPersistence'

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

function loadInTx(tx: DbTxSync, templateId: string): TemplateUpstreamRecord | null {
  return (
    tx
      .select(fields)
      .from(capabilityTemplates)
      .where(eq(capabilityTemplates.id, templateId))
      .get() ?? null
  )
}

export function createSqliteTemplateUpstreamPersistence(db: DbClient): TemplateUpstreamPersistence {
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
      return dbTxSync(db, (tx) => {
        const local = loadInTx(tx, templateId)
        if (local === null) return null
        const upstream = local.upstreamId === null ? null : loadInTx(tx, local.upstreamId)
        const decision = decide({ local, upstream })
        if (decision.patch !== null) {
          tx.update(capabilityTemplates)
            .set(decision.patch)
            .where(eq(capabilityTemplates.id, templateId))
            .run()
        }
        return decision.result
      })
    },
  }
}
