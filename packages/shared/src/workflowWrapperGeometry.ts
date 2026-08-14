// RFC-302 — pure wrapper geometry shared by the editor and Intent planner.
// Presentation-only port-label minimums stay in frontend/wrapperFit.ts.

import { isWrapperKind, type WorkflowDefinition, type WorkflowNode } from './schemas/workflow'
import {
  DEFAULT_NODE_SIZE_BY_KIND,
  effectiveWorkflowNodePosition,
  type WorkflowPlacementPoint,
} from './workflowNodeGeometry'

/** Header strip height (matches `.canvas-node__header`). */
export const WRAPPER_HEADER_HEIGHT = 22
/** Default padding around inner content within the wrapper rect. */
export const WRAPPER_DEFAULT_PADDING = 40
/** Minimum rendered size when a wrapper holds zero inner nodes. */
export const WRAPPER_EMPTY_MIN_WIDTH = 200
export const WRAPPER_EMPTY_MIN_HEIGHT = 120

export interface WrapperMinimumSize {
  width: number
  height: number
}

export type WrapperMinimumSizes = ReadonlyMap<string, WrapperMinimumSize>

export interface WorkflowWrapperFitBounds {
  width: number
  height: number
  /** Suggested wrapper top-left so inner nodes land inside the clearances. */
  offset: WorkflowPlacementPoint
}

interface NodeRect extends WorkflowPlacementPoint {
  width: number
  height: number
}

function effectivePositionInDefinition(
  node: WorkflowNode,
  allNodes: readonly WorkflowNode[],
): WorkflowPlacementPoint {
  const index = allNodes.findIndex((candidate) => candidate.id === node.id)
  return effectiveWorkflowNodePosition(node, index < 0 ? 0 : index)
}

function nodeSize(
  node: WorkflowNode,
  measuredSizes?: Map<string, { width: number; height: number }>,
): { width: number; height: number } {
  const measured = measuredSizes?.get(node.id)
  if (measured !== undefined && measured.width > 0 && measured.height > 0) return measured
  const size = (node as Record<string, unknown>).size as
    | { width?: unknown; height?: unknown }
    | undefined
  if (
    size !== undefined &&
    typeof size.width === 'number' &&
    typeof size.height === 'number' &&
    size.width > 0 &&
    size.height > 0
  ) {
    return { width: size.width, height: size.height }
  }
  return DEFAULT_NODE_SIZE_BY_KIND[node.kind] ?? { width: 200, height: 100 }
}

function hasPersistedSize(node: WorkflowNode): boolean {
  const size = (node as Record<string, unknown>).size as
    | { width?: unknown; height?: unknown }
    | undefined
  return (
    size !== undefined &&
    typeof size.width === 'number' &&
    typeof size.height === 'number' &&
    size.width > 0 &&
    size.height > 0
  )
}

function hasLockedSize(node: WorkflowNode): boolean {
  const size = (node as Record<string, unknown>).size as { sizeLocked?: unknown } | undefined
  return size?.sizeLocked === true
}

function applyMinimumSize(
  node: WorkflowNode,
  size: { width: number; height: number },
  minimumSizes: WrapperMinimumSizes | undefined,
): { width: number; height: number } {
  if (!isWrapperKind(node.kind) || hasLockedSize(node)) return size
  const minimum = minimumSizes?.get(node.id)
  if (minimum === undefined) return size
  return {
    width: Math.max(size.width, minimum.width),
    height: Math.max(size.height, minimum.height),
  }
}

function applyMinimumFit(
  wrapper: WorkflowNode,
  fit: WorkflowWrapperFitBounds,
  minimumSizes: WrapperMinimumSizes | undefined,
): WorkflowWrapperFitBounds {
  const size = applyMinimumSize(wrapper, fit, minimumSizes)
  return size.width === fit.width && size.height === fit.height ? fit : { ...fit, ...size }
}

