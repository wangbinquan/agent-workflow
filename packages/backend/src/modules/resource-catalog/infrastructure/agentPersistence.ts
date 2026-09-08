import {
  AgentInputPortSchema,
  AgentInputPortsSchema,
  AgentSkillRefSchema,
  type Agent,
  type AgentSkillRef,
  type CreateAgent,
  type UpdateAgent,
} from '@agent-workflow/shared'

export interface AgentPersistenceRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly outputs: string
  readonly inputs: string
  readonly syncOutputsOnIterate: boolean
  readonly runtime: string | null
  readonly permission: string
  readonly skills: string
  readonly dependsOn: string
  readonly mcp: string
  readonly plugins: string
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

function stringArray(value: string): string[] {
  try {
    const decoded: unknown = JSON.parse(value)
    return Array.isArray(decoded)
      ? decoded.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

function skillRefs(value: string): AgentSkillRef[] {
  try {
    const decoded: unknown = JSON.parse(value)
    if (!Array.isArray(decoded)) return []
    return decoded.flatMap((entry) => {
      const parsed = AgentSkillRefSchema.safeParse(entry)
      return parsed.success ? [parsed.data] : []
    })
  } catch {
    return []
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

function decodeAgentPersistenceRow(row: AgentPersistenceRow, decoding: AgentRowDecoding): Agent {
  const sidecars = frontmatterSidecars(
    decoding === 'normalized' ? jsonRecord(row.frontmatterExtra) : JSON.parse(row.frontmatterExtra),
    decoding,
  )
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    outputs: decoding === 'normalized' ? stringArray(row.outputs) : JSON.parse(row.outputs),
    inputs: inputPorts(row.inputs),
    syncOutputsOnIterate: row.syncOutputsOnIterate,
    permission: decoding === 'normalized' ? jsonRecord(row.permission) : JSON.parse(row.permission),
    skills: skillRefs(row.skills),
    dependsOn: stringArray(row.dependsOn),
    mcp: stringArray(row.mcp),
    plugins: stringArray(row.plugins),
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

export function agentFromPersistenceRow(row: AgentPersistenceRow): Agent {
  return decodeAgentPersistenceRow(row, 'normalized')
}

/** Keep the established JSON parsing contract of the legacy row loader. */
export function agentFromStoredJsonRow(row: AgentPersistenceRow): Agent {
  return decodeAgentPersistenceRow(row, 'stored-json')
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
  resolvedRefs?: Pick<Agent, 'skills' | 'dependsOn' | 'mcp' | 'plugins'>,
) {
  const refs = resolvedRefs ?? agent
  return {
    description: agent.description,
    outputs: JSON.stringify(agent.outputs),
    inputs: serializeAgentInputs(agent.inputs),
    syncOutputsOnIterate: agent.syncOutputsOnIterate,
    runtime: agent.runtime ?? null,
    permission: JSON.stringify(agent.permission),
    skills: JSON.stringify(refs.skills),
    dependsOn: JSON.stringify(refs.dependsOn),
    mcp: JSON.stringify(refs.mcp),
    plugins: JSON.stringify(refs.plugins),
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
