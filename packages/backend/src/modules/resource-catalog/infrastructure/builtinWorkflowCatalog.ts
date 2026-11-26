// RFC-504 (RFC-294 S10 step 11): the built-in workflow catalog (read, content check, system create, broadcast), moved here
// unchanged from composition/builtinWorkflowCatalog.ts; the factory is now createBuiltinWorkflowCatalog (the composition file is
// gone; bootstrap takes it via resource-catalog's composition.ts).
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { broadcastWorkflowCreated, getWorkflow } from './legacy/workflow'
import { runResourceCatalogTransaction } from './resourceCatalogTransaction'
import { createWorkflowMutationParticipant } from './workflowMutationParticipant'
import { workflowDetailOf } from './workflowPersistence'
import {
  canonicalJson,
  migrateWorkflowDefinitionToLatest,
  planCanonicalWorkflowLayout,
  WorkflowDefinitionSchema,
  type CreateWorkflow,
  SYSTEM_USER_ID,
} from '@agent-workflow/shared'

/**
 * Resource Catalog owns built-in workflow persistence and exact-revision collisions. RFC-401 A3: a missing built-in
 * is written by the one workflow mutation participant as a system write (system owner, public, builtin); the
 * catalog keeps its own layout planning and the created broadcast.
 */
export function createBuiltinWorkflowCatalog(db: PersistenceDb) {
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