function resolveNodeRect(
  node: WorkflowNode,
  allNodes: WorkflowNode[],
  padding: number,
  measuredSizes: Map<string, { width: number; height: number }> | undefined,
  resolvingWrappers: Set<string>,
  minimumSizes: WrapperMinimumSizes | undefined,
): NodeRect {
  if (isWrapperKind(node.kind) && !hasPersistedSize(node) && !resolvingWrappers.has(node.id)) {
    resolvingWrappers.add(node.id)
    const fit = computeFitBoundsInternal(
      node,
      allNodes,
      padding,
      measuredSizes,
      resolvingWrappers,
      minimumSizes,
    )
    resolvingWrappers.delete(node.id)
    return { x: fit.offset.x, y: fit.offset.y, width: fit.width, height: fit.height }
  }

  const position = effectivePositionInDefinition(node, allNodes)
  const size = applyMinimumSize(node, nodeSize(node, measuredSizes), minimumSizes)
  return { x: position.x, y: position.y, width: size.width, height: size.height }
}

function computeFitBoundsInternal(
  wrapper: WorkflowNode,
  allNodes: WorkflowNode[],
  padding: number,
  measuredSizes: Map<string, { width: number; height: number }> | undefined,
  resolvingWrappers: Set<string>,
  minimumSizes: WrapperMinimumSizes | undefined,
): WorkflowWrapperFitBounds {
  const innerIds = (wrapper as Record<string, unknown>).nodeIds
  const ids = Array.isArray(innerIds)
    ? innerIds.filter((id): id is string => typeof id === 'string')
    : []
  const idSet = new Set(ids)
  const inner = allNodes.filter((node) => idSet.has(node.id))

  if (inner.length === 0) {
    const position = effectivePositionInDefinition(wrapper, allNodes)
    return applyMinimumFit(
      wrapper,
      {
        width: WRAPPER_EMPTY_MIN_WIDTH,
        height: WRAPPER_EMPTY_MIN_HEIGHT,
        offset: { x: position.x, y: position.y },
      },
      minimumSizes,
    )
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of inner) {
    const rect = resolveNodeRect(
      node,
      allNodes,
      padding,
      measuredSizes,
      resolvingWrappers,
      minimumSizes,
    )
    if (rect.x < minX) minX = rect.x
    if (rect.y < minY) minY = rect.y
    if (rect.x + rect.width > maxX) maxX = rect.x + rect.width
    if (rect.y + rect.height > maxY) maxY = rect.y + rect.height
  }

  const handleSlack = 16
  const width = Math.max(
    WRAPPER_EMPTY_MIN_WIDTH,
    Math.round(maxX - minX + padding * 2 + handleSlack * 2),
  )
  const height = Math.max(
    WRAPPER_EMPTY_MIN_HEIGHT,
    Math.round(maxY - minY + padding * 2 + WRAPPER_HEADER_HEIGHT),
  )
  const offset = {
    x: Math.round(minX - padding - handleSlack),
    y: Math.round(minY - padding - WRAPPER_HEADER_HEIGHT),
  }
  return applyMinimumFit(wrapper, { width, height, offset }, minimumSizes)
}

export function computeFitBounds(
  wrapper: WorkflowNode,
  allNodes: WorkflowNode[],
  padding: number = WRAPPER_DEFAULT_PADDING,
  measuredSizes?: Map<string, { width: number; height: number }>,
  minimumSizes?: WrapperMinimumSizes,
): WorkflowWrapperFitBounds {
  return computeFitBoundsInternal(
    wrapper,
    allNodes,
    padding,
    measuredSizes,
    new Set([wrapper.id]),
    minimumSizes,
  )
}

export const AUTO_FIT_HANDLE_SLACK = 16
export const AUTO_FIT_LEFT_CLEARANCE = WRAPPER_DEFAULT_PADDING + AUTO_FIT_HANDLE_SLACK
export const AUTO_FIT_RIGHT_CLEARANCE = WRAPPER_DEFAULT_PADDING + AUTO_FIT_HANDLE_SLACK
export const AUTO_FIT_TOP_CLEARANCE = WRAPPER_DEFAULT_PADDING + WRAPPER_HEADER_HEIGHT
export const AUTO_FIT_BOTTOM_CLEARANCE = WRAPPER_DEFAULT_PADDING

