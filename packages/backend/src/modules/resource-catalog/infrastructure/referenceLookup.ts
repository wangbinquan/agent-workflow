import { like } from 'drizzle-orm'
import {
  decodeWorkflowReferenceDocument,
  collectWorkflowDependencyRefs,
  collectWorkflowCallRefs,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type {
  AgentMcpReferenceLookup,
  AgentPluginReferenceLookup,
  AgentSkillReferenceLookup,
  AgentDependencyReferenceLookup,
  WorkflowAgentReferenceLookup,
  WorkflowCallReferenceLookup,
} from '../application/ports/referenceLookup'
import { matchesStoredAgentReference } from './agentReferenceCodec'
import { workflowCatalogPredicate } from './workflowCatalogPredicate'

type ReferenceSession = PersistenceDb | PersistenceTx

/** II-a 保留 LIKE 粗筛的转义/通配符行为，再做原来的 JSON 精确匹配。 */
function agentJsonLookup(db: ReferenceSession, kind: 'mcp' | 'plugins' | 'skills') {
  return {
    async find(id: string) {
      const { agents } = tablesOf(db)
      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          raw: agents[kind],
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
        })
        .from(agents)
        .where(like(agents[kind], `%"${id}"%`))
      return rows
        .filter((row) =>
          matchesStoredAgentReference(row.raw, id, kind === 'skills' ? 'skill' : 'id'),
        )
        .map(({ raw: _raw, ...row }) => row)
    },
  }
}

export function createAgentMcpReferenceLookup(db: ReferenceSession): AgentMcpReferenceLookup {
  return agentJsonLookup(db, 'mcp')
}
export function createAgentPluginReferenceLookup(db: ReferenceSession): AgentPluginReferenceLookup {
  return agentJsonLookup(db, 'plugins')
}
export function createAgentSkillReferenceLookup(db: ReferenceSession): AgentSkillReferenceLookup {
  return agentJsonLookup(db, 'skills')
}

export function createAgentDependencyReferenceLookup(
  db: ReferenceSession,
): AgentDependencyReferenceLookup {
  return {
    async find(id) {
      const { agents } = tablesOf(db)
      const rows = await db
        .select({
          id: agents.id,
          name: agents.name,
          raw: agents.dependsOn,
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
        })
        .from(agents)
      return rows
        .filter((row) => row.id !== id && matchesStoredAgentReference(row.raw, id, 'id'))
        .map(({ raw: _raw, ...row }) => row)
    },
  }
}

export function createWorkflowAgentReferenceLookup(
  db: ReferenceSession,
): WorkflowAgentReferenceLookup {
  return {
    async find(id) {
      const { workflows } = tablesOf(db)
      const rows = await db
        .select({
          id: workflows.id,
          name: workflows.name,
          definition: workflows.definition,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
        })
        .from(workflows)
        .where(workflowCatalogPredicate(workflows.id))
      return rows
        .filter((row) => {
          try {
            const decoded = decodeWorkflowReferenceDocument(row.definition)
            return collectWorkflowDependencyRefs(decoded ?? {}).some(
              (ref) => ref.resourceType === 'agent' && ref.value === id,
            )
          } catch {
            return false
          }
        })
        .map(({ definition: _definition, ...row }) => row)
    },
  }
}

export function createWorkflowCallReferenceLookup(
  db: ReferenceSession,
): WorkflowCallReferenceLookup {
  return {
    async find(input) {
      const { workflows } = tablesOf(db)
      const rows = await db
        .select({ id: workflows.id, definition: workflows.definition })
        .from(workflows)
        .where(workflowCatalogPredicate(workflows.id))
      return rows
        .filter((row) => {
          if (row.id === input.id) return false
          try {
            const parsed = decodeWorkflowReferenceDocument(row.definition)
            return (
              parsed !== undefined &&
              collectWorkflowCallRefs(parsed as WorkflowDefinition).some(
                (ref) => ref.workflowName === input.name,
              )
            )
          } catch {
            return false
          }
        })
        .map(({ id }) => ({ id }))
    },
  }
}
