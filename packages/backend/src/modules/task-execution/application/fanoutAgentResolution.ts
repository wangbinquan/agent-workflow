// RFC-420 — agent resolution by the canonical fan-out key (RFC-223): the fan-out inner / aggregator agent the wrapper
// data port hydrates, and the declared kind of a producer port. Moved verbatim from the wrapper data binding
// (`composition/wrapperMechanics.ts` `resolveFanoutAgent`) and the agent binding (`composition/agentNodeExecution.ts`
// `sourcePortKindOf`); the composition supplies the key oracle and the task's resource session.
import { declaredPorts, type WorkflowDefinition, type WorkflowNode } from '@agent-workflow/shared'
import type { AgentInjection } from './ports/agentNodeExecution'
import type { WrapperFanoutAgentResolution } from './ports/wrapperData'

/** What an agent resolution reads: the definition, the canonical fan-out key and the task's resource session. */
export interface FanoutAgentResources {
  readonly definition: WorkflowDefinition
  /** RFC-223 / RFC-271 T6d — the node's stamped `agentId`; a name-only node returns null and fails closed. */
  agentKey(node: Record<string, unknown>): string | null
  injection(agentId: string): Promise<AgentInjection>
}

/** The fan-out inner / aggregator agent; failures come back as data, never thrown. */
export async function resolveFanoutAgent(
  resources: FanoutAgentResources,
  node: WorkflowNode,
): Promise<WrapperFanoutAgentResolution> {
  const agentId = resources.agentKey(node as Record<string, unknown>)
  if (agentId === null) return { kind: 'missing' }
  const resolution = await resources.injection(agentId)
  return resolution.kind === 'ok' ? { kind: 'ok', agent: resolution.spec.agent } : resolution
}

/**
 * RFC-354 — the declared kind of a producer port. Agents resolve through the injection registry (id-first, like
 * every other agent read in this module); every other kind answers through the shared port table.
 *
 * RFC-407: shared by the wrapper data binding and the agent binding's `resources.sourcePortKind` (fan-out shard
 * inputs).
 */
export async function sourcePortKindOf(
  resources: FanoutAgentResources,
  nodeId: string,
  portName: string,
): Promise<string | null> {
  const node = resources.definition.nodes.find((candidate) => candidate.id === nodeId)
  if (node === undefined) return null
  if (node.kind === 'agent-single') {
    const agentId = resources.agentKey(node as Record<string, unknown>)
    if (agentId === null) return null
    const resolution = await resources.injection(agentId)
    return resolution.kind === 'ok' ? (resolution.spec.agent.outputKinds?.[portName] ?? null) : null
  }
  return (
    declaredPorts(node, resources.definition, {}).dataOutputs.find((port) => port.name === portName)
      ?.kind ?? null
  )
}