/** Fit an unlocked persisted wrapper to the absolute bbox of its direct children. */
export function fitWrapperToInner(
  prevDef: WorkflowDefinition,
  wrapperId: string,
  measuredSizes?: Map<string, { width: number; height: number }>,
  minimumSizes?: WrapperMinimumSizes,
): WorkflowDefinition {
  const target = prevDef.nodes.find((node) => node.id === wrapperId)
  if (target === undefined || !isWrapperKind(target.kind)) return prevDef
  const record = target as Record<string, unknown>
  const sizeRecord = record.size as
    | { width?: unknown; height?: unknown; sizeLocked?: unknown }
    | undefined
  if (
    sizeRecord === undefined ||
    sizeRecord.sizeLocked === true ||
    typeof sizeRecord.width !== 'number' ||
    typeof sizeRecord.height !== 'number'
  ) {
    return prevDef
  }

  const innerIdsRaw = record.nodeIds
  const innerIds = Array.isArray(innerIdsRaw)
    ? innerIdsRaw.filter((id): id is string => typeof id === 'string')
    : []
  if (innerIds.length === 0) {
    const minimum = minimumSizes?.get(wrapperId)
    if (
      minimum === undefined ||
      (sizeRecord.width >= minimum.width && sizeRecord.height >= minimum.height)
    ) {
      return prevDef
    }
    return {
      ...prevDef,
      nodes: prevDef.nodes.map((node) =>
        node.id === wrapperId
          ? ({
              ...(node as unknown as Record<string, unknown>),
              size: {
                width: Math.max(sizeRecord.width as number, minimum.width),
                height: Math.max(sizeRecord.height as number, minimum.height),
              },
            } as unknown as WorkflowNode)
          : node,
      ),
    }
  }

  const innerIdSet = new Set(innerIds)
  const inner = prevDef.nodes.filter((node) => innerIdSet.has(node.id))
  if (inner.length === 0) return prevDef

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  const resolvingWrappers = new Set([target.id])
  for (const node of inner) {
    const rect = resolveNodeRect(
      node,
      prevDef.nodes,
      WRAPPER_DEFAULT_PADDING,
      measuredSizes,
      resolvingWrappers,
      minimumSizes,
    )
    if (rect.x < minX) minX = rect.x
    if (rect.y < minY) minY = rect.y
    if (rect.x + rect.width > maxX) maxX = rect.x + rect.width
    if (rect.y + rect.height > maxY) maxY = rect.y + rect.height
  }

  const needLeft = minX - AUTO_FIT_LEFT_CLEARANCE
  const needTop = minY - AUTO_FIT_TOP_CLEARANCE
  let needRight = maxX + AUTO_FIT_RIGHT_CLEARANCE
  let needBottom = maxY + AUTO_FIT_BOTTOM_CLEARANCE
  const minimum = minimumSizes?.get(wrapperId)
  if (minimum !== undefined) {
    needRight = Math.max(needRight, needLeft + minimum.width)
    needBottom = Math.max(needBottom, needTop + minimum.height)
  }

  const position = effectivePositionInDefinition(target, prevDef.nodes)
  if (
    needLeft === position.x &&
    needTop === position.y &&
    needRight === position.x + sizeRecord.width &&
    needBottom === position.y + sizeRecord.height
  ) {
    return prevDef
  }

  const nextPosition = { x: Math.round(needLeft), y: Math.round(needTop) }
  const nextSize = {
    width: Math.round(needRight - needLeft),
    height: Math.round(needBottom - needTop),
  }
  return {
    ...prevDef,
    nodes: prevDef.nodes.map((node) =>
      node.id === wrapperId
        ? ({
            ...(node as Record<string, unknown>),
            position: nextPosition,
            size: nextSize,
          } as unknown as WorkflowNode)
        : node,
    ),
  }
}
