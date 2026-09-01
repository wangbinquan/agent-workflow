import type { Agent, Mcp, Plugin, Skill } from '@agent-workflow/shared'
import type {
  AgentResourceInventory,
  AgentResourceInventoryReadPort,
  AgentResourceInventorySkill,
} from '../application/agents/ports'

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
