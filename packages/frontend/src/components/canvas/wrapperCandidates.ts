// RFC-016: derive the select-options list used by the loop wrapper Inspector
// for `exitCondition.nodeId / portName` and `outputBindings`. Replaces the
// previous TextInput-based contract where users hand-typed inner node ids
// and port names from memory.
//
// Only direct, non-wrapper members are returned — loop exit conditions and
// output bindings should reference concrete agent / review nodes, not nested
// wrappers (their outputs flow through their own outputBindings rather than
// surfacing a port directly).

import { buildNodeAgentLookup, declaredPorts, isWrapperKind } from '@agent-workflow/shared'
import { nodeDisplayTitle } from './nodeTitle'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

export interface LoopMemberCandidate {
  nodeId: string
  /** Display label = node.title || agentName || nodeId — UI shows "title (id)". */
  title: string
  /** Output ports the candidate node can be referenced on. */
  outputPorts: string[]
}

interface AgentSummary {
  /** RFC-223 (PR-3a impl-gate H3): the canonical id — callers pass full Agent
   *  objects, so the node→agent lookup can key by id (a stamped node resolves
   *  strictly by agentId now). */
  id: string
  name: string
  /** Declared agent outputs. When missing or empty, treat as ['out']. */
  outputs?: string[]
  /** Per-port declared kinds — used to resolve a review node's input kind
   *  (multi-doc vs single-doc) exactly like WorkflowCanvas.computePorts.
   *  Callers pass full Agent objects, which carry this field. */
  outputKinds?: Record<string, string>
}

// RFC-146 T4: title derivation moved to the shared ./nodeTitle single
// source (this fork was where the `review:<port>` rule lived; the canvas
// card now uses it too). '' return keeps the historical "UI falls back to
// nodeId rendering" contract.

function deriveOutputPorts(
  node: WorkflowNode,
  agents: AgentSummary[],
  definition: WorkflowDefinition,
): string[] {
  // RFC-146: read the shared port-declaration table (this was fork #3 of
  // five — it knew agent/review only; review had already drifted once,
  // flag-audit W0 §3-3 假端口 bug). Wrapper members are filtered out by the
  // caller, so only leaf kinds reach here.
  // RFC-223 (PR-3a impl-gate H3): id+name keyed so stamped nodes resolve by id.
  const declared = declaredPorts(
    node,
    definition,
    buildNodeAgentLookup(agents, (a) => a),
  )
  const names = declared.dataOutputs.map((p) => p.name).filter((n) => n.length > 0)
  // Agent fallback preserved at the call site: an agent with no declared
  // outputs is still referenceable via the conventional 'out' port.
  if (node.kind === 'agent-single' && names.length === 0) return ['out']
  return names
}

export function loopMemberCandidates(
  wrapper: WorkflowNode,
  definition: WorkflowDefinition,
  agents: AgentSummary[],
): LoopMemberCandidate[] {
  const innerIds = (wrapper as Record<string, unknown>).nodeIds
  const ids = Array.isArray(innerIds)
    ? innerIds.filter((s): s is string => typeof s === 'string')
    : []
  const idSet = new Set(ids)
  const result: LoopMemberCandidate[] = []
  for (const n of definition.nodes) {
    if (!idSet.has(n.id)) continue
    if (isWrapperKind(n.kind)) continue
    const outputPorts = deriveOutputPorts(n, agents, definition)
    result.push({
      nodeId: n.id,
      title: nodeDisplayTitle(n),
      outputPorts,
    })
  }
  return result
}
