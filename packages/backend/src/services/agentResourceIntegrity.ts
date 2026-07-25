// RFC-228 — one authority for the resources required by an Agent closure.
//
// Stable ids remain the persisted identity. This module answers a different
// question: do those ids still resolve to resources that may be injected?
// Every save/launch/runtime boundary consumes the same deterministic issue set
// so a workgroup cannot be more permissive than a workflow (or vice versa).

import type { Agent, Skill } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { mcps as mcpsTable, plugins as pluginsTable, skills as skillsTable } from '@/db/schema'
import { filterVisibleRows } from '@/services/resourceAcl'
import { isSkillAvailableThisBoot } from '@/services/skillBootVerify'
import { ValidationError } from '@/util/errors'

export type AgentResourceRefKind = 'skill' | 'mcp' | 'plugin' | 'agent'

export type AgentResourceIssueCode =
  | 'agent-dependency-not-found'
  | 'agent-dependency-cycle'
  | 'skill-not-found'
  | 'skill-unavailable'
  | 'mcp-not-found'
  | 'plugin-not-found'
  | 'plugin-disabled'

export interface AgentResourceIntegrityIssue {
  code: AgentResourceIssueCode
  rootAgentId: string
  ownerAgentId: string
  refKind: AgentResourceRefKind
  refId: string
  dependencyPath: string[]
}

export interface InventorySkill {
  id: string
  name: string
  ownerUserId: string | null
  visibility: 'public' | 'private'
  reservationState: string | null
  versionState: string | null
  available: boolean
}

export interface InventoryMcp {
  id: string
  name: string
  enabled: boolean
  ownerUserId?: string | null
  visibility?: 'public' | 'private'
}

export interface InventoryPlugin {
  id: string
  name: string
  enabled: boolean
  ownerUserId?: string | null
  visibility?: 'public' | 'private'
}

export interface AgentResourceInventory {
  agents: Map<string, Agent>
  skills: Map<string, InventorySkill>
  mcps: Map<string, InventoryMcp>
  plugins: Map<string, InventoryPlugin>
}

/** Build the pure-validator view from already-loaded public inventories. */
export function buildAgentResourceInventory(input: {
  agents: readonly Agent[]
  skills: readonly Skill[]
  mcps: readonly InventoryMcp[]
  plugins: readonly InventoryPlugin[]
}): AgentResourceInventory {
  return {
    agents: new Map(input.agents.map((agent) => [agent.id, agent])),
    skills: new Map(
      input.skills.map((skill) => [
        skill.id,
        {
          id: skill.id,
          name: skill.name,
          ownerUserId: skill.ownerUserId ?? null,
          visibility: skill.visibility ?? 'public',
          reservationState: 'ready',
          versionState: 'snapshot-authoritative',
          available: true,
        },
      ]),
    ),
    mcps: new Map(input.mcps.map((mcp) => [mcp.id, mcp])),
    plugins: new Map(input.plugins.map((plugin) => [plugin.id, plugin])),
  }
}

export interface AgentResourceIntegrityResult {
  ok: boolean
  issues: AgentResourceIntegrityIssue[]
}

export type AgentResourceDisplayState = 'available' | 'hidden' | 'missing' | 'unavailable'

export interface AgentResourceDisplayRef {
  kind: AgentResourceRefKind
  refId: string
  name: string | null
  state: AgentResourceDisplayState
}

export interface AgentResourceDisplayIssue {
  code: AgentResourceIssueCode
  refKind: AgentResourceRefKind
  state: AgentResourceDisplayState
  refId: string | null
  refName: string | null
  ownerAgentId: string | null
  ownerAgentName: string | null
  direct: boolean
}

export interface AgentResourceStatus {
  ok: boolean
  references: AgentResourceDisplayRef[]
  issues: AgentResourceDisplayIssue[]
}

/**
 * Load the complete (not ACL-filtered) inventory. Dynamic service imports
 * avoid the agent.ts -> integrity.ts -> agent.ts initialization cycle.
 */
