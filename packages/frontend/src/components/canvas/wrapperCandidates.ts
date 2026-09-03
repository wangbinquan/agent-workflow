// RFC-016: derive the loop wrapper's member candidates (member node + its
// output ports). RFC-354 (schema v6): a loop's returns are `wrapper-output`
// edges and its exit condition names one of its OWN return ports, so the
// inspector no longer picks members here; the list still feeds the loop's
// return-row display (which member port each return reads).
//
// Only direct, non-wrapper members are returned — a nested wrapper's ports
// reach the loop through that wrapper's own returns, never directly.

import { buildNodeAgentLookup, declaredPorts, isWrapperKind } from '@agent-workflow/shared'
import { nodeDisplayTitle } from './nodeTitle'
import type { WorkflowByRef, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

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
  workflowByRef?: WorkflowByRef,
): string[] {
  // RFC-146: read the shared port-declaration table (this was fork #3 of
  // five — it knew agent/review only; review had already drifted once,
  // flag-audit W0 §3-3 假端口 bug). Wrapper members are filtered out by the
  // caller, so only leaf kinds reach here.
  // RFC-223 (PR-3a impl-gate H3): id+name keyed so stamped nodes resolve by id.
  // RFC-243: the optional child-workflow resolver lets a call-workflow loop
  // member expose its child-mirrored output ports as return candidates
  // ("loop 包 call-workflow 直到审计干净").
  const lookup = buildNodeAgentLookup(agents, (a) => a)
  const declared = declaredPorts(
    node,
    definition,
    lookup,
    workflowByRef === undefined ? undefined : { workflowByRef },
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
  // RFC-243 §5.2 consumer #3 — optional; omitted (legacy callers/tests) a
  // call-workflow member simply contributes no candidate ports.
  workflowByRef?: WorkflowByRef,
): LoopMemberCandidate[] {
  const innerIds = (wrapper as Record<string, unknown>).nodeIds
  const ids = Array.isArray(innerIds)
    ? innerIds.filter((s): s is string => typeof s === 'string')
    : []
  const idSet = new Set(ids)
  const agentLookup = buildNodeAgentLookup(agents, (agent) => agent)
  const result: LoopMemberCandidate[] = []
  for (const n of definition.nodes) {
    if (!idSet.has(n.id)) continue
    if (isWrapperKind(n.kind)) continue
    const outputPorts = deriveOutputPorts(n, agents, definition, workflowByRef)
    result.push({
      nodeId: n.id,
      title: nodeDisplayTitle(n, agentLookup, definition),
      outputPorts,
    })
  }
  return result
}
