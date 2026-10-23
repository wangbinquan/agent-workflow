import { assertAgentDependencyGraph } from '../../domain/agentDependencies'
import {
  agentReferenceIds,
  resourceRefKey,
  VALIDATE_CALL_POLICY,
  type Agent,
} from '@agent-workflow/shared'
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
  const queue = agentReferenceIds(input.root, 'agent').map((id) => ({ id, path: [input.root.id] }))
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
    for (const next of agentReferenceIds(agent, 'agent')) {
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
  await assertAgentDependencyGraph({
    candidateId: selfId,
    dependencies: input,
    semantics: 'application',
    call: VALIDATE_CALL_POLICY,
    load: async (id) => (await reader.get(id))?.dependsOn,
  })
}