export async function loadAgentResourceInventory(db: DbClient): Promise<AgentResourceInventory> {
  const [{ listAgents }, skillRows, mcpRows, pluginRows] = await Promise.all([
    import('@/services/agent'),
    db
      .select({
        id: skillsTable.id,
        name: skillsTable.name,
        ownerUserId: skillsTable.ownerUserId,
        visibility: skillsTable.visibility,
        reservationState: skillsTable.reservationState,
        versionState: skillsTable.versionState,
      })
      .from(skillsTable),
    db
      .select({
        id: mcpsTable.id,
        name: mcpsTable.name,
        enabled: mcpsTable.enabled,
        ownerUserId: mcpsTable.ownerUserId,
        visibility: mcpsTable.visibility,
      })
      .from(mcpsTable),
    db
      .select({
        id: pluginsTable.id,
        name: pluginsTable.name,
        enabled: pluginsTable.enabled,
        ownerUserId: pluginsTable.ownerUserId,
        visibility: pluginsTable.visibility,
      })
      .from(pluginsTable),
  ])
  const agents = await listAgents(db)
  const skills = skillRows.map((row) => ({
    ...row,
    available:
      row.reservationState === 'ready' &&
      isSkillAvailableThisBoot({
        id: row.id,
        reservationState: row.reservationState,
        versionState: row.versionState,
      }),
  }))
  return {
    agents: new Map(agents.map((agent) => [agent.id, agent])),
    skills: new Map(skills.map((skill) => [skill.id, skill])),
    mcps: new Map(mcpRows.map((mcp) => [mcp.id, mcp])),
    plugins: new Map(pluginRows.map((plugin) => [plugin.id, plugin])),
  }
}

export function withAgentResourceOverrides(
  inventory: AgentResourceInventory,
  overrides: readonly Agent[],
): AgentResourceInventory {
  const agents = new Map(inventory.agents)
  for (const agent of overrides) agents.set(agent.id, agent)
  return { ...inventory, agents }
}

/** Pure deterministic closure evaluation; safe for workflow validation/tests. */
export function evaluateAgentResourceIntegrity(
  inventory: AgentResourceInventory,
  rootAgentIds: Iterable<string>,
): AgentResourceIntegrityResult {
  const issues: AgentResourceIntegrityIssue[] = []
  const issueKeys = new Set<string>()

  const add = (issue: AgentResourceIntegrityIssue): void => {
    const key = [
      issue.rootAgentId,
      issue.ownerAgentId,
      issue.refKind,
      issue.refId,
      issue.code,
    ].join('\u0000')
    if (issueKeys.has(key)) return
    issueKeys.add(key)
    issues.push(issue)
  }

  const roots = [...new Set(rootAgentIds)].filter((id) => id.length > 0).sort()
  for (const rootAgentId of roots) {
    const root = inventory.agents.get(rootAgentId)
    if (root === undefined) {
      add({
        code: 'agent-dependency-not-found',
        rootAgentId,
        ownerAgentId: rootAgentId,
        refKind: 'agent',
        refId: rootAgentId,
        dependencyPath: [rootAgentId],
      })
      continue
    }

    const visited = new Set<string>()
    const walk = (agent: Agent, path: string[], active: ReadonlySet<string>): void => {
      if (visited.has(agent.id)) return
      visited.add(agent.id)

      for (const ref of agent.skills) {
        if (ref.kind !== 'managed') continue
        const skill = inventory.skills.get(ref.skillId)
        if (skill === undefined) {
          add({
            code: 'skill-not-found',
            rootAgentId,
            ownerAgentId: agent.id,
            refKind: 'skill',
            refId: ref.skillId,
            dependencyPath: path,
          })
        } else if (!skill.available) {
          add({
            code: 'skill-unavailable',
            rootAgentId,
            ownerAgentId: agent.id,
            refKind: 'skill',
            refId: ref.skillId,
            dependencyPath: path,
          })
        }
      }

      for (const refId of agent.mcp ?? []) {
        const mcp = inventory.mcps.get(refId)
        if (mcp === undefined) {
          add({
            code: 'mcp-not-found',
            rootAgentId,
            ownerAgentId: agent.id,
            refKind: 'mcp',
            refId,
            dependencyPath: path,
          })
        }
      }

      for (const refId of agent.plugins ?? []) {
        const plugin = inventory.plugins.get(refId)
        if (plugin === undefined) {
          add({
            code: 'plugin-not-found',
            rootAgentId,
            ownerAgentId: agent.id,
            refKind: 'plugin',
            refId,
            dependencyPath: path,
          })
        } else if (!plugin.enabled) {
          add({
            code: 'plugin-disabled',
            rootAgentId,
            ownerAgentId: agent.id,
            refKind: 'plugin',
            refId,
            dependencyPath: path,
          })
        }
      }

      const nextActive = new Set(active)
      nextActive.add(agent.id)
      for (const dependencyId of agent.dependsOn ?? []) {
        if (nextActive.has(dependencyId)) {
          add({
            code: 'agent-dependency-cycle',
            rootAgentId,
            ownerAgentId: agent.id,
            refKind: 'agent',
            refId: dependencyId,
            dependencyPath: [...path, dependencyId],
          })
          continue
        }
        const dependency = inventory.agents.get(dependencyId)
        if (dependency === undefined) {
          add({
            code: 'agent-dependency-not-found',
            rootAgentId,
            ownerAgentId: agent.id,
            refKind: 'agent',
            refId: dependencyId,
            dependencyPath: path,
          })
          continue
        }
        walk(dependency, [...path, dependencyId], nextActive)
      }
    }

    walk(root, [root.id], new Set())
  }

  issues.sort((a, b) => {
    const ak = [
      a.rootAgentId,
      a.dependencyPath.join('/'),
      a.ownerAgentId,
      a.refKind,
      a.refId,
      a.code,
    ].join('\u0000')
    const bk = [
      b.rootAgentId,
      b.dependencyPath.join('/'),
      b.ownerAgentId,
      b.refKind,
      b.refId,
      b.code,
    ].join('\u0000')
    return ak.localeCompare(bk)
  })
  return { ok: issues.length === 0, issues }
}

