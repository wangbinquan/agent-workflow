// RFC-332 — DAG structural dependency and cycle owner.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  channelEdgeDataflowSkip,
  projectWorkflowDependency,
  resolveWorkflowSourceRef,
} from '@agent-workflow/shared'

/**
 * Detect a cycle in one scope's structural upstream graph. The map contains
 * in-scope node ids only, so the depth-first walk cannot escape the scope.
 */
export function findScopeCycle(
  scopeNodes: WorkflowNode[],
  upstreamsOf: ReadonlyMap<string, readonly string[]>,
): string | null {
  const color = new Map<string, 0 | 1 | 2>()
  const visit = (id: string): string | null => {
    color.set(id, 1)
    for (const upstreamId of upstreamsOf.get(id) ?? []) {
      const upstreamColor = color.get(upstreamId) ?? 0
      if (upstreamColor === 1) return upstreamId
      if (upstreamColor === 0) {
        const found = visit(upstreamId)
        if (found !== null) return found
      }
    }
    color.set(id, 2)
    return null
  }
  for (const node of scopeNodes) {
    if ((color.get(node.id) ?? 0) !== 0) continue
    const found = visit(node.id)
    if (found !== null) return found
  }
  return null
}

/**
 * Build the structural dependency map for one recursive execution scope.
 * Flat workflow edges and implicit review/output/loop references are projected
 * to their direct representatives at the endpoint LCA.
 */
export function buildScopeUpstreams(
  definition: WorkflowDefinition,
  ids: Set<string>,
  scopeId: string | null,
  parents: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const scopeNodes = definition.nodes.filter((node) => ids.has(node.id))
  const upstreams = new Map<string, string[]>()
  for (const node of scopeNodes) upstreams.set(node.id, [])

  const kindById = new Map<string, string>()
  for (const node of definition.nodes) kindById.set(node.id, node.kind)

  const addProjected = (sourceNodeId: string, targetNodeId: string): void => {
    const projected = projectWorkflowDependency(sourceNodeId, targetNodeId, parents)
    if (projected === null || projected.scopeId !== scopeId) return
    if (projected.sourceNodeId === projected.targetNodeId) return
    if (!ids.has(projected.sourceNodeId) || !ids.has(projected.targetNodeId)) return
    const list = upstreams.get(projected.targetNodeId) ?? []
    if (!list.includes(projected.sourceNodeId)) list.push(projected.sourceNodeId)
    upstreams.set(projected.targetNodeId, list)
  }

  for (const edge of definition.edges) {
    if (edge.boundary !== undefined) continue
    if (channelEdgeDataflowSkip(edge, (id) => kindById.get(id))) continue
    const resolved = resolveWorkflowSourceRef(definition, edge.source, edge.target.nodeId, parents)
    addProjected(resolved.ok ? resolved.source.nodeId : edge.source.nodeId, edge.target.nodeId)
  }

  // RFC-354 (schema v6): review / output / loop dependencies are all edges now
  // (a loop's returns are `wrapper-output` boundary edges from its own body,
  // which the boundary skip above keeps out of the DAG exactly like fan-out's),
  // so no implicit-reference walk remains.

  for (const list of upstreams.values()) list.sort()
  return upstreams
}
