import type { DbClient } from '@/db/client'
import {
  createAgent,
  deleteAgent,
  getAgentById,
  listAgents,
  loadClosureRefNames,
  renameAgent,
  updateAgent,
} from './legacy/agent'
import type { AgentRepository } from '../application/agents/ports'
import type { AgentReferenceLabels } from '../public/types'

/**
 * SQLite compatibility repository for the Agent vertical slice.
 *
 * The active transport no longer consumes the legacy service facade; this
 * infrastructure adapter is the explicit compatibility island while T9 moves
 * the mature prepare/commit corpus behind module-owned persistence ports.
 */
export function createSqliteAgentRepository(db: DbClient): AgentRepository {
  const repository: AgentRepository = {
    list: () => listAgents(db),
    get: (id) => getAgentById(db, id),
    create: (authority, input) =>
      createAgent(db, input, { ownerUserId: authority.user.id, actor: authority }),
    update: (authority, id, patch, fence) => updateAgent(db, id, patch, authority, fence),
    async delete(authority, id, fence): Promise<void> {
      await deleteAgent(db, id, authority, fence)
    },
    rename: (authority, id, rename, fence) =>
      renameAgent(db, id, rename, { actor: authority, ...fence }),
    async referenceLabels(authority, input): Promise<AgentReferenceLabels> {
      const labels = await loadClosureRefNames(
        db,
        authority,
        [...input.agents],
        new Set(input.visibleAgentIds),
      )
      const entries = (values: ReadonlyMap<string, string>) =>
        Object.freeze([...values].map(([id, name]) => Object.freeze({ id, name })))
      return Object.freeze({
        skills: entries(labels.skill),
        mcps: entries(labels.mcp),
        plugins: entries(labels.plugin),
      })
    },
  }
  return Object.freeze(repository)
}