export async function assertAgentResourceIntegrity(
  db: DbClient,
  rootAgentIds: Iterable<string>,
  opts: { inventory?: AgentResourceInventory; overrides?: readonly Agent[] } = {},
): Promise<void> {
  let inventory = opts.inventory ?? (await loadAgentResourceInventory(db))
  if (opts.overrides !== undefined) {
    inventory = withAgentResourceOverrides(inventory, opts.overrides)
  }
  const result = evaluateAgentResourceIntegrity(inventory, rootAgentIds)
  if (result.ok) return
  // Do not put referenced ids/names from an ACL-implicit closure on a public
  // error. The detail/status endpoints provide an actor-safe projection.
  throw new ValidationError(
    'agent-resources-invalid',
    `agent resource closure is invalid (${result.issues.length} issue${result.issues.length === 1 ? '' : 's'})`,
    {
      issues: result.issues.map((issue) => ({
        code: issue.code,
        refKind: issue.refKind,
        rootAgentId: issue.rootAgentId,
        direct: issue.ownerAgentId === issue.rootAgentId,
      })),
    },
  )
}

/** Actor-safe detail projection used by the Agent editor. */
export async function getAgentResourceStatus(
  db: DbClient,
  actor: Actor,
  root: Agent,
): Promise<AgentResourceStatus> {
  const inventory = await loadAgentResourceInventory(db)
  const result = evaluateAgentResourceIntegrity(inventory, [root.id])
  const closureAgentIds = new Set<string>()
  const pendingAgentIds = [root.id]
  while (pendingAgentIds.length > 0) {
    const agentId = pendingAgentIds.shift()
    if (agentId === undefined || closureAgentIds.has(agentId)) continue
    closureAgentIds.add(agentId)
    const agent = inventory.agents.get(agentId)
    if (agent === undefined) continue
    for (const dependencyId of agent.dependsOn ?? []) {
      if (!closureAgentIds.has(dependencyId)) pendingAgentIds.push(dependencyId)
    }
  }
  const closureAgents = [...closureAgentIds]
    .map((id) => inventory.agents.get(id))
    .filter((agent): agent is Agent => agent !== undefined)
  const visibleAgents = await filterVisibleRows(db, actor, 'agent', closureAgents)
  const visibleAgentIds = new Set(visibleAgents.map((agent) => agent.id))

  const directSkillIds = root.skills.flatMap((ref) => (ref.kind === 'managed' ? [ref.skillId] : []))
  const closureSkillIds = [
    ...new Set(
      closureAgents.flatMap((agent) =>
        agent.skills.flatMap((ref) => (ref.kind === 'managed' ? [ref.skillId] : [])),
      ),
    ),
  ]
  const closureMcpIds = [...new Set(closureAgents.flatMap((agent) => agent.mcp ?? []))]
  const closurePluginIds = [...new Set(closureAgents.flatMap((agent) => agent.plugins ?? []))]
  const closureSkills = closureSkillIds
    .map((id) => inventory.skills.get(id))
    .filter((row): row is InventorySkill => row !== undefined)
  const closureMcps = closureMcpIds
    .map((id) => inventory.mcps.get(id))
    .filter((row): row is InventoryMcp => row !== undefined)
  const closurePlugins = closurePluginIds
    .map((id) => inventory.plugins.get(id))
    .filter((row): row is InventoryPlugin => row !== undefined)

  const [visibleSkills, visibleMcps, visiblePlugins] = await Promise.all([
    filterVisibleRows(db, actor, 'skill', closureSkills),
    filterVisibleRows(db, actor, 'mcp', closureMcps),
    filterVisibleRows(db, actor, 'plugin', closurePlugins),
  ])
  const visibleSkillIds = new Set(visibleSkills.map((row) => row.id))
  const visibleMcpIds = new Set(visibleMcps.map((row) => row.id))
  const visiblePluginIds = new Set(visiblePlugins.map((row) => row.id))

  const references: AgentResourceDisplayRef[] = []
  for (const refId of directSkillIds) {
    const row = inventory.skills.get(refId)
    references.push(
      displayRef('skill', refId, row, row?.available === true, visibleSkillIds.has(refId)),
    )
  }
  for (const refId of root.mcp ?? []) {
    const row = inventory.mcps.get(refId)
    references.push(displayRef('mcp', refId, row, row !== undefined, visibleMcpIds.has(refId)))
  }
  for (const refId of root.plugins ?? []) {
    const row = inventory.plugins.get(refId)
    references.push(
      displayRef('plugin', refId, row, row?.enabled === true, visiblePluginIds.has(refId)),
    )
  }
  for (const refId of root.dependsOn ?? []) {
    const row = inventory.agents.get(refId)
    references.push(displayRef('agent', refId, row, true, visibleAgentIds.has(refId)))
  }

  const issues: AgentResourceDisplayIssue[] = result.issues.map((issue) => {
    const ownerVisible = visibleAgentIds.has(issue.ownerAgentId)
    const refRow =
      issue.refKind === 'skill'
        ? inventory.skills.get(issue.refId)
        : issue.refKind === 'mcp'
          ? inventory.mcps.get(issue.refId)
          : issue.refKind === 'plugin'
            ? inventory.plugins.get(issue.refId)
            : inventory.agents.get(issue.refId)
    const refVisible =
      issue.refKind === 'skill'
        ? visibleSkillIds.has(issue.refId)
        : issue.refKind === 'mcp'
          ? visibleMcpIds.has(issue.refId)
          : issue.refKind === 'plugin'
            ? visiblePluginIds.has(issue.refId)
            : visibleAgentIds.has(issue.refId)
    const state: AgentResourceDisplayState =
      refRow === undefined
        ? 'missing'
        : !refVisible
          ? 'hidden'
          : issue.code === 'skill-unavailable' || issue.code === 'plugin-disabled'
            ? 'unavailable'
            : 'available'
    return {
      code: issue.code,
      refKind: issue.refKind,
      state,
      refId: ownerVisible && refVisible ? issue.refId : null,
      refName: ownerVisible && refVisible ? (refRow?.name ?? null) : null,
      ownerAgentId: ownerVisible ? issue.ownerAgentId : null,
      ownerAgentName: ownerVisible
        ? (inventory.agents.get(issue.ownerAgentId)?.name ?? null)
        : null,
      direct: issue.ownerAgentId === root.id,
    }
  })
  return { ok: result.ok, references, issues }
}

function displayRef(
  kind: AgentResourceRefKind,
  refId: string,
  row: { name: string } | undefined,
  available: boolean,
  visible: boolean,
): AgentResourceDisplayRef {
  if (row === undefined) return { kind, refId, name: null, state: 'missing' }
  if (!visible) return { kind, refId, name: null, state: 'hidden' }
  return {
    kind,
    refId,
    name: row.name,
    state: available ? 'available' : 'unavailable',
  }
}
