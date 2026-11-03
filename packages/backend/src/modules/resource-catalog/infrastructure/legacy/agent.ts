// Resource Catalog SQLite compatibility implementation — reads of the agents table.
// JSON fields (outputs / permission / frontmatterExtra) are stored as
// strings in the DB and (un)marshaled at this boundary. Routes upstream see
// pure JS objects. RFC-401 T6 (proposal G5): the test-only writers (create /
// update / rename) are deleted; every agent row is written by `agentMutationParticipant.ts`.

import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import type { Agent, AgentReferences } from '@agent-workflow/shared'
import { eq, inArray, type SQL } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { filterVisibleRows } from '../../composition/resourceAcl'

import type { Actor } from '@/auth/actor'

import {
  agentFromStoredJsonRow,
  loadAgentPersistenceRow,
  loadAgentPersistenceRows,
  exposedFrontmatterExtra,
} from '../agentPersistence'

export { exposedFrontmatterExtra }

type AgentRow = PersistenceTables['agents']['$inferSelect']

export async function listAgents(db: PersistenceDb): Promise<Agent[]> {
  return loadAgentPersistenceRows(
    db,
    async (tx) => tx.select().from(tablesOf(tx).agents),
    'stored-json',
  )
}

/** Fetch an agent by its canonical resource id. */
export async function getAgentById(db: PersistenceDb, id: string): Promise<Agent | null> {
  return loadAgentPersistenceRow(
    db,
    async (tx) => {
      const { agents } = tablesOf(tx)
      return (await tx.select().from(agents).where(eq(agents.id, id)).limit(1))[0]
    },
    'stored-json',
  )
}

/**
 * RFC-223 (T15) — a Drizzle `WHERE` that resolves a frozen workflow-snapshot
 * agent-single node by canonical id only. `agentName` is display-only; a
 * name-only/corrupt snapshot returns `null` and callers fail closed. The R4-1
 * quarantine sentinel likewise resolves to no row.
 */
export function snapshotNodeAgentWhere(db: object, node: unknown): SQL | null {
  const rec = node as Record<string, unknown>
  const { agents } = tablesOf(db)
  if (typeof rec.agentId === 'string' && rec.agentId.length > 0) return eq(agents.id, rec.agentId)
  return null
}

export function rowToAgent(row: AgentRow, references: AgentReferences): Agent {
  return agentFromStoredJsonRow(row, references)
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC-284 T25（§4，审计 N10）——闭包引用名投影自 routes/agents.ts 下沉：
// 纯读模型（ids → 可见行 display name 映射），路由只剩装配。原文迁入：
// ─────────────────────────────────────────────────────────────────────────────

export interface ClosureRefNameMaps {
  skill: Map<string, string>
  mcp: Map<string, string>
  plugin: Map<string, string>
}

/**
 * RFC-223 (PR-1, Codex impl-gate P2-1): load display NAMES for the managed
 * skill / mcp / plugin IDS referenced anywhere in the closure, so the wire
 * projection shows names, not raw ULIDs. Unresolvable ids (deleted out-of-band)
 * fall back to the id (best-effort, never silently dropped).
 */
export async function loadClosureRefNames(
  db: PersistenceDb,
  actor: Actor,
  closure: Agent[],
  visibleAgentIds: ReadonlySet<string>,
): Promise<ClosureRefNameMaps> {
  const skillIds = new Set<string>()
  const mcpIds = new Set<string>()
  const pluginIds = new Set<string>()
  for (const a of closure) {
    if (!visibleAgentIds.has(a.id)) continue
    for (const ref of a.skills) if (ref.kind === 'managed') skillIds.add(ref.skillId)
    for (const id of a.mcp ?? []) mcpIds.add(id)
    for (const id of a.plugins ?? []) pluginIds.add(id)
  }
  const { skills } = tablesOf(db)
  const { mcps, plugins } = tablesOf(db)
  const [skillRows, mcpRows, pluginRows] = await Promise.all([
    skillIds.size > 0
      ? db
          .select({
            id: skills.id,
            name: skills.name,
            ownerUserId: skills.ownerUserId,
            visibility: skills.visibility,
          })
          .from(skills)
          .where(inArray(skills.id, [...skillIds]))
      : Promise.resolve([]),
    mcpIds.size > 0
      ? db
          .select({
            id: mcps.id,
            name: mcps.name,
            ownerUserId: mcps.ownerUserId,
            visibility: mcps.visibility,
          })
          .from(mcps)
          .where(inArray(mcps.id, [...mcpIds]))
      : Promise.resolve([]),
    pluginIds.size > 0
      ? db
          .select({
            id: plugins.id,
            name: plugins.name,
            ownerUserId: plugins.ownerUserId,
            visibility: plugins.visibility,
          })
          .from(plugins)
          .where(inArray(plugins.id, [...pluginIds]))
      : Promise.resolve([]),
  ])
  const [visibleSkills, visibleMcps, visiblePlugins] = await Promise.all([
    filterVisibleRows(db, actor, 'skill', skillRows),
    filterVisibleRows(db, actor, 'mcp', mcpRows),
    filterVisibleRows(db, actor, 'plugin', pluginRows),
  ])
  return {
    skill: new Map(visibleSkills.map((r) => [r.id, r.name])),
    mcp: new Map(visibleMcps.map((r) => [r.id, r.name])),
    plugin: new Map(visiblePlugins.map((r) => [r.id, r.name])),
  }
}
