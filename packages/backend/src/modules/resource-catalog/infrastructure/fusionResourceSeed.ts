import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { ConflictError } from '@/util/errors'
import type { FusionResourceSeedParticipant } from '../public/participants'
import { createAgentReferenceWriteParticipant } from './agentReferenceWrite'
import { createWorkflowDefinitionWriteParticipant } from './workflowDefinitionWrite'

/** 保持融合原来的逐语句播种顺序；A5 只迁移写入所有权。 */
export function createFusionResourceSeedParticipant(
  db: PersistenceDb,
): FusionResourceSeedParticipant {
  async function seedResources(
    seed: Parameters<FusionResourceSeedParticipant['seed']>[0],
    repairDefinition: Parameters<FusionResourceSeedParticipant['seed']>[1],
  ): Promise<void> {
    const now = Date.now()
    const { agents, workflows } = tablesOf(db)
    const merger = await first(db.select().from(agents).where(eq(agents.id, seed.agent.id)))
    if (merger !== undefined) {
      if (merger.name !== seed.agent.name) {
        throw new ConflictError(
          'builtin-agent-id-collision',
          `stable built-in agent id '${seed.agent.id}' is occupied`,
        )
      }
      const drift =
        merger.ownerUserId !== seed.ownerUserId ||
        merger.visibility !== 'public' ||
        merger.builtin !== true
      if (drift) {
        await db
          .update(agents)
          .set({
            ownerUserId: seed.ownerUserId,
            visibility: 'public',
            builtin: true,
            updatedAt: now,
            aclRevision: merger.aclRevision + 1,
          })
          .where(eq(agents.id, seed.agent.id))
      }
    } else {
      await createAgentReferenceWriteParticipant(db).insert({
        id: seed.agent.id,
        agent: {
          name: seed.agent.name,
          description: seed.agent.description,
          outputs: [...seed.agent.outputs],
          inputs: [],
          syncOutputsOnIterate: seed.agent.syncOutputsOnIterate,
          permission: {},
          skills: [],
          dependsOn: [],
          mcp: [],
          plugins: [],
          frontmatterExtra: {},
          bodyMd: seed.agent.bodyMd,
        },
        ownerUserId: seed.ownerUserId,
        now,
        visibility: 'public',
        builtin: true,
      })
    }

    const workflow = await first(
      db.select().from(workflows).where(eq(workflows.id, seed.workflow.id)),
    )
    if (workflow !== undefined) {
      if (workflow.name !== seed.workflow.name) {
        throw new ConflictError(
          'builtin-workflow-id-collision',
          `stable built-in workflow id '${seed.workflow.id}' is occupied`,
        )
      }
      const repaired = repairDefinition.repair(workflow.definition, seed.workflow.mergerAgentId)
      const drift =
        workflow.ownerUserId !== seed.ownerUserId ||
        workflow.visibility !== 'public' ||
        workflow.builtin !== true
      if (repaired.changed || drift) {
        await createWorkflowDefinitionWriteParticipant(db).update({
          id: seed.workflow.id,
          set: {
            definition: repaired.definition,
            version: workflow.version + 1,
            ownerUserId: seed.ownerUserId,
            visibility: 'public',
            builtin: true,
            ...(drift ? { aclRevision: workflow.aclRevision + 1, updatedAt: now } : {}),
          },
        })
      }
    } else {
      const definition = repairDefinition.repair(
        JSON.stringify(seed.workflow.definition),
        seed.workflow.mergerAgentId,
      ).definition
      await createWorkflowDefinitionWriteParticipant(db).insert({
        id: seed.workflow.id,
        name: seed.workflow.name,
        description: seed.workflow.description,
        definition,
        version: 1,
        ownerUserId: seed.ownerUserId,
        visibility: 'public',
        aclRevision: 0,
        builtin: true,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
    }
  }

  return { seed: seedResources }
}
