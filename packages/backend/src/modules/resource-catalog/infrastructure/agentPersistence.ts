import {
  AgentInputPortSchema,
  AgentInputPortsSchema,
  type Agent,
  type AgentReferences,
  type CreateAgent,
  type UpdateAgent,
} from '@agent-workflow/shared'
import { decodeAgentReferenceIds } from './agentReferenceCodec'
import { asc, inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import { continueResourceCommit } from './resourceCommitSequence'

export interface AgentPersistenceRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly outputs: string
  readonly inputs: string
  readonly syncOutputsOnIterate: boolean
  readonly runtime: string | null
  readonly permission: string
  readonly frontmatterExtra: string
  readonly bodyMd: string
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly aclRevision: number
  readonly builtin: boolean
  readonly schemaVersion: number
  readonly createdAt: number
  readonly updatedAt: number
}

function jsonRecord(value: string): Record<string, unknown> {
  try {
    const decoded: unknown = JSON.parse(value)
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return {}
    return Object.fromEntries(Object.entries(decoded))
  } catch {
    return {}
  }
}

function inputPorts(value: string): Agent['inputs'] {
  try {
    const parsed = AgentInputPortSchema.array().safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

type AgentRowDecoding = 'normalized' | 'stored-json'

function sidecarMap(
  value: unknown,
  decoding: AgentRowDecoding,
): Record<string, string> | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    (decoding === 'normalized' && Array.isArray(value))
  ) {
    return undefined
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0,
  )
  const mapped = Object.fromEntries(entries)
  // The stored-JSON entry populated an ordinary object by assigning each entry.
  const result = decoding === 'stored-json' ? Object.assign({}, mapped) : mapped
  return Object.keys(result).length === 0 ? undefined : result
}

function frontmatterSidecars(
  fmExtra: Record<string, unknown>,
  decoding: AgentRowDecoding,
): {
  readonly exposed: Record<string, unknown>
  readonly outputKinds?: Agent['outputKinds']
  readonly role?: Agent['role']
  readonly outputWrapperPortNames?: Agent['outputWrapperPortNames']
  readonly branchPorts?: Agent['branchPorts']
} {
  // Read before spreading: the stored-JSON entry historically throws on JSON null.
  const outputKinds = sidecarMap(fmExtra.outputKinds, decoding)
  const role = fmExtra.role === 'aggregator' ? 'aggregator' : undefined
  const outputWrapperPortNames = sidecarMap(fmExtra.outputWrapperPortNames, decoding)
  const branchPorts = Array.isArray(fmExtra.branchPorts)
    ? fmExtra.branchPorts.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      )
    : undefined
  const exposed = { ...fmExtra }
  delete exposed.outputKinds
  delete exposed.role
  delete exposed.outputWrapperPortNames
  delete exposed.branchPorts
  return {
    exposed,
    ...(outputKinds === undefined ? {} : { outputKinds }),
    ...(role === undefined ? {} : { role }),
    ...(outputWrapperPortNames === undefined ? {} : { outputWrapperPortNames }),
    ...(branchPorts === undefined || branchPorts.length === 0 ? {} : { branchPorts }),
  }
}

/**
 * RFC-359 AC-1 —— 存储里那串 `frontmatter_extra` JSON 的**对外视图**：四个 sidecar 键
 * （`outputKinds` / `role` / `outputWrapperPortNames` / `branchPorts`）已被本层提升成
 * `Agent` 的一等字段，不再算 extra，所以 `Agent.frontmatterExtra` 里看不到它们。
 *
 * 导出它是因为**窄投影**的读者（只取 4 列、不整行解码）此前只能自己 `JSON.parse`，
 * 于是拿到的是**没剥 sidecar 的原始对象**——同一行数据在整行路径与窄投影路径上形状不同。
 * 合一到这一个函数后两条路不可能再漂。
 */
export function exposedFrontmatterExtra(storedJson: string): Record<string, unknown> {
  return frontmatterSidecars(JSON.parse(storedJson), 'stored-json').exposed
}

