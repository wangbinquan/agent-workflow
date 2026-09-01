import { resourceRefKey, type Agent } from '@agent-workflow/shared'
import { DomainError } from '@/util/errors'
import type {
  AgentDependencyClosureResult,
  ResolveAgentDependencyClosureInput,
} from '../../public/types'

export interface AgentDependencyReader {
  get(id: string): Promise<Agent | null>
}

/** Provider-neutral dependency closure shared by the aggregate and SQLite writer. */
export async function resolveAgentDependencyClosure(
  reader: AgentDependencyReader,
  input: ResolveAgentDependencyClosureInput,
): Promise<AgentDependencyClosureResult> {
  const keyOf = (id: string): string => resourceRefKey({ k: 'id', type: 'agent', id })
  const visited = new Set<string>([keyOf(input.root.id)])
  const agents: Agent[] = [{ ...input.root }]
  const queue = input.root.dependsOn.map((id) => ({ id, path: [input.root.id] }))
  while (queue.length > 0) {
    const entry = queue.shift()
    if (entry === undefined) break
    const cycleIndex = entry.path.indexOf(entry.id)
    if (cycleIndex >= 0) {
      return Object.freeze({
        ok: false,
        cyclePath: Object.freeze([...entry.path.slice(cycleIndex), entry.id]),
      })
    }
    const key = keyOf(entry.id)
    if (visited.has(key)) continue
    const agent = await reader.get(entry.id)
    if (agent === null) {
      if (input.onMissing === 'skip') continue
      throw new DomainError('agent-dependency-not-found', `agent '${entry.id}' not found`, 400, {
        notFound: [entry.id],
      })
    }
    visited.add(key)
    agents.push(agent)
    for (const next of agent.dependsOn) {
      queue.push({ id: next, path: [...entry.path, entry.id] })
    }
  }
  return Object.freeze({ ok: true, agents: Object.freeze(agents) })
}

/** Validate canonical dependency ids without exposing a provider client. */
export async function validateAgentDependencies(
  reader: AgentDependencyReader,
  selfId: string,
  input: readonly string[],
): Promise<void> {
  const dependsOn = [...new Set(input)]
  if (dependsOn.includes(selfId)) {
    throw new DomainError('agent-dependency-self', 'agent cannot depend on itself', 400, {
      id: selfId,
    })
  }
  const missing: string[] = []
  for (const id of dependsOn) {
    if ((await reader.get(id)) === null) missing.push(id)
  }
  if (missing.length > 0) {
    throw new DomainError(
      'agent-dependency-not-found',
      `agent dependsOn references unknown agent(s): ${missing.join(', ')}`,
      400,
      { notFound: missing },
    )
  }
  const current = selfId.length === 0 ? null : await reader.get(selfId)
  const root: Agent =
    current === null
      ? {
          id: selfId,
          name: '',
          description: '',
          outputs: [],
          inputs: [],
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn,
          mcp: [],
          plugins: [],
          frontmatterExtra: {},
          bodyMd: '',
          schemaVersion: 1,
          createdAt: 0,
          updatedAt: 0,
        }
      : { ...current, dependsOn }
  const closure = await resolveAgentDependencyClosure(reader, { root, onMissing: 'fail' })
  if (closure.ok === false) {
    throw new DomainError(
      'agent-dependency-cycle',
      `agent dependsOn forms a cycle: ${closure.cyclePath.join(' → ')}`,
      400,
      { cyclePath: closure.cyclePath },
    )
  }
}

/** Exact reverse-reference matcher used inside the owning write transaction. */
export function agentsDependingOnIn<T extends { readonly id: string; readonly dependsOn: string }>(
  rows: readonly T[],
  agentId: string,
): T[] {
  const out: T[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.dependsOn) as unknown
      if (Array.isArray(parsed) && parsed.includes(agentId)) out.push(row)
    } catch {
      // Corrupt compatibility rows fail closed as an empty reference set.
    }
  }
  return out
}
