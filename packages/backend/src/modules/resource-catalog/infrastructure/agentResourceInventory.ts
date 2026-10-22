import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import type { Agent, Mcp, Plugin, Skill } from '@agent-workflow/shared'
import type {
  AgentResourceInventory,
  AgentResourceInventoryReadPort,
  AgentResourceInventorySkill,
} from '../application/agents/ports'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { agentFromPersistenceRow } from './agentPersistence'
import { mcpFromPersistenceRow } from './mcpPersistence'
import { pluginFromPersistenceRow } from './pluginPersistence'
import { skillFromPersistenceRow } from './skillPersistence'

export interface AgentResourceSkillInventoryEntry {
  readonly skill: Skill
  readonly reservationState: string | null
  readonly versionState: string | null
}

export interface AgentResourceInventoryRows {
  readonly agents: readonly Agent[]
  readonly skills: readonly AgentResourceSkillInventoryEntry[]
  readonly mcps: readonly Mcp[]
  readonly plugins: readonly Plugin[]
}

export interface AgentResourceSkillAvailability {
  isAvailable(entry: AgentResourceSkillInventoryEntry): boolean | Promise<boolean>
}

/** Shared row-free assembly for the SQLite and PostgreSQL inventory readers. */
export function createAgentResourceInventoryReadPort(input: {
  readonly loadRows: () => Promise<AgentResourceInventoryRows>
  readonly skillAvailability: AgentResourceSkillAvailability
}): AgentResourceInventoryReadPort {
  return Object.freeze({
    async load(): Promise<AgentResourceInventory> {
      const rows = await input.loadRows()
      const availableSkills = await Promise.all(
        rows.skills.map(async ({ skill, reservationState, versionState }) => {
          const inventory: AgentResourceInventorySkill = {
            id: skill.id,
            name: skill.name,
            ownerUserId: skill.ownerUserId ?? null,
            visibility: skill.visibility ?? 'public',
            reservationState,
            versionState,
            available: await input.skillAvailability.isAvailable({
              skill,
              reservationState,
              versionState,
            }),
          }
          return inventory
        }),
      )
      return {
        agents: new Map(rows.agents.map((agent) => [agent.id, agent])),
        skills: new Map(availableSkills.map((skill) => [skill.id, skill])),
        mcps: new Map(rows.mcps.map((mcp) => [mcp.id, mcp])),
        plugins: new Map(rows.plugins.map((plugin) => [plugin.id, plugin])),
      }
    },
  })
}

/** RFC-359 W4-B2：绑到任一数据库客户端上的库存读取（此前 sqlite / postgresql 两份薄壳只差客户端类型）。 */
export function createDatabaseAgentResourceInventoryReadPort(input: {
  readonly db: PersistenceDb
  readonly skillAvailability: AgentResourceSkillAvailability
}): AgentResourceInventoryReadPort {
  return createAgentResourceInventoryReadPort({
    skillAvailability: input.skillAvailability,
    async loadRows() {
      const { agents, skills, mcps, plugins } = tablesOf(input.db)
      const [agentRows, skillRows, mcpRows, pluginRows] = await Promise.all([
        queryRows(input.db.select().from(agents)),
        queryRows(input.db.select().from(skills)),
        queryRows(input.db.select().from(mcps)),
        queryRows(input.db.select().from(plugins)),
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
