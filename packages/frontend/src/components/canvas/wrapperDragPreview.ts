// Live wrapper-membership preview for WorkflowCanvas node dragging.
//
// This module deliberately changes only xyflow node.data. Persisted workflow
// membership, coordinates, wrapper sizes, and the undo stack stay untouched
// until onNodeDragStop. GroupWrapperNode renders the returned rectangle as a
// visual transform inside the wrapper's fixed xyflow shell, which lets the
// wrapper appear to grow around the candidate without re-parenting the node
// mid-gesture (re-parenting changes coordinate systems and makes it jump).

import { isWrapperKind } from '@agent-workflow/shared'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { Node } from '@xyflow/react'
import { projectXyflowPositionsToAbsolute, resolveWrappers } from './coordProjection'
import {
  applyMembershipPatch,
  resolveMembershipOnDragStop,
  resolveWrapperDropTargetId,
  wrapperDescendantIds,
  type WrapperHitInput,
} from './wrapperMembership'
import {
  buildWrapperPortMinimumSizes,
  computeFitBounds,
  DEFAULT_NODE_SIZE_BY_KIND,
} from './wrapperFit'

export type WrapperDragPreviewState = 'accept' | 'leave'

/** Local-only data consumed by GroupWrapperNode during a node drag. */
export interface WrapperDragPreview {
  state: WrapperDragPreviewState
  /** Visual offset from the wrapper's unchanged xyflow top-left. */
  offsetX?: number
  offsetY?: number
  /** Preview rectangle dimensions. Present for an accepting wrapper. */
  width?: number
  height?: number
}

export const WRAPPER_DRAG_PREVIEW_DATA_KEY = 'wrapperDragPreview'

interface PreviewArgs {
  definition: WorkflowDefinition
  flowNodes: Node[]
  draggedNodeIds: readonly string[]
  measuredSizes?: Map<string, { width: number; height: number }>
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined
}

function flowNodeSize(
  flowNode: Node,
  kind: WorkflowNode['kind'],
  measuredSizes: Map<string, { width: number; height: number }> | undefined,
): { width: number; height: number } {
  const measured = measuredSizes?.get(flowNode.id)
  if (measured !== undefined) return measured
  const style = flowNode.style as { width?: unknown; height?: unknown } | undefined
  const width =
    positiveNumber(style?.width) ??
    positiveNumber(flowNode.measured?.width) ??
    positiveNumber(flowNode.width)
  const height =
    positiveNumber(style?.height) ??
    positiveNumber(flowNode.measured?.height) ??
    positiveNumber(flowNode.height)
  if (width !== undefined && height !== undefined) return { width, height }
  return DEFAULT_NODE_SIZE_BY_KIND[kind] ?? { width: 240, height: 120 }
}

/** Mirror current xyflow positions (and resolved wrapper rectangles) into a
 * detached definition used only for fit calculation. */
function definitionWithLiveGeometry(
  definition: WorkflowDefinition,
  flowNodes: Node[],
  measuredSizes: Map<string, { width: number; height: number }> | undefined,
): WorkflowDefinition {
  const absolute = projectXyflowPositionsToAbsolute(definition, flowNodes, measuredSizes)
  const absoluteById = new Map(absolute.map((node) => [node.id, node.position] as const))
  const flowById = new Map(flowNodes.map((node) => [node.id, node] as const))

  const nodes = definition.nodes.map((node) => {
    const position = absoluteById.get(node.id)
    let next =
      position === undefined
        ? node
        : ({ ...node, position: { x: position.x, y: position.y } } as WorkflowNode)
    if (!isWrapperKind(node.kind)) return next

    const flowNode = flowById.get(node.id)
    if (flowNode === undefined) return next
    const style = flowNode.style as { width?: unknown; height?: unknown } | undefined
    const width = positiveNumber(style?.width)
    const height = positiveNumber(style?.height)
    if (width === undefined || height === undefined) return next

    const previousSize = (node as Record<string, unknown>).size as
      | { sizeLocked?: unknown }
      | undefined
    const size =
      previousSize?.sizeLocked === true ? { width, height, sizeLocked: true } : { width, height }
    next = { ...(next as unknown as Record<string, unknown>), size } as unknown as WorkflowNode
    return next
  })
  return { ...definition, nodes }
}

function wrapperInputs(
  definition: WorkflowDefinition,
  baseRects: ReturnType<typeof resolveWrappers>,
): WrapperHitInput[] {
  const byId = new Map(definition.nodes.map((node) => [node.id, node] as const))
  return [...baseRects.values()].map((wrapper) => {
    const current = byId.get(wrapper.id) as (WorkflowNode & { nodeIds?: unknown }) | undefined
    const nodeIds = Array.isArray(current?.nodeIds)
      ? current.nodeIds.filter((id): id is string => typeof id === 'string')
      : []
    return {
      id: wrapper.id,
      rect: {
        x: wrapper.position.x,
        y: wrapper.position.y,
        width: wrapper.width,
        height: wrapper.height,
      },
      nodeIds,
    }
  })
}

