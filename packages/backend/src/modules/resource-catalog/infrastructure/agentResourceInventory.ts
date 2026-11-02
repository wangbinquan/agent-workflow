import { skillRowPath } from './databaseSkillTrees'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import type { Agent, Mcp, Plugin, Skill } from '@agent-workflow/shared'
import type {
  AgentResourceInventory,
  AgentResourceInventoryReadPort,
  AgentResourceInventorySkill,
} from '../application/agents/ports'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { loadAgentPersistenceRows } from './agentPersistence'
import { mcpFromPersistenceRow } from './mcpPersistence'
import { pluginFromPersistenceRow } from './pluginPersistence'
import { skillFromPersistenceRow } from './skillPersistence'
import { isSkillAvailableThisBoot } from './legacy/skillBootVerify'

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

async function readAgentResourceInventoryRows(
  tx: PersistenceTx,
): Promise<AgentResourceInventoryRows> {
  const { agents, skills } = tablesOf(tx)
  const { mcps, plugins } = tablesOf(tx)
  const [agentRows, skillRows, mcpRows, pluginRows] = await Promise.all([
    queryRows(tx.select().from(agents)),
    queryRows(tx.select().from(skills)),
    queryRows(tx.select().from(mcps)),
    queryRows(tx.select().from(plugins)),
  ])
  return {
    agents: await loadAgentPersistenceRows(tx, agentRows),
    skills: skillRows.map((row) => ({
      skill: skillFromPersistenceRow({
        ...row,
        managedPath: skillRowPath(row, row.id, 'live'),
      }),
      reservationState: row.reservationState,
      versionState: row.versionState,
    })),
    mcps: mcpRows.map(mcpFromPersistenceRow),
    plugins: pluginRows.map(pluginFromPersistenceRow),
  }
}

/** RFC-359 W4-B2：绑到任一数据库客户端上的库存读取（此前 sqlite / postgresql 两份薄壳只差客户端类型）。 */
export function createDatabaseAgentResourceInventoryReadPort(input: {
  readonly db: PersistenceDb
  readonly skillAvailability: AgentResourceSkillAvailability
}): AgentResourceInventoryReadPort {
  return createAgentResourceInventoryReadPort({
    skillAvailability: input.skillAvailability,
    loadRows: () => databaseSessionFor(input.db).snapshotRead(readAgentResourceInventoryRows),
  })
}

/**
 * RFC-401 A1 —— 写入参与者在调用方事务里读库存：同一事务里先写入的批内资源（Intent / 资源包按引用方向排序）对闭包
 * 校验可见。
 */
export function createTransactionAgentResourceInventoryReadPort(input: {
  readonly transaction: PersistenceTx
  readonly skillAvailability: AgentResourceSkillAvailability
}): AgentResourceInventoryReadPort {
  return createAgentResourceInventoryReadPort({
    skillAvailability: input.skillAvailability,
    loadRows: () => readAgentResourceInventoryRows(input.transaction),
  })
}

/**
 * 本次启动已复核的 managed skill 才可注入（RFC-170）。普通编辑的闭包校验与写入参与者用同一判据；RFC-401 A1 之前它是
 * composition 的私有常量。
 */
export const bootVerifiedSkillAvailability: AgentResourceSkillAvailability = Object.freeze({
  isAvailable(entry: AgentResourceSkillInventoryEntry): boolean {
    return (
      entry.reservationState === 'ready' &&
      isSkillAvailableThisBoot({
        id: entry.skill.id,
        reservationState: entry.reservationState,
        versionState: entry.versionState,
      })
    )
  },
})