function decodeAgentPersistenceRow(
  row: AgentPersistenceRow,
  references: AgentReferences,
  decoding: AgentRowDecoding,
): Agent {
  const sidecars = frontmatterSidecars(
    decoding === 'normalized' ? jsonRecord(row.frontmatterExtra) : JSON.parse(row.frontmatterExtra),
    decoding,
  )
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    outputs:
      decoding === 'normalized' ? decodeAgentReferenceIds(row.outputs) : JSON.parse(row.outputs),
    inputs: inputPorts(row.inputs),
    syncOutputsOnIterate: row.syncOutputsOnIterate,
    permission: decoding === 'normalized' ? jsonRecord(row.permission) : JSON.parse(row.permission),
    skills: [...references.skills],
    dependsOn: [...references.dependsOn],
    mcp: [...references.mcp],
    plugins: [...references.plugins],
    frontmatterExtra: sidecars.exposed,
    bodyMd: row.bodyMd,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    aclRevision: row.aclRevision,
    builtin: row.builtin,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(sidecars.outputKinds === undefined ? {} : { outputKinds: sidecars.outputKinds }),
    ...(sidecars.role === undefined ? {} : { role: sidecars.role }),
    ...(sidecars.outputWrapperPortNames === undefined
      ? {}
      : { outputWrapperPortNames: sidecars.outputWrapperPortNames }),
    ...(sidecars.branchPorts === undefined ? {} : { branchPorts: sidecars.branchPorts }),
    ...(decoding === 'stored-json'
      ? typeof row.runtime === 'string' && row.runtime.length > 0
        ? { runtime: row.runtime }
        : {}
      : row.runtime === null || row.runtime.length === 0
        ? {}
        : { runtime: row.runtime }),
  }
}

export function agentFromPersistenceRow(
  row: AgentPersistenceRow,
  references: AgentReferences,
): Agent {
  return decodeAgentPersistenceRow(row, references, 'normalized')
}

/** Keep the established JSON parsing contract of the legacy row loader. */
export function agentFromStoredJsonRow(
  row: AgentPersistenceRow,
  references: AgentReferences,
): Agent {
  return decodeAgentPersistenceRow(row, references, 'stored-json')
}

function persistedFrontmatter(
  agent: Pick<
    Agent,
    'frontmatterExtra' | 'outputKinds' | 'role' | 'outputWrapperPortNames' | 'branchPorts'
  >,
): string {
  const value: Record<string, unknown> = { ...agent.frontmatterExtra }
  if (agent.outputKinds !== undefined) value.outputKinds = agent.outputKinds
  if (agent.role !== undefined && agent.role !== 'normal') value.role = agent.role
  if (agent.outputWrapperPortNames !== undefined) {
    value.outputWrapperPortNames = agent.outputWrapperPortNames
  }
  if (agent.branchPorts !== undefined && agent.branchPorts.length > 0) {
    value.branchPorts = agent.branchPorts
  }
  return JSON.stringify(value)
}

/** RFC-166 — canonicalize declared input ports for the agents.inputs column:
 *  apply the `kind` default, strip unknown keys, and REJECT duplicate port
 *  names (persistence guard mirroring the DTO — port name is an identity key),
 *  so the stored JSON is identical whether or not the caller pre-parsed through
 *  CreateAgentSchema. Throws a ZodError on a dupe from a service-layer caller
 *  that bypassed the route's CreateAgentSchema validation. */
export function serializeAgentInputs(inputs: CreateAgent['inputs']): string {
  return JSON.stringify(AgentInputPortsSchema.parse(inputs ?? []))
}

