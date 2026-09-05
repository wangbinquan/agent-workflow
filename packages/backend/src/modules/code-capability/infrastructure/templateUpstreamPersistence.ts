// RFC-349 — atomic adapter for capability-template upstream sync. RFC-359 W4-B5：一份实现，两个 provider 共用。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { capabilityTemplates } from '@/db/schema'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import type {
  TemplateUpstreamPersistence,
  TemplateUpstreamRecord,
} from '../application/ports/templateUpstreamPersistence'

/** 查询时再取列：表是按 provider 投影的代理，顶层捕获会钉死在加载时的 provider（见 dev-gotchas）。 */
function fields() {
  return {
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
}

export function createTemplateUpstreamPersistence(
  db: ProviderNeutralDatabase,
): TemplateUpstreamPersistence {
  const load = async (
    handle: ProviderNeutralDatabase,
    templateId: string,
  ): Promise<TemplateUpstreamRecord | null> => {
    const [row] = await handle
      .select(fields())
      .from(capabilityTemplates)
      .where(eq(capabilityTemplates.id, templateId))
      .limit(1)
    return row ?? null
  }
  return {
    async load(templateId) {
      return await load(db, templateId)
    },
    async decideAndPersist(templateId, decide) {
      return await databaseSessionFor(db).transaction(async (tx) => {
        // The decision reads and rewrites one local row, and may advance it to
        // an upstream row's exact version. Lock both rows before observing
        // them: a transaction without row locks is still atomic at commit, but
        // under READ COMMITTED it can decide from a pair that another writer
        // changes between the two SELECTs. (SQLite's exclusive transaction has
        // no second writer; the engine capability is a no-op there.)
        const engine = engineOf(tx)
        await engine.lockAggregateRoot(tx, capabilityTemplates, capabilityTemplates.id, templateId)
        const local = await load(tx, templateId)
        if (local === null) return null
        let upstream: TemplateUpstreamRecord | null = null
        if (local.upstreamId !== null) {
          await engine.lockAggregateRoot(
            tx,
            capabilityTemplates,
            capabilityTemplates.id,
            local.upstreamId,
          )
          upstream = await load(tx, local.upstreamId)
        }
        const decision = decide({ local, upstream })
        if (decision.patch !== null) {
          await tx
            .update(capabilityTemplates)
            .set(decision.patch)
            .where(eq(capabilityTemplates.id, templateId))
        }
        return decision.result
      })
    },
  }
}
