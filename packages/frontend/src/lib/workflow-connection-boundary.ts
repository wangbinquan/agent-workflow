// RFC-199 B5 — wrapper boundary tagging shared by the planner, transition
// reconciler, and legacy drag adapter. Kept dependency-free from React/xyflow
// so planning stays pure and directly testable.
//
// RFC-354 (schema v6): a wrapper's parameters are its inbound edges and its
// return values are `wrapper-output` edges from a body member back to the
// wrapper — for fan-out (promoted outlets) and loop (returns) alike. There is
// no per-node port declaration left to keep in step; tagging the boundary IS
// the whole write.

import {
  isWrapperKind,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from '@agent-workflow/shared'

function memberIds(node: WorkflowNode | undefined): string[] {
  if (node === undefined || !isWrapperKind(node.kind)) return []
  const innerIds = (node as Record<string, unknown>).nodeIds
  return Array.isArray(innerIds)
    ? innerIds.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/**
 * Tag wrapper → inner crossings as runtime input boundaries. Every wrapper
 * kind hands its parameters to its body this way — a wrapper-git /
 * wrapper-loop parameter (declared by an ordinary inbound edge) reaches the
 * inner consumer through the same `wrapper-input` edge fan-out always used.
 */
export function markBoundaryWrapperInput(
  definition: WorkflowDefinition,
  edge: WorkflowEdge,
): WorkflowEdge {
  if (edge.boundary !== undefined) return edge
  const source = definition.nodes.find((node) => node.id === edge.source.nodeId)
  if (!memberIds(source).includes(edge.target.nodeId)) return edge
  return { ...edge, boundary: 'wrapper-input' }
}

/**
 * Tag inner → wrapper crossings as runtime output boundaries: a fan-out's
 * promoted aggregator outlet, or a loop's RETURN VALUE (RFC-354 — the target
 * port name is the return port the exit condition and downstream edges read).
 * wrapper-git has no returns (its single `git_diff` outlet is declared).
 */
export function markBoundaryWrapperOutput(
  definition: WorkflowDefinition,
  edge: WorkflowEdge,
): WorkflowEdge {
  if (edge.boundary !== undefined) return edge
  const target = definition.nodes.find((node) => node.id === edge.target.nodeId)
  if (
    target === undefined ||
    (target.kind !== 'wrapper-fanout' && target.kind !== 'wrapper-loop')
  ) {
    return edge
  }
  if (!memberIds(target).includes(edge.source.nodeId)) return edge
  return { ...edge, boundary: 'wrapper-output' }
}
