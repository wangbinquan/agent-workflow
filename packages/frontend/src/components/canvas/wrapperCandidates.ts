// RFC-016: derive the select-options list used by the loop wrapper Inspector
// for `exitCondition.nodeId / portName` and `outputBindings`. Replaces the
// previous TextInput-based contract where users hand-typed inner node ids
// and port names from memory.
//
// Only direct, non-wrapper members are returned — loop exit conditions and
// output bindings should reference concrete agent / review nodes, not nested
// wrappers (their outputs flow through their own outputBindings rather than
// surfacing a port directly).

import { isWrapperKind } from '@agent-workflow/shared'
import type { WorkflowNode } from '@agent-workflow/shared'

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
    const src = (rec.source as { portName?: unknown } | undefined)?.portName
    if (typeof src === 'string' && src.length > 0) return `review:${src}`
  }
  // unused but kept for future kinds — agents lookup may inform fallback titles.
  void agents
  return ''
}

function deriveOutputPorts(node: WorkflowNode, agents: AgentSummary[]): string[] {
  if (node.kind === 'agent-single') {
    const rec = node as Record<string, unknown>
    const agentName = typeof rec.agentName === 'string' ? rec.agentName : ''
    const agent = agents.find((a) => a.name === agentName)
    const outputs = agent?.outputs ?? []
    if (outputs.length === 0) return ['out']
    return outputs.filter((n) => typeof n === 'string' && n.length > 0)
  }
  if (node.kind === 'review') {
    return ['output']
  }
  return []
}

export function loopMemberCandidates(
  wrapper: WorkflowNode,
  allNodes: WorkflowNode[],
  agents: AgentSummary[],
): LoopMemberCandidate[] {
  const innerIds = (wrapper as Record<string, unknown>).nodeIds
  const ids = Array.isArray(innerIds)
    ? innerIds.filter((s): s is string => typeof s === 'string')
    : []
  const idSet = new Set(ids)
  const result: LoopMemberCandidate[] = []
  for (const n of allNodes) {
    if (!idSet.has(n.id)) continue
    if (isWrapperKind(n.kind)) continue
    const outputPorts = deriveOutputPorts(n, agents)
    result.push({
      nodeId: n.id,
      title: deriveTitle(n, agents),
      outputPorts,
    })
  }
  return result
}
