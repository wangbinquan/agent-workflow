import type { DbClient } from '@/db/client'
import { agents, mcps, plugins, skills } from '@/db/schema'
import type { AgentResourceInventoryReadPort } from '../application/agents/ports'
import { agentFromPersistenceRow } from './agentPersistence'
import {
  createAgentResourceInventoryReadPort,
  type AgentResourceSkillAvailability,
} from './agentResourceInventory'
import { mcpFromPersistenceRow } from './mcpPersistence'
import { pluginFromPersistenceRow } from './pluginPersistence'
import { skillFromPersistenceRow } from './skillPersistence'

export function createSqliteAgentResourceInventoryReadPort(input: {
  readonly db: DbClient
  readonly skillAvailability: AgentResourceSkillAvailability
}): AgentResourceInventoryReadPort {
  return createAgentResourceInventoryReadPort({
    skillAvailability: input.skillAvailability,
    async loadRows() {
      const [agentRows, skillRows, mcpRows, pluginRows] = await Promise.all([
        input.db.select().from(agents),
        input.db.select().from(skills),
        input.db.select().from(mcps),
        input.db.select().from(plugins),
      ])
      return {
        agents: agentRows.map(agentFromPersistenceRow),
        skills: skillRows.map((row) => ({
          skill: skillFromPersistenceRow(row),
          reservationState: row.reservationState,
          versionState: row.versionState,
        })),
        mcps: mcpRows.map(mcpFromPersistenceRow),
        plugins: pluginRows.map(pluginFromPersistenceRow),
      }
    },
  })
}
