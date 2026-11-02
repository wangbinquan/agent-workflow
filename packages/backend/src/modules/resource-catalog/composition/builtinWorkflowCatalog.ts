import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { broadcastWorkflowCreated, getWorkflow } from '../infrastructure/legacy/workflow'
import { runResourceCatalogTransaction } from '../infrastructure/resourceCatalogTransaction'
import { createWorkflowMutationParticipant } from '../infrastructure/workflowMutationParticipant'
import { workflowDetailOf } from '../infrastructure/workflowPersistence'
import {
  canonicalJson,
  migrateWorkflowDefinitionToLatest,
  planCanonicalWorkflowLayout,
  WorkflowDefinitionSchema,
  type CreateWorkflow,
} from '@agent-workflow/shared'

/**
 * Resource Catalog owns built-in workflow persistence and exact-revision collisions. RFC-401 A3: a missing built-in
 * is written by the one workflow mutation participant as a system write (system owner, public, builtin); the
 * catalog keeps its own layout planning and the created broadcast.
 */
export function composeBuiltinWorkflowCatalog(db: PersistenceDb) {
  return {
    async ensure(id: string, definition: CreateWorkflow) {
      const existing = await getWorkflow(db, id)
      const expected = WorkflowDefinitionSchema.parse(
        planCanonicalWorkflowLayout(definition.definition).next,
      )
      if (existing) {
        if (
          !existing.builtin ||
          existing.ownerUserId !== SYSTEM_USER_ID ||
          existing.name !== definition.name ||
          canonicalJson(existing.definition) !== canonicalJson(expected)
        )
          throw new Error(`builtin-workflow-content-conflict:${id}`)
        return { id: existing.id, revision: existing.version }
      }
      const created = await runResourceCatalogTransaction(db, (transaction) =>
        createWorkflowMutationParticipant(transaction).create(
          { kind: 'system', userId: SYSTEM_USER_ID, reason: 'builtin-workflow' },
          {
            id,
            content: {
              name: definition.name,
              description: definition.description,
              definition: planCanonicalWorkflowLayout(
                migrateWorkflowDefinitionToLatest(definition.definition),
              ).next,
            },
          },
        ),
      )
      broadcastWorkflowCreated(workflowDetailOf(created))
      return { id: created.id, revision: created.version }
    },
  }
}