/** Compute the visual state for wrappers during this drag frame. Hit-testing
 * always uses the unchanged base rectangles, not the expanded preview. This
 * prevents a wrapper from becoming "sticky" and growing forever once the
 * pointer leaves its real drop area. */
export function computeWrapperDragPreviews(args: PreviewArgs): Map<string, WrapperDragPreview> {
  const { definition, flowNodes, draggedNodeIds, measuredSizes } = args
  if (draggedNodeIds.length === 0) return new Map()

  let previewDefinition = definitionWithLiveGeometry(definition, flowNodes, measuredSizes)
  const minimumSizes = buildWrapperPortMinimumSizes(flowNodes)
  const baseRects = resolveWrappers(previewDefinition, measuredSizes, minimumSizes)
  const flowById = new Map(flowNodes.map((node) => [node.id, node] as const))
  const absolute = projectXyflowPositionsToAbsolute(definition, flowNodes, measuredSizes)
  const absoluteById = new Map(absolute.map((node) => [node.id, node.position] as const))
  const accepting = new Set<string>()
  const leaving = new Set<string>()

  for (const draggedNodeId of draggedNodeIds) {
    const draggedFlowNode = flowById.get(draggedNodeId)
    const draggedWorkflowNode = previewDefinition.nodes.find((node) => node.id === draggedNodeId)
    const position = absoluteById.get(draggedNodeId)
    if (
      draggedFlowNode === undefined ||
      draggedWorkflowNode === undefined ||
      position === undefined
    ) {
      continue
    }

    const size = flowNodeSize(draggedFlowNode, draggedWorkflowNode.kind, measuredSizes)
    const draggedCenter = {
      x: position.x + size.width / 2,
      y: position.y + size.height / 2,
    }
    const blockedWrapperIds = isWrapperKind(draggedWorkflowNode.kind)
      ? wrapperDescendantIds(previewDefinition, draggedNodeId)
      : undefined
    const wrappers = wrapperInputs(previewDefinition, baseRects)
    const targetId = resolveWrapperDropTargetId({
      draggedNodeId,
      draggedCenter,
      wrappers,
      blockedWrapperIds,
    })
    const patch = resolveMembershipOnDragStop({
      draggedNodeId,
      draggedCenter,
      wrappers,
      blockedWrapperIds,
    })

    if (targetId !== null) accepting.add(targetId)
    if (patch.leaveWrapperId !== null && patch.leaveWrapperId !== targetId) {
      leaving.add(patch.leaveWrapperId)
    }
    previewDefinition = applyMembershipPatch(previewDefinition, patch)
  }

  const previews = new Map<string, WrapperDragPreview>()
  for (const wrapperId of leaving) {
    if (!accepting.has(wrapperId)) previews.set(wrapperId, { state: 'leave' })
  }
  for (const wrapperId of accepting) {
    const wrapper = previewDefinition.nodes.find((node) => node.id === wrapperId)
    const base = baseRects.get(wrapperId)
    if (wrapper === undefined || base === undefined) continue
    const size = (wrapper as Record<string, unknown>).size as { sizeLocked?: unknown } | undefined
    const rect =
      size?.sizeLocked === true
        ? {
            offset: base.position,
            width: base.width,
            height: base.height,
          }
        : computeFitBounds(wrapper, previewDefinition.nodes, undefined, measuredSizes, minimumSizes)
    previews.set(wrapperId, {
      state: 'accept',
      offsetX: Math.round(rect.offset.x - base.position.x),
      offsetY: Math.round(rect.offset.y - base.position.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    })
  }
  return previews
}

function previewsEqual(a: unknown, b: WrapperDragPreview | undefined): boolean {
  if (a === b) return true
  if (a === null || typeof a !== 'object' || b === undefined) return false
  const previous = a as WrapperDragPreview
  return (
    previous.state === b.state &&
    previous.offsetX === b.offsetX &&
    previous.offsetY === b.offsetY &&
    previous.width === b.width &&
    previous.height === b.height
  )
}

/** Attach preview data without disturbing positions, parentIds, measurements,
 * or selection. Returns the original array when the preview is unchanged. */
export function applyWrapperDragPreviews(
  flowNodes: Node[],
  previews: ReadonlyMap<string, WrapperDragPreview>,
): Node[] {
  let changed = false
  const next = flowNodes.map((node) => {
    if (!isWrapperKind(node.type)) return node
    const data = node.data as Record<string, unknown>
    const preview = previews.get(node.id)
    const previous = data[WRAPPER_DRAG_PREVIEW_DATA_KEY]
    if (preview === undefined && previous === undefined) return node
    if (preview !== undefined && previewsEqual(previous, preview)) return node

    const nextData = { ...data }
    if (preview === undefined) delete nextData[WRAPPER_DRAG_PREVIEW_DATA_KEY]
    else nextData[WRAPPER_DRAG_PREVIEW_DATA_KEY] = preview
    changed = true
    return { ...node, data: nextData }
  })
  return changed ? next : flowNodes
}

export function clearWrapperDragPreviews(flowNodes: Node[]): Node[] {
  return applyWrapperDragPreviews(flowNodes, new Map())
}
