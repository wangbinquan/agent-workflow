// RFC-060 PR-C — wrapper-fanout outputs derivation.
//
// `wrapper-fanout` doesn't carry an `outputs[]` field in its schema (RFC-060
// design §5.4). The wrapper's outlet ports are derived at runtime from the
// inner subgraph:
//
//   1. If the wrapper contains exactly one role='aggregator' agent inner
//      node, the wrapper outputs MIRROR that agent's outputs (renamed via
//      `agent.outputWrapperPortNames[port]` when present).
//   2. If there's no aggregator agent, the wrapper exposes a single
//      implicit `__done__` (kind: signal) outlet — a control-flow-only
//      port downstream nodes can chain onto without consuming data.
//   3. If multiple aggregators are present (a validator error in v1), this
//      helper falls back to the first one's outputs for resilience; the
//      validator surfaces `multiple-aggregators-in-fanout` separately.
//
// Frontend canvas + Inspector use this to render the wrapper's outlet
// ports; backend validator uses it to validate downstream edges; scheduler
// uses it (PR-D) to promote inner outputs to the wrapper row's
// `node_run_outputs`.

import { DEFAULT_OUTPUT_KIND } from './outputKinds/registry'
import type { Agent } from './schemas/agent'
import type { WorkflowDefinition, WorkflowNode } from './schemas/workflow'

export interface DerivedWrapperFanoutOutput {
  name: string
  kind: string
}

/** Lookup type the helper accepts — either a Map or a plain object. */
export type AgentLookup = ReadonlyMap<string, Agent> | Readonly<Record<string, Agent | undefined>>

/** Generic lookup over Map-or-Record tables. Exported (RFC-146) so
 *  `nodePorts.ts` can share the same lookup contract with its narrower
 *  structural agent type. */
export function lookupAgent<T>(
  table: ReadonlyMap<string, T> | Readonly<Record<string, T | undefined>>,
  name: string,
): T | undefined {
  if (table instanceof Map) return table.get(name)
  return (table as Readonly<Record<string, T | undefined>>)[name]
}

function readWrapperFanout(
  defn: WorkflowDefinition,
  wrapperId: string,
): { nodeIds: string[] } | null {
  const node = defn.nodes.find((n) => n.id === wrapperId)
  if (node === undefined || node.kind !== 'wrapper-fanout') return null
  // wrapper-fanout passthrough schema; read nodeIds defensively
  const rec = node as unknown as { nodeIds?: unknown }
  const ids = Array.isArray(rec.nodeIds)
    ? rec.nodeIds.filter((x): x is string => typeof x === 'string')
    : []
  return { nodeIds: ids }
}

function isAggregatorAgentNode(node: WorkflowNode, agents: AgentLookup): Agent | null {
  if (node.kind !== 'agent-single') return null
  const rec = node as unknown as { agentName?: unknown }
  if (typeof rec.agentName !== 'string') return null
  const agent = lookupAgent(agents, rec.agentName)
  if (agent === undefined) return null
  return agent.role === 'aggregator' ? agent : null
}

/**
 * Find the inner aggregator agent of a wrapper-fanout, if any. Returns null
 * when the wrapper either contains zero aggregator agents OR isn't a
 * wrapper-fanout node id. When multiple aggregators exist (validator
 * error in v1), returns the first one in `nodeIds[]` declaration order.
 */
export function findFanoutAggregator(
  defn: WorkflowDefinition,
  wrapperId: string,
  agents: AgentLookup,
): { node: WorkflowNode; agent: Agent } | null {
  const wrapper = readWrapperFanout(defn, wrapperId)
  if (wrapper === null) return null
  for (const innerId of wrapper.nodeIds) {
    const inner = defn.nodes.find((n) => n.id === innerId)
    if (inner === undefined) continue
    const agg = isAggregatorAgentNode(inner, agents)
    if (agg !== null) return { node: inner, agent: agg }
  }
  return null
}

/**
 * Count aggregator agents inside a wrapper-fanout's inner subgraph.
 * Used by the validator `multiple-aggregators-in-fanout` rule.
 */
export function countFanoutAggregators(
  defn: WorkflowDefinition,
  wrapperId: string,
  agents: AgentLookup,
): number {
  const wrapper = readWrapperFanout(defn, wrapperId)
  if (wrapper === null) return 0
  let n = 0
  for (const innerId of wrapper.nodeIds) {
    const inner = defn.nodes.find((node) => node.id === innerId)
    if (inner === undefined) continue
    if (isAggregatorAgentNode(inner, agents) !== null) n++
  }
  return n
}

/**
 * Derive the wrapper-fanout's outlet ports.
 *
 * Returns:
 *  - When an aggregator agent is present: that agent's `outputs[]`
 *    renamed via `agent.outputWrapperPortNames[port]` when set, with
 *    each port's kind coming from `agent.outputKinds?.[port]` (default
 *    'string', matching RFC-005 behavior).
 *  - Otherwise: `[{ name: '__done__', kind: 'signal' }]` — the implicit
 *    placeholder outlet.
 */
export function deriveWrapperFanoutOutputs(
  defn: WorkflowDefinition,
  wrapperId: string,
  agents: AgentLookup,
): DerivedWrapperFanoutOutput[] {
  const found = findFanoutAggregator(defn, wrapperId, agents)
  if (found === null) {
    return [{ name: FANOUT_DONE_PORT_NAME, kind: 'signal' }]
  }
  const { agent } = found
  const renames = agent.outputWrapperPortNames ?? {}
  const kinds = agent.outputKinds ?? {}
  return agent.outputs.map((port) => ({
    name: renames[port] ?? port,
    kind: kinds[port] ?? DEFAULT_OUTPUT_KIND,
  }))
}

/**
 * Sentinel port name for the implicit signal outlet a wrapper-fanout
 * grows when it has no aggregator agent. Exported as a const so call
 * sites in other PRs can grep / pattern-match against the canonical
 * spelling.
 */
export const FANOUT_DONE_PORT_NAME = '__done__' as const
