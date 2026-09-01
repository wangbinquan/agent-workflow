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

function frontmatterSidecars(frontmatterExtra: Record<string, unknown>): {
  readonly exposed: Record<string, unknown>
  readonly outputKinds?: Agent['outputKinds']
  readonly role?: Agent['role']
  readonly outputWrapperPortNames?: Agent['outputWrapperPortNames']
  readonly branchPorts?: Agent['branchPorts']
} {
  const exposed = { ...frontmatterExtra }
  const outputKinds =
    typeof exposed.outputKinds === 'object' &&
    exposed.outputKinds !== null &&
    !Array.isArray(exposed.outputKinds)
      ? Object.fromEntries(
          Object.entries(exposed.outputKinds).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string' && entry[1].length > 0,
          ),
        )
      : undefined
  const outputWrapperPortNames =
    typeof exposed.outputWrapperPortNames === 'object' &&
    exposed.outputWrapperPortNames !== null &&
    !Array.isArray(exposed.outputWrapperPortNames)
      ? Object.fromEntries(
          Object.entries(exposed.outputWrapperPortNames).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === 'string' && entry[1].length > 0,
          ),
        )
      : undefined
  const branchPorts = Array.isArray(exposed.branchPorts)
    ? exposed.branchPorts.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0,
      )
    : undefined
  const role = exposed.role === 'aggregator' ? 'aggregator' : undefined
  delete exposed.outputKinds
  delete exposed.role
  delete exposed.outputWrapperPortNames
  delete exposed.branchPorts
  return {
    exposed,
    ...(outputKinds === undefined || Object.keys(outputKinds).length === 0 ? {} : { outputKinds }),
    ...(role === undefined ? {} : { role }),
    ...(outputWrapperPortNames === undefined || Object.keys(outputWrapperPortNames).length === 0
      ? {}
      : { outputWrapperPortNames }),
    ...(branchPorts === undefined || branchPorts.length === 0 ? {} : { branchPorts }),
  }
}

export function agentFromPersistenceRow(row: AgentPersistenceRow): Agent {
  const sidecars = frontmatterSidecars(jsonRecord(row.frontmatterExtra))
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    outputs: stringArray(row.outputs),
    inputs: inputPorts(row.inputs),
    syncOutputsOnIterate: row.syncOutputsOnIterate,
    permission: jsonRecord(row.permission),
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
    ...(row.runtime === null || row.runtime.length === 0 ? {} : { runtime: row.runtime }),
  }
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
    description: candidate.description,
    outputs: JSON.stringify(candidate.outputs),
    inputs: JSON.stringify(AgentInputPortsSchema.parse(candidate.inputs ?? [])),
    syncOutputsOnIterate: candidate.syncOutputsOnIterate,
    runtime: candidate.runtime ?? null,
    permission: JSON.stringify(candidate.permission),
    skills: JSON.stringify(candidate.skills),
    dependsOn: JSON.stringify(candidate.dependsOn),
    mcp: JSON.stringify(candidate.mcp),
    plugins: JSON.stringify(candidate.plugins),
    frontmatterExtra: persistedFrontmatter(candidate),
    bodyMd: candidate.bodyMd,
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
    description: next.description,
    outputs: JSON.stringify(next.outputs),
    inputs: JSON.stringify(AgentInputPortsSchema.parse(next.inputs ?? [])),
    syncOutputsOnIterate: next.syncOutputsOnIterate,
    runtime: next.runtime ?? null,
    permission: JSON.stringify(next.permission),
    skills: JSON.stringify(next.skills),
    dependsOn: JSON.stringify(next.dependsOn),
    mcp: JSON.stringify(next.mcp),
    plugins: JSON.stringify(next.plugins),
    frontmatterExtra: persistedFrontmatter(next),
    bodyMd: next.bodyMd,
    updatedAt,
  }
}
