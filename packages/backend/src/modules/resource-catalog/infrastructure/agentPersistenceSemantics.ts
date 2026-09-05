import type { Agent, AgentSkillRef, AclResourceType, CreateAgent } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'

import { agents, mcps, plugins, resourceGrants, skills, workflows } from '@/db/schema'
import {
  reconcileCreatedAgentExecutionContractPorts,
  reconcileUpdatedAgentExecutionContractPorts,
} from '@/modules/execution-contract/public/commands'
import type { ProviderNeutralDatabase } from '@/db/query'
import { ConflictError, ValidationError } from '@/util/errors'

import { assertAgentResourceIntegrity } from '../application/agents/agentResourceIntegrity'
import type { AgentResourceInventorySource } from '../application/agents/ports'
import type { ResourceAuthorizationApplication } from '../application/resourceAuthorization'
import { hasResourceAclBypass, isVisibleRow, type AclRow } from '../domain/resourceAccess'
import type { AgentOperationContext } from '../public/participants'
import type { AgentReferenceLabels, AgentReferenceLabelsInput } from '../public/types'
import { extractWorkflowAgentRefs } from './legacy/resourceRefs'
import type { AgentPersistenceSemantics } from './agentRepository'
import type { ResourceCatalogTransaction } from './resourceCatalogTransaction'

interface NamedAclRow extends AclRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function managedSkillIds(refs: readonly AgentSkillRef[]): string[] {
  return unique(refs.flatMap((ref) => (ref.kind === 'managed' ? [ref.skillId] : [])))
}

function assertBranchPortsDeclared(agent: Pick<CreateAgent, 'outputs' | 'branchPorts'>): void {
  if (agent.branchPorts === undefined || agent.branchPorts.length === 0) return
  const outputs = new Set(agent.outputs)
  const missing = agent.branchPorts.filter((port) => !outputs.has(port))
  if (missing.length === 0) return
  throw new ValidationError(
    'branch-port-not-declared',
    `agent branchPorts reference undeclared output port(s): ${missing.join(', ')}`,
    { notFound: missing },
  )
}

async function rowsByIds(
  transaction: ResourceCatalogTransaction,
  type: Extract<AclResourceType, 'agent' | 'skill' | 'mcp' | 'plugin'>,
  ids: readonly string[],
): Promise<readonly NamedAclRow[]> {
  if (ids.length === 0) return []
  switch (type) {
    case 'agent':
      return transaction
        .select({
          id: agents.id,
          name: agents.name,
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
        })
        .from(agents)
        .where(inArray(agents.id, [...ids]))
    case 'skill':
      return transaction
        .select({
          id: skills.id,
          name: skills.name,
          ownerUserId: skills.ownerUserId,
          visibility: skills.visibility,
        })
        .from(skills)
        .where(and(inArray(skills.id, [...ids]), eq(skills.reservationState, 'ready')))
    case 'mcp':
      return transaction
        .select({
          id: mcps.id,
          name: mcps.name,
          ownerUserId: mcps.ownerUserId,
          visibility: mcps.visibility,
        })
        .from(mcps)
        .where(inArray(mcps.id, [...ids]))
    case 'plugin':
      return transaction
        .select({
          id: plugins.id,
          name: plugins.name,
          ownerUserId: plugins.ownerUserId,
          visibility: plugins.visibility,
        })
        .from(plugins)
        .where(and(inArray(plugins.id, [...ids]), eq(plugins.enabled, true)))
  }
}

async function grantedIds(
  transaction: ResourceCatalogTransaction,
  authority: AgentOperationContext,
  type: Extract<AclResourceType, 'agent' | 'skill' | 'mcp' | 'plugin'>,
): Promise<ReadonlySet<string>> {
  if (hasResourceAclBypass(authority)) return new Set()
  const rows = await transaction
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, authority.user.id)))
  return new Set(rows.map((row) => row.resourceId))
}

