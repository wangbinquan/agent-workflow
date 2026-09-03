// RFC-199 B5 — wrapper-fanout connection semantics shared by the planner,
// transition reconciler, and legacy drag adapter. Kept dependency-free from
// React/xyflow so planning stays pure and directly testable.

import {
  isWrapperKind,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@agent-workflow/shared'

/**
 * Tag wrapper → inner crossings as runtime input boundaries. RFC-354: every
 * wrapper kind hands its parameters to its body this way — a wrapper-git /
 * wrapper-loop parameter (declared by an ordinary inbound edge) reaches the
 * inner consumer through the same `wrapper-input` edge fan-out always used.
 */
export function markBoundaryWrapperInput(
  definition: WorkflowDefinition,
  edge: WorkflowEdge,
): WorkflowEdge {
  if (edge.boundary !== undefined) return edge
  const source = definition.nodes.find((node) => node.id === edge.source.nodeId)
  if (source === undefined || !isWrapperKind(source.kind)) return edge
  const innerIds = (source as Record<string, unknown>).nodeIds
  const memberIds = Array.isArray(innerIds)
    ? innerIds.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (!memberIds.includes(edge.target.nodeId)) return edge
  return { ...edge, boundary: 'wrapper-input' }
}

/** Tag inner → wrapper crossings as runtime fan-out output boundaries. */
export function markBoundaryWrapperOutput(
  definition: WorkflowDefinition,
  edge: WorkflowEdge,
): WorkflowEdge {
  if (edge.boundary !== undefined) return edge
  const target = definition.nodes.find((node) => node.id === edge.target.nodeId)
  if (target === undefined || target.kind !== 'wrapper-fanout') return edge
  const innerIds = (target as Record<string, unknown>).nodeIds
  const memberIds = Array.isArray(innerIds)
    ? innerIds.filter((entry): entry is string => typeof entry === 'string')
    : []
  if (!memberIds.includes(edge.source.nodeId)) return edge
  return { ...edge, boundary: 'wrapper-output' }
}

/**
 * Legacy drag compatibility: older handle/body drops inferred a missing
 * fan-out input as list<string> for the first port and string thereafter.
 * Guided RFC-199 requests carry explicit kind and shard/broadcast role and do
 * not call this helper.
 */
export function ensureLegacyWrapperFanoutInputForEdge(
  previous: WorkflowDefinition,
  edge: WorkflowEdge,
): WorkflowDefinition {
  const target = previous.nodes.find((node) => node.id === edge.target.nodeId)
  if (target === undefined || target.kind !== 'wrapper-fanout') return previous
  const record = target as unknown as Record<string, unknown>
  const inputs = Array.isArray(record.inputs)
    ? (record.inputs as Array<{ name?: unknown; kind?: unknown; isShardSource?: unknown }>)
    : []
  if (inputs.some((port) => port.name === edge.target.portName)) return previous
  const hasShardSource = inputs.some((port) => port.isShardSource === true)
  const newPort = hasShardSource
    ? { name: edge.target.portName, kind: 'string' }
    : { name: edge.target.portName, kind: 'list<string>', isShardSource: true }
  const nodes = previous.nodes.map((node) =>
    node.id === edge.target.nodeId
      ? ({
          ...(node as Record<string, unknown>),
          inputs: [...inputs, newPort],
        } as unknown as WorkflowNode)
      : node,
  )
  return { ...previous, nodes }
}

/** Historical export name retained for existing consumers/tests. */
export const ensureWrapperFanoutInputForEdge = ensureLegacyWrapperFanoutInputForEdge
