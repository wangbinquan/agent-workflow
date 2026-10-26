import { and, eq, exists, ne, sql, type SQL } from 'drizzle-orm'
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
import { workflowCatalogPredicate } from './workflowCatalogPredicate'

type ReferenceSession = PersistenceDb | PersistenceTx

function agentRelationLookup(
  db: ReferenceSession,
  kind: 'mcp' | 'plugins' | 'skills' | 'dependencies',
) {
  return {
    async find(id: string) {
      const { agents, agentMcpRefs, agentPluginRefs, agentSkillRefs, agentDependencies } =
        tablesOf(db)
      const relation =
        kind === 'mcp'
          ? agentMcpRefs
          : kind === 'plugins'
            ? agentPluginRefs
            : kind === 'skills'
              ? agentSkillRefs
              : agentDependencies
      const target =
        kind === 'mcp'
          ? agentMcpRefs.mcpId
          : kind === 'plugins'
            ? agentPluginRefs.pluginId
            : kind === 'skills'
              ? agentSkillRefs.skillId
              : agentDependencies.dependencyAgentId
      return db
        .select({
          id: agents.id,
          name: agents.name,
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
        })
        .from(agents)
        .where(
          and(
            kind === 'dependencies' ? ne(agents.id, id) : undefined,
            exists(
              db
                .select({ present: sql`1` })
                .from(relation)
                .where(and(eq(relation.agentId, agents.id), eq(target, id))),
            ),
          ),
        )
    },
  }
}
export function createAgentMcpReferenceLookup(db: ReferenceSession): AgentMcpReferenceLookup {
  return agentRelationLookup(db, 'mcp')
}
export function createAgentPluginReferenceLookup(db: ReferenceSession): AgentPluginReferenceLookup {
  return agentRelationLookup(db, 'plugins')
}
export function createAgentSkillReferenceLookup(db: ReferenceSession): AgentSkillReferenceLookup {
  return agentRelationLookup(db, 'skills')
}
export function createAgentDependencyReferenceLookup(
  db: ReferenceSession,
): AgentDependencyReferenceLookup {
  return agentRelationLookup(db, 'dependencies')
}

function indexedWorkflowSelector(
  db: ReferenceSession,
  kind: 'agent' | 'workflow',
  value: string,
): SQL {
  if (value.length === 0) return sql`false`
  const { workflows } = tablesOf(db)
  const { workflowDependencyIndex: index } = tablesOf(db)
  return exists(
    db
      .select({ present: sql`1` })
      .from(index)
      .where(
        and(
          eq(index.workflowId, workflows.id),
          eq(index.revision, workflows.version),
          eq(index.resourceKind, kind),
          eq(index.selectorKind, kind === 'agent' ? 'id' : 'name'),
          eq(index.selectorValue, value),
          // V2 preserves all authored agentId fields; this lookup historically reads agent-single only.
          kind === 'agent'
            ? eq(
                index.namespaceJson,
                JSON.stringify({
                  version: 2,
                  resourceType: 'agent',
                  referenceKind: 'agentId',
                  nodeKind: 'agent-single',
                }),
              )
            : undefined,
        ),
      ),
  )
}
export function createWorkflowAgentReferenceLookup(
  db: ReferenceSession,
): WorkflowAgentReferenceLookup {
  return {
    async find(id) {
      const { workflows } = tablesOf(db)
      return db
        .select({
          id: workflows.id,
          name: workflows.name,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
        })
        .from(workflows)
        .where(workflowCatalogPredicate(workflows.id, indexedWorkflowSelector(db, 'agent', id)))
    },
  }
}
export function createWorkflowCallReferenceLookup(
  db: ReferenceSession,
): WorkflowCallReferenceLookup {
  return {
    async find(input) {
      const { workflows } = tablesOf(db)
      return db
        .select({ id: workflows.id })
        .from(workflows)
        .where(
          workflowCatalogPredicate(
            workflows.id,
            and(ne(workflows.id, input.id), indexedWorkflowSelector(db, 'workflow', input.name)),
          ),
        )
    },
  }
}