/** Encode content at the caller's original write point, with its prepared refs/sidecars. */
export function agentContentPersistenceValues(
  agent: CreateAgent,
  preparedFrontmatter?: Record<string, unknown>,
) {
  return {
    description: agent.description,
    outputs: JSON.stringify(agent.outputs),
    inputs: serializeAgentInputs(agent.inputs),
    syncOutputsOnIterate: agent.syncOutputsOnIterate,
    runtime: agent.runtime ?? null,
    permission: JSON.stringify(agent.permission),
    frontmatterExtra:
      preparedFrontmatter === undefined
        ? persistedFrontmatter(agent)
        : JSON.stringify(preparedFrontmatter),
    bodyMd: agent.bodyMd,
  }
}

export function createAgentPersistenceValues(input: {
  readonly id: string
  readonly agent: CreateAgent
  readonly ownerUserId: string
  readonly now: number
}): AgentPersistenceRow {
  const candidate: Agent = {
    ...input.agent,
    id: input.id,
    inputs: input.agent.inputs ?? [],
    ownerUserId: input.ownerUserId,
    visibility: 'private',
    aclRevision: 0,
    builtin: false,
    schemaVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
  }
  return {
    id: candidate.id,
    name: candidate.name,
    ...agentContentPersistenceValues(candidate),
    ownerUserId: candidate.ownerUserId ?? null,
    visibility: candidate.visibility ?? 'private',
    aclRevision: candidate.aclRevision ?? 0,
    builtin: candidate.builtin ?? false,
    schemaVersion: candidate.schemaVersion,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  }
}

export function updateAgentPersistenceValues(
  current: Agent,
  patch: UpdateAgent,
  updatedAt: number,
): Omit<
  AgentPersistenceRow,
  | 'id'
  | 'name'
  | 'ownerUserId'
  | 'visibility'
  | 'aclRevision'
  | 'builtin'
  | 'schemaVersion'
  | 'createdAt'
> {
  const { runtime: _currentRuntime, ...currentWithoutRuntime } = current
  const { runtime: submittedRuntime, ...patchWithoutRuntime } = patch
  const runtime = submittedRuntime === null ? undefined : (submittedRuntime ?? current.runtime)
  const next: Agent = {
    ...currentWithoutRuntime,
    ...patchWithoutRuntime,
    ...(runtime === undefined ? {} : { runtime }),
    updatedAt,
  }
  return {
    ...agentContentPersistenceValues(next),
    updatedAt,
  }
}

/** Batch projection never joins mutable targets: dangling IDs and duplicates are data. */
export function readAgentReferences(
  db: DbClient | DbTxSync,
  ids: readonly string[],
): Map<string, AgentReferences>
export function readAgentReferences(
  db: PersistenceDb | PersistenceTx,
  ids: readonly string[],
): Map<string, AgentReferences> | Promise<Map<string, AgentReferences>>
export function readAgentReferences(
  db: PersistenceDb | PersistenceTx,
  ids: readonly string[],
): Map<string, AgentReferences> | Promise<Map<string, AgentReferences>> {
  const references = new Map<
    string,
    { skills: Agent['skills']; dependsOn: string[]; mcp: string[]; plugins: string[] }
  >(ids.map((id) => [id, { skills: [], dependsOn: [], mcp: [], plugins: [] }]))
  if (ids.length === 0) return references
  const { agentSkillRefs, agentMcpRefs, agentPluginRefs, agentDependencies } = tablesOf(db)
  const skills = queryRows(
    db
      .select()
      .from(agentSkillRefs)
      .where(inArray(agentSkillRefs.agentId, [...ids]))
      .orderBy(asc(agentSkillRefs.ordinal)),
  )
  const mcp = queryRows(
    db
      .select()
      .from(agentMcpRefs)
      .where(inArray(agentMcpRefs.agentId, [...ids]))
      .orderBy(asc(agentMcpRefs.ordinal)),
  )
  const plugins = queryRows(
    db
      .select()
      .from(agentPluginRefs)
      .where(inArray(agentPluginRefs.agentId, [...ids]))
      .orderBy(asc(agentPluginRefs.ordinal)),
  )
  const dependencies = queryRows(
    db
      .select()
      .from(agentDependencies)
      .where(inArray(agentDependencies.agentId, [...ids]))
      .orderBy(asc(agentDependencies.ordinal)),
  )
  const project = ([skillRows, mcpRows, pluginRows, dependencyRows]: [
    Awaited<typeof skills>,
    Awaited<typeof mcp>,
    Awaited<typeof plugins>,
    Awaited<typeof dependencies>,
  ]) => {
    for (const row of skillRows) {
      if (row.kind === 'managed') {
        if (row.skillId === null) throw new Error('agent-skill-reference-shape')
        references.get(row.agentId)!.skills.push({ kind: 'managed', skillId: row.skillId })
      } else {
        if (row.projectName === null) throw new Error('agent-skill-reference-shape')
        references.get(row.agentId)!.skills.push({ kind: 'project', name: row.projectName })
      }
    }
    for (const row of mcpRows) references.get(row.agentId)!.mcp.push(row.mcpId)
    for (const row of pluginRows) references.get(row.agentId)!.plugins.push(row.pluginId)
    for (const row of dependencyRows)
      references.get(row.agentId)!.dependsOn.push(row.dependencyAgentId)
    return references
  }
  return Array.isArray(skills) &&
    Array.isArray(mcp) &&
    Array.isArray(plugins) &&
    Array.isArray(dependencies)
    ? project([skills, mcp, plugins, dependencies])
    : Promise.all([skills, mcp, plugins, dependencies]).then(project)
}

