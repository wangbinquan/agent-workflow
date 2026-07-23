import type { Agent, Mcp, Skill } from '@agent-workflow/shared'
import type { DbClient } from '../../src/db/client'
import { listAgents } from '../../src/services/agent'
import { listMcps } from '../../src/services/mcp'
import { listSkills } from '../../src/services/skill'

/**
 * Test-only display-name lookups.
 *
 * Production code must resolve persisted references by canonical id or use an
 * explicitly owner-scoped selector at an import/create boundary. These helpers
 * keep legacy service tests readable without exporting ambiguous global-name
 * resolvers from production modules.
 */
export async function getAgent(db: DbClient, name: string): Promise<Agent | null> {
  return (await listAgents(db)).find((agent) => agent.name === name) ?? null
}

export async function getMcp(db: DbClient, name: string): Promise<Mcp | null> {
  return (await listMcps(db)).find((mcp) => mcp.name === name) ?? null
}

export async function getSkill(db: DbClient, name: string): Promise<Skill | null> {
  return (await listSkills(db)).find((skill) => skill.name === name) ?? null
}
