// RFC-016: derive the select-options list used by the loop wrapper Inspector
// for `exitCondition.nodeId / portName` and `outputBindings`. Replaces the
// previous TextInput-based contract where users hand-typed inner node ids
// and port names from memory.
//
// Only direct, non-wrapper members are returned — loop exit conditions and
// output bindings should reference concrete agent / review nodes, not nested
// wrappers (their outputs flow through their own outputBindings rather than
// surfacing a port directly).

import { declaredPorts, isWrapperKind } from '@agent-workflow/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

export interface LoopMemberCandidate {
  nodeId: string
  /** Display label = node.title || agentName || nodeId — UI shows "title (id)". */
  title: string
  /** Output ports the candidate node can be referenced on. */
  outputPorts: string[]
}

interface AgentSummary {
  name: string
  /** Declared agent outputs. When missing or empty, treat as ['out']. */
  outputs?: string[]
  /** Per-port declared kinds — used to resolve a review node's input kind
   *  (multi-doc vs single-doc) exactly like WorkflowCanvas.computePorts.
   *  Callers pass full Agent objects, which carry this field. */
  outputKinds?: Record<string, string>
}

/** Look up an inner node's display title using whatever fields the node kind
 * carries. Returns '' so the UI falls back to nodeId rendering when needed. */
function deriveTitle(node: WorkflowNode, agents: AgentSummary[]): string {
  const rec = node as Record<string, unknown>
  if (typeof rec.title === 'string' && rec.title.length > 0) return rec.title
  if (node.kind === 'agent-single') {
    const agentName = typeof rec.agentName === 'string' ? rec.agentName : ''
    if (agentName.length > 0) return agentName
  }
  if (node.kind === 'review') {
    // flag-audit W0（§3-4）：schema 字段是 inputSource（shared/schemas/review.ts），
    // 旧代码读不存在的 rec.source，此分支曾永不可达。
    const src = (rec.inputSource as { portName?: unknown } | undefined)?.portName
    if (typeof src === 'string' && src.length > 0) return `review:${src}`
  }
  // unused but kept for future kinds — agents lookup may inform fallback titles.
  void agents
  return ''
}

function deriveOutputPorts(
  node: WorkflowNode,
  agents: AgentSummary[],
  definition: WorkflowDefinition,
): string[] {
  // RFC-146: read the shared port-declaration table (this was fork #3 of
  // five — it knew agent/review only; review had already drifted once,
  // flag-audit W0 §3-3 假端口 bug). Wrapper members are filtered out by the
  // caller, so only leaf kinds reach here.
  const declared = declaredPorts(node, definition, new Map(agents.map((a) => [a.name, a])))
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
      title: deriveTitle(n, agents),
      outputPorts,
    })
  }
  return result
}