type AgentRowsReader = (
  tx: PersistenceTx,
) => readonly AgentPersistenceRow[] | Promise<readonly AgentPersistenceRow[]>
type AgentRowReader = (
  tx: PersistenceTx,
) => AgentPersistenceRow | undefined | Promise<AgentPersistenceRow | undefined>

/** Pass a query callback on a client; preloaded rows must come from the supplied transaction. */
export function loadAgentPersistenceRows(
  db: PersistenceDb,
  readRows: AgentRowsReader,
  decoding?: AgentRowDecoding,
): Promise<Agent[]>
export function loadAgentPersistenceRows(
  db: DbTxSync,
  rows: readonly AgentPersistenceRow[],
  decoding?: AgentRowDecoding,
): Agent[]
export function loadAgentPersistenceRows(
  db: PersistenceTx,
  rows: readonly AgentPersistenceRow[],
  decoding?: AgentRowDecoding,
): Agent[] | Promise<Agent[]>
export function loadAgentPersistenceRows(
  db: PersistenceDb | PersistenceTx,
  rows: readonly AgentPersistenceRow[] | AgentRowsReader,
  decoding: AgentRowDecoding = 'normalized',
): Agent[] | Promise<Agent[]> {
  if (typeof rows === 'function') {
    return databaseSessionFor(db).snapshotRead(async (tx) =>
      loadAgentPersistenceRows(tx, await rows(tx), decoding),
    )
  }
  return continueResourceCommit(
    readAgentReferences(
      db,
      rows.map((row) => row.id),
    ),
    (references) =>
      rows.map((row) => decodeAgentPersistenceRow(row, references.get(row.id)!, decoding)),
  )
}

export function loadAgentPersistenceRow(
  db: PersistenceDb,
  readRow: AgentRowReader,
  decoding?: AgentRowDecoding,
): Promise<Agent | null>
export function loadAgentPersistenceRow(
  db: PersistenceTx,
  row: AgentPersistenceRow,
  decoding?: AgentRowDecoding,
): Promise<Agent>
export async function loadAgentPersistenceRow(
  db: PersistenceDb | PersistenceTx,
  row: AgentPersistenceRow | AgentRowReader,
  decoding: AgentRowDecoding = 'normalized',
): Promise<Agent | null> {
  if (typeof row === 'function') {
    return databaseSessionFor(db).snapshotRead(async (tx) => {
      const selected = await row(tx)
      return selected === undefined ? null : loadAgentPersistenceRow(tx, selected, decoding)
    })
  }
  return (await loadAgentPersistenceRows(db, [row], decoding))[0]!
}
