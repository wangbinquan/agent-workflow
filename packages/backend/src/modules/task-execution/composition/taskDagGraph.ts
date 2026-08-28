// RFC-332 — DAG structural dependency and cycle owner.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  channelEdgeDataflowSkip,
  projectWorkflowDependency,
  resolveWorkflowSourceRef,
} from '@agent-workflow/shared'
import { parseExitCondition } from '../domain/loopExitCondition'

interface Binding {
  readonly name: string
  readonly bind: { readonly nodeId: string; readonly portName: string }
}

function readBindings(node: WorkflowNode, key: string): Binding[] {
  const value = (node as Record<string, unknown>)[key]
  if (!Array.isArray(value)) return []
  const bindings: Binding[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const itemRecord = item as Record<string, unknown>
    if (typeof itemRecord.name !== 'string') continue
    const bind = itemRecord.bind
    if (typeof bind !== 'object' || bind === null) continue
    const record = bind as Record<string, unknown>
    if (typeof record.nodeId !== 'string' || typeof record.portName !== 'string') continue
    bindings.push({
      name: itemRecord.name,
      bind: { nodeId: record.nodeId, portName: record.portName },
    })
  }
  return bindings
}

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

  for (const node of definition.nodes) {
    if (node.kind === 'review') {
      const input = (node as Record<string, unknown>).inputSource as
        | { nodeId?: unknown; portName?: unknown }
        | undefined
      if (input !== undefined && typeof input.nodeId === 'string') {
        const portName = typeof input.portName === 'string' ? input.portName : ''
        const resolved = resolveWorkflowSourceRef(
          definition,
          { nodeId: input.nodeId, portName },
          node.id,
          parents,
        )
        addProjected(resolved.ok ? resolved.source.nodeId : input.nodeId, node.id)
      }
    }
    if (node.kind === 'output') {
      for (const binding of readBindings(node, 'ports')) {
        const resolved = resolveWorkflowSourceRef(definition, binding.bind, node.id, parents)
        addProjected(resolved.ok ? resolved.source.nodeId : binding.bind.nodeId, node.id)
      }
    }
    if (node.kind === 'wrapper-loop') {
      const condition = parseExitCondition((node as Record<string, unknown>).exitCondition)
      if (condition !== null) addProjected(condition.nodeId, node.id)
      for (const binding of readBindings(node, 'outputBindings')) {
        addProjected(binding.bind.nodeId, node.id)
      }
    }
  }

  for (const list of upstreams.values()) list.sort()
  return upstreams
}
