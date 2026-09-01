import { agents, mcps, plugins, skills } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { AgentResourceInventoryReadPort } from '../application/agents/ports'
import { agentFromPersistenceRow } from './agentPersistence'
import {
  createAgentResourceInventoryReadPort,
  type AgentResourceSkillAvailability,
} from './agentResourceInventory'
import { mcpFromPersistenceRow } from './mcpPersistence'
import { pluginFromPersistenceRow } from './pluginPersistence'
import { skillFromPersistenceRow } from './skillPersistence'

export function createPostgresqlAgentResourceInventoryReadPort(input: {
  readonly db: PostgresqlDatabaseClient
  readonly skillAvailability: AgentResourceSkillAvailability
}): AgentResourceInventoryReadPort {
  return createAgentResourceInventoryReadPort({
    skillAvailability: input.skillAvailability,
    async loadRows() {
      const [agentRows, skillRows, mcpRows, pluginRows] = await Promise.all([
        input.db.select().from(agents).all(),
        input.db.select().from(skills).all(),
        input.db.select().from(mcps).all(),
        input.db.select().from(plugins).all(),
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
