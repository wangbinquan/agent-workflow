import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { createWorkflow, getWorkflow } from '../infrastructure/legacy/workflow'
import {
  canonicalJson,
  planCanonicalWorkflowLayout,
  WorkflowDefinitionSchema,
  type CreateWorkflow,
} from '@agent-workflow/shared'

/** Resource Catalog owns built-in workflow persistence and exact-revision collisions. */
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
      const created = await createWorkflow(db, definition, {
        id,
        builtin: true,
        ownerUserId: SYSTEM_USER_ID,
        visibility: 'public',
      })
      return { id: created.id, revision: created.version }
    },
  }
}
