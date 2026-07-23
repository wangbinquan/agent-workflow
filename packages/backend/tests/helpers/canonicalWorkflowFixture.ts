import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { DbClient } from '../../src/db/client'
import { agents } from '../../src/db/schema'

/**
 * Test-fixture equivalent of the normal save/import boundary: freeze every
 * resolvable agent-single display name to its canonical DB id before a task
 * snapshot is inserted directly. Unknown names stay unresolved so negative
 * fail-closed fixtures keep exercising the production guard.
 */
export async function canonicalizeWorkflowAgentIds(
  db: DbClient,
  definition: WorkflowDefinition,
): Promise<WorkflowDefinition> {
  const rows = await db.select({ id: agents.id, name: agents.name }).from(agents)
  const idByName = new Map(rows.map((row) => [row.name, row.id]))
  return {
    ...definition,
    nodes: definition.nodes.map((node) => {
      if (node.kind !== 'agent-single') return node
      const rec = node as WorkflowNode & { agentId?: string; agentName?: string }
      if (typeof rec.agentId === 'string' && rec.agentId.length > 0) return node
      if (typeof rec.agentName !== 'string') return node
      const agentId = idByName.get(rec.agentName)
      return agentId === undefined ? node : ({ ...node, agentId } as WorkflowNode)
    }),
  }
}