async function assertReferencesUsable(input: {
  readonly transaction: ResourceCatalogTransaction
  readonly authority: AgentOperationContext
  readonly type: Extract<AclResourceType, 'agent' | 'skill' | 'mcp' | 'plugin'>
  readonly ids: readonly string[]
  readonly missingCode: string
  readonly missingLabel: string
}): Promise<void> {
  const ids = unique(input.ids)
  if (ids.length === 0) return
  const [rows, grants] = await Promise.all([
    rowsByIds(input.transaction, input.type, ids),
    grantedIds(input.transaction, input.authority, input.type),
  ])
  const byId = new Map(rows.map((row) => [row.id, row]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new ValidationError(
      input.missingCode,
      `agent references unknown ${input.missingLabel}(s): ${missing.join(', ')}`,
      { notFound: missing },
    )
  }
  const hidden = ids.filter((id) => {
    const row = byId.get(id)
    return row !== undefined && !isVisibleRow(input.authority, row, grants)
  })
  if (hidden.length > 0) {
    throw new ValidationError(
      'acl-missing-refs',
      `you do not have access to: ${hidden.map((id) => `${input.type} '${id}'`).join(', ')}`,
      { missing: hidden.map((id) => ({ type: input.type, name: id })) },
    )
  }
}

async function assertRuntime(
  runtimeProfiles: AgentRuntimeProfileLookup,
  runtime: string | null | undefined,
  previous?: string,
): Promise<void> {
  if (runtime === null || runtime === undefined) return
  const profile = await runtimeProfiles.get(runtime)
  if (profile === null) {
    throw new ValidationError('runtime-not-found', `agent references unknown runtime: ${runtime}`, {
      notFound: [runtime],
    })
  }
  if (!profile.enabled && runtime !== previous) {
    throw new ValidationError(
      'runtime-disabled',
      `agent references disabled runtime: ${runtime}; enable it or pick another`,
      { disabled: [runtime] },
    )
  }
}

async function assertDependencyGraph(
  transaction: ResourceCatalogTransaction,
  candidateId: string,
  dependencyIds: readonly string[],
): Promise<void> {
  if (dependencyIds.includes(candidateId)) {
    throw new ValidationError('agent-dependency-self', 'agent cannot depend on itself')
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()
  async function visit(id: string): Promise<void> {
    if (id === candidateId || visiting.has(id)) {
      throw new ValidationError('agent-dependency-cycle', 'agent dependency graph contains a cycle')
    }
    if (visited.has(id)) return
    visiting.add(id)
    const row = (
      await transaction
        .select({ dependsOn: agents.dependsOn })
        .from(agents)
        .where(eq(agents.id, id))
        .limit(1)
    )[0]
    if (row === undefined) {
      throw new ValidationError(
        'agent-dependency-not-found',
        `agent dependency '${id}' not found`,
        {
          notFound: [id],
        },
      )
    }
    let nested: readonly string[] = []
    try {
      const decoded: unknown = JSON.parse(row.dependsOn)
      if (Array.isArray(decoded)) {
        nested = decoded.filter((value): value is string => typeof value === 'string')
      }
    } catch {
      nested = []
    }
    for (const dependency of nested) await visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const dependency of unique(dependencyIds)) await visit(dependency)
}

function onlyNew(next: readonly string[], previous: readonly string[] | undefined): string[] {
  const existing = new Set(previous ?? [])
  return unique(next).filter((id) => !existing.has(id))
}

async function assertCandidate(input: {
  readonly transaction: ResourceCatalogTransaction
  readonly authority: AgentOperationContext
  readonly runtimeProfiles: AgentRuntimeProfileLookup
  readonly candidate: Agent
  readonly previous?: Agent
}): Promise<void> {
  assertBranchPortsDeclared(input.candidate)
  await assertRuntime(input.runtimeProfiles, input.candidate.runtime, input.previous?.runtime)
  await assertReferencesUsable({
    transaction: input.transaction,
    authority: input.authority,
    type: 'agent',
    ids: onlyNew(input.candidate.dependsOn, input.previous?.dependsOn),
    missingCode: 'agent-dependency-not-found',
    missingLabel: 'agent dependency',
  })
  await assertReferencesUsable({
    transaction: input.transaction,
    authority: input.authority,
    type: 'mcp',
    ids: onlyNew(input.candidate.mcp, input.previous?.mcp),
    missingCode: 'mcp-not-found',
    missingLabel: 'mcp',
  })
  await assertReferencesUsable({
    transaction: input.transaction,
    authority: input.authority,
    type: 'plugin',
    ids: onlyNew(input.candidate.plugins, input.previous?.plugins),
    missingCode: 'plugin-not-found',
    missingLabel: 'plugin',
  })
  await assertDependencyGraph(input.transaction, input.candidate.id, input.candidate.dependsOn)
}

/**
 * managed skill 的可用性围栏放在 RFC-228 结构化预检**之后**：合一前的 SQLite 路径没有逐类的 skill 存在性守卫，缺失的
 * managed skill 一律由预检以 `agent-resources-invalid` + issues 报出（rfc223-pr1-impl-gate 锁）；这里只兜授权与并发。
 */
async function assertSkillReferencesUsable(input: {
  readonly transaction: ResourceCatalogTransaction
  readonly authority: AgentOperationContext
  readonly candidate: Agent
  readonly previous?: Agent
}): Promise<void> {
  await assertReferencesUsable({
    transaction: input.transaction,
    authority: input.authority,
    type: 'skill',
    ids: onlyNew(
      managedSkillIds(input.candidate.skills),
      managedSkillIds(input.previous?.skills ?? []),
    ),
    missingCode: 'skill-not-found',
    missingLabel: 'managed skill',
  })
}

async function assertNotReferenced(
  transaction: ResourceCatalogTransaction,
  current: Agent,
): Promise<void> {
  const agentRows = await transaction
    .select({ id: agents.id, dependsOn: agents.dependsOn })
    .from(agents)
  const dependent = agentRows.find((row) => {
    if (row.id === current.id) return false
    try {
      const decoded: unknown = JSON.parse(row.dependsOn)
      return Array.isArray(decoded) && decoded.includes(current.id)
    } catch {
      return false
    }
  })
  if (dependent !== undefined) {
    throw new ConflictError('agent-in-use', `agent '${current.id}' is referenced by another agent`)
  }
  const workflowRows = await transaction
    .select({ id: workflows.id, definition: workflows.definition })
    .from(workflows)
  const referenced = workflowRows.find((row) => {
    try {
      const decoded: unknown = JSON.parse(row.definition)
      return extractWorkflowAgentRefs(
        typeof decoded === 'object' && decoded !== null
          ? (decoded as { readonly nodes?: ReadonlyArray<Record<string, unknown>> })
          : {},
      ).has(current.id)
    } catch {
      return false
    }
  })
  if (referenced !== undefined) {
    throw new ConflictError('agent-in-use', `agent '${current.id}' is referenced by a workflow`)
  }
}

/** Closed runtime-registry projection required by Agent persistence semantics. */
export interface AgentRuntimeProfileLookup {
  get(name: string): Promise<Readonly<{ enabled: boolean }> | null>
}

/** Owner-native semantics for the Agent repository（RFC-359 W4-D14：一份实现，两个 provider 共用）。 */
export function createAgentPersistenceSemantics(input: {
  readonly db: ProviderNeutralDatabase
  readonly authorization: ResourceAuthorizationApplication
  readonly resourceInventory: AgentResourceInventorySource
  readonly runtimeProfiles: AgentRuntimeProfileLookup
}): AgentPersistenceSemantics {
  const labels = async (
    authority: AgentOperationContext,
    request: AgentReferenceLabelsInput,
  ): Promise<AgentReferenceLabels> => {
    const visibleAgents = new Set(request.visibleAgentIds)
    const selected = request.agents.filter((agent) => visibleAgents.has(agent.id))
    const skillIds = managedSkillIds(selected.flatMap((agent) => agent.skills))
    const mcpIds = unique(selected.flatMap((agent) => agent.mcp))
    const pluginIds = unique(selected.flatMap((agent) => agent.plugins))
    const [skillRows, mcpRows, pluginRows] = await Promise.all([
      skillIds.length === 0
        ? Promise.resolve([])
        : input.db
            .select({
              id: skills.id,
              name: skills.name,
              ownerUserId: skills.ownerUserId,
              visibility: skills.visibility,
            })
            .from(skills)
            .where(inArray(skills.id, skillIds)),
      mcpIds.length === 0
        ? Promise.resolve([])
        : input.db
            .select({
              id: mcps.id,
              name: mcps.name,
              ownerUserId: mcps.ownerUserId,
              visibility: mcps.visibility,
            })
            .from(mcps)
            .where(inArray(mcps.id, mcpIds)),
      pluginIds.length === 0
        ? Promise.resolve([])
        : input.db
            .select({
              id: plugins.id,
              name: plugins.name,
              ownerUserId: plugins.ownerUserId,
              visibility: plugins.visibility,
            })
            .from(plugins)
            .where(inArray(plugins.id, pluginIds)),
    ])
    const [visibleSkills, visibleMcps, visiblePlugins] = await Promise.all([
      input.authorization.filterVisibleRows(authority, 'skill', skillRows),
      input.authorization.filterVisibleRows(authority, 'mcp', mcpRows),
      input.authorization.filterVisibleRows(authority, 'plugin', pluginRows),
    ])
    const project = (rows: readonly { readonly id: string; readonly name: string }[]) =>
      Object.freeze(rows.map((row) => Object.freeze({ id: row.id, name: row.name })))
    return Object.freeze({
      skills: project(visibleSkills),
      mcps: project(visibleMcps),
      plugins: project(visiblePlugins),
    })
  }

  return Object.freeze<AgentPersistenceSemantics>({
    async canonicalizeCreate(_authority, submitted, _id) {
      return reconcileCreatedAgentExecutionContractPorts(submitted)
    },
    async canonicalizeUpdate(_authority, current, patch) {
      return reconcileUpdatedAgentExecutionContractPorts(current, patch)
    },
    // 次序与合一前的 SQLite 路径一致：逐类守卫（依赖 / mcp / plugin / runtime）→ RFC-228 闭包预检
    // （`agent-resources-invalid` + issues，缺失的 managed skill 在这里报）→ managed skill 的授权围栏。
    async assertCreateInTransaction(transaction, authority, candidate) {
      await assertCandidate({
        transaction,
        authority,
        runtimeProfiles: input.runtimeProfiles,
        candidate,
      })
      await assertAgentResourceIntegrity(input.resourceInventory, [candidate.id], {
        overrides: [candidate],
      })
      await assertSkillReferencesUsable({ transaction, authority, candidate })
    },
    async assertUpdateInTransaction(transaction, authority, current, candidate) {
      await assertCandidate({
        transaction,
        authority,
        runtimeProfiles: input.runtimeProfiles,
        candidate,
        previous: current,
      })
      await assertAgentResourceIntegrity(input.resourceInventory, [candidate.id], {
        overrides: [candidate],
      })
      await assertSkillReferencesUsable({ transaction, authority, candidate, previous: current })
    },
    async assertDeleteInTransaction(transaction, _authority, current) {
      await assertNotReferenced(transaction, current)
    },
    referenceLabels: labels,
  })
}
