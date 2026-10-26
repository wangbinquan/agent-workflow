import { asc, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { loadAgentPersistenceRow } from './agentPersistence'
import { workflowCatalogPredicate } from './workflowCatalogPredicate'
import type {
  AgentExecutionQueries,
  WorkflowExecutionQueries,
} from '../application/ports/executionResourceQueries'

function portNames(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (typeof entry === 'string') return [entry]
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { readonly name?: unknown }).name === 'string'
      )
        return [(entry as { readonly name: string }).name]
      return []
    })
  } catch {
    return []
  }
}

export function createAgentExecutionQueries(db: PersistenceDb): AgentExecutionQueries {
  const { agents } = tablesOf(db)
  return {
    async read(agentId) {
      return loadAgentPersistenceRow(
        db,
        async (tx) => (await tx.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0],
        'stored-json',
      )
    },
    async existingIds(agentIds) {
      if (agentIds.length === 0) return []
      return (
        await db
          .select({ id: agents.id })
          .from(agents)
          .where(inArray(agents.id, [...agentIds]))
      ).map((row) => row.id)
    },
    async portNames(agentIds) {
      if (agentIds.length === 0) return new Map()
      const rows = await db
        .select({ id: agents.id, inputs: agents.inputs, outputs: agents.outputs })
        .from(agents)
        .where(inArray(agents.id, [...agentIds]))
      return new Map(
        rows.map((row) => [
          row.id,
          { inputs: portNames(row.inputs), outputs: portNames(row.outputs) },
        ]),
      )
    },
  }
}

export function createWorkflowExecutionQueries(db: PersistenceDb): WorkflowExecutionQueries {
  const { workflows } = tablesOf(db)
  const summary = {
    id: workflows.id,
    name: workflows.name,
    version: workflows.version,
    builtin: workflows.builtin,
    ownerUserId: workflows.ownerUserId,
    visibility: workflows.visibility,
  }
  return {
    async summaries(ids) {
      if (ids.length === 0) return []
      return db
        .select(summary)
        .from(workflows)
        .where(inArray(workflows.id, [...ids]))
    },
    async documents(ids, catalogOnly = false) {
      if (ids.length === 0) return []
      const condition = inArray(workflows.id, [...ids])
      return db
        .select({ ...summary, definition: workflows.definition })
        .from(workflows)
        .where(catalogOnly ? workflowCatalogPredicate(workflows.id, condition) : condition)
    },
    async namedDocuments(names) {
      if (names.length === 0) return []
      return db
        .select({ ...summary, definition: workflows.definition })
        .from(workflows)
        .where(workflowCatalogPredicate(workflows.id, inArray(workflows.name, [...names])))
        .orderBy(asc(workflows.id))
    },
  }
}

/** 列表页同语句投影：只提供名称查询，不暴露表或列对象。 */
export function workflowNameExpression(
  db: PersistenceDb,
  workflowId: SQLWrapper,
): SQL<string | null> {
  const { workflows } = tablesOf(db)
  return sql<
    string | null
  >`(SELECT ${workflows.name} FROM ${workflows} WHERE ${workflowCatalogPredicate(workflows.id, eq(workflows.id, workflowId))})`
}
