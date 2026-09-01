import { buildActor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DbClient } from '@/db/client'
import type { DigitalEmployeeAgentTemplateRepository } from '../application/agents/digitalEmployeeAgentTemplateCatalog'
import { createAgent, getAgentById, renameAgent, updateAgent } from './legacy/agent'

const systemTemplateActor = buildActor({
  user: {
    id: SYSTEM_USER_ID,
    username: SYSTEM_USER_ID,
    displayName: 'System',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
})

/** SQLite compatibility adapter over the module-owned mature Agent writer. */
export function createSqliteDigitalEmployeeAgentTemplateRepository(
  db: DbClient,
): DigitalEmployeeAgentTemplateRepository {
  return Object.freeze({
    get: (id: string) => getAgentById(db, id),

    async createBuiltin(
      input: Parameters<DigitalEmployeeAgentTemplateRepository['createBuiltin']>[0],
    ): Promise<void> {
      await createAgent(db, input.definition, {
        id: input.id,
        ownerUserId: SYSTEM_USER_ID,
        builtin: true,
      })
    },

    async renameBuiltin(
      input: Parameters<DigitalEmployeeAgentTemplateRepository['renameBuiltin']>[0],
    ): Promise<void> {
      await renameAgent(
        db,
        input.id,
        { newName: input.newName },
        {
          actor: systemTemplateActor,
          expectedUpdatedAt: input.expectedUpdatedAt,
          expectedAclRevision: input.expectedAclRevision,
        },
      )
    },

    async updateBuiltin(
      input: Parameters<DigitalEmployeeAgentTemplateRepository['updateBuiltin']>[0],
    ): Promise<void> {
      await updateAgent(db, input.id, input.patch, systemTemplateActor, {
        expectedUpdatedAt: input.expectedUpdatedAt,
        expectedAclRevision: input.expectedAclRevision,
      })
    },
  })
}
