import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { eq } from 'drizzle-orm'
import { exposedFrontmatterExtra } from '../agentPersistence'
import { decodeStoredWorkflowDefinition } from '../workflowPersistence'
import type { ExecutionContractResourceLookup } from '../../application/ports/executionContractResourceLookup'

export function createExecutionContractResourceLookup(
  db: PersistenceDb,
): ExecutionContractResourceLookup {
  return {
    async loadAgent(id) {
      const { agents } = tablesOf(db)
      const rows = await db
        .select({
          name: agents.name,
          outputs: agents.outputs,
          updatedAt: agents.updatedAt,
          frontmatterExtra: agents.frontmatterExtra,
        })
        .from(agents)
        .where(eq(agents.id, id))
        .limit(1)
      const row = rows[0]
      if (row === undefined) return null
      return {
        name: row.name,
        outputs: JSON.parse(row.outputs) as string[],
        updatedAt: row.updatedAt,
        frontmatterExtra: exposedFrontmatterExtra(row.frontmatterExtra),
      }
    },
    async loadWorkflow(id) {
      const { workflows } = tablesOf(db)
      const rows = await db
        .select({
          name: workflows.name,
          version: workflows.version,
          definition: workflows.definition,
        })
        .from(workflows)
        .where(eq(workflows.id, id))
        .limit(1)
      const row = rows[0]
      if (row === undefined) return null
      return {
        name: row.name,
        version: row.version,
        definition: decodeStoredWorkflowDefinition(id, row.definition),
      }
    },
  }
}
