// RFC-199 B4/T7.7 — deterministic, geometry-only workflow-node placement.
//
// This module deliberately has no React/xyflow dependency. Callers provide
// canonical absolute positions plus resolved wrapper rectangles, and receive a
// canonical absolute top-left point back. Wrapper membership is selected only
// by the explicit scope/directWrapperNodeId fields; visual containment never
// creates membership.

export interface WorkflowPlacementPoint {
  readonly x: number
  readonly y: number
}

export interface WorkflowPlacementSize {
  readonly width: number
  readonly height: number
}

export interface WorkflowPlacementRect extends WorkflowPlacementPoint, WorkflowPlacementSize {}

export interface WorkflowPositionSource {
  readonly position?: WorkflowPlacementPoint
}

// Legacy / imported definitions may omit position. This is the historical
// renderer grid, now named here so rendering, placement inventory, wrapper
// geometry, and clipboard projection cannot fork their fallback coordinates.
const LEGACY_POSITION_COLUMNS = 4
const LEGACY_POSITION_ORIGIN = { x: 80, y: 80 } as const
const LEGACY_POSITION_STEP = { x: 280, y: 200 } as const

/** Resolve one definition node's canonical absolute position without mutating it. */
export function effectiveWorkflowNodePosition(
  node: WorkflowPositionSource,
  definitionIndex: number,
): WorkflowPlacementPoint {
  if (node.position !== undefined) {
    return { x: node.position.x, y: node.position.y }
  }
  return {
    x:
      LEGACY_POSITION_ORIGIN.x +
      (definitionIndex % LEGACY_POSITION_COLUMNS) * LEGACY_POSITION_STEP.x,
    y:
      LEGACY_POSITION_ORIGIN.y +
      Math.floor(definitionIndex / LEGACY_POSITION_COLUMNS) * LEGACY_POSITION_STEP.y,
  }
}

/**
 * Project a pointer-style anchor (drop cursor, viewport center) to the
 * candidate's top-left, so the inserted node is centered under the point the
 * user aimed at. Rounded because pointer coordinates pass through the flow
 * transform and pick up zoom fractions.
 */
export function centerAnchoredTopLeft(
  point: WorkflowPlacementPoint,
  size: WorkflowPlacementSize,
): WorkflowPlacementPoint {
  return {
    x: Math.round(point.x - size.width / 2),
    y: Math.round(point.y - size.height / 2),
  }
}

/** A definition node's canonical position and the two possible size sources.
 * A valid measured size wins; defaultSize is the required pre-measure fallback.
 * Wrappers may also be present here, but wrapperRects is authoritative for an
 * id that appears in both collections. */
export interface WorkflowPlacementNode {
  readonly id: string
  readonly position: WorkflowPlacementPoint
  readonly measuredSize?: WorkflowPlacementSize
  readonly defaultSize: WorkflowPlacementSize
  /** Explicit direct membership only. null/undefined means top-level. */
  readonly directWrapperNodeId?: string | null
}

/**
 * The usable wrapper rectangle in canonical absolute space. It occupies that
 * area in its parent scope and is the hard content bound for its own scope.
 */
export interface WorkflowPlacementWrapperRect extends WorkflowPlacementRect {
  readonly id: string
  /** Explicit direct membership for nested wrappers. */
  readonly directWrapperNodeId?: string | null
}

export type WorkflowPlacementScope =
  | { readonly kind: 'top-level' }
  | { readonly kind: 'wrapper'; readonly wrapperNodeId: string }

export interface FindOpenPlacementInput {
  /** Desired canonical absolute top-left point. */
  readonly desiredPoint: WorkflowPlacementPoint
  readonly candidateSize: WorkflowPlacementSize
  readonly scope: WorkflowPlacementScope
  readonly nodes: readonly WorkflowPlacementNode[]
  readonly wrapperRects: readonly WorkflowPlacementWrapperRect[]
  /** Required clear space between the candidate and every occupied rect. */
  readonly gap?: number
  /** Maximum Chebyshev shells (PLACEMENT_SEARCH_STEP px each) to inspect
   * after the desired point. */
  readonly maxRings?: number
}

const DEFAULT_GAP = 16
/** Candidate-scan granularity in px. Deliberately much smaller than a node so
 * a blocked drop nudges to the nearest open spot instead of teleporting a
 * full node-plus-gap stride away (the pre-fix behavior read as "the node runs
 * off on its own"). */
export const PLACEMENT_SEARCH_STEP = 16
/** 256 shells × 16px = 4096px search radius — beyond any realistic canvas
 * neighborhood while keeping a failed search bounded. */
const DEFAULT_MAX_RINGS = 256

function isFinitePoint(point: WorkflowPlacementPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function isValidSize(size: WorkflowPlacementSize | undefined): size is WorkflowPlacementSize {
  return (
    size !== undefined &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  )
}

function assertRect(rect: WorkflowPlacementRect, label: string): void {
  if (!isFinitePoint(rect) || !isValidSize(rect)) {
    throw new RangeError(`${label} must have finite x/y and positive finite width/height`)
  }
}

function belongsToScope(
  directWrapperNodeId: string | null | undefined,
  scope: WorkflowPlacementScope,
): boolean {
  if (scope.kind === 'top-level') return directWrapperNodeId == null
  return directWrapperNodeId === scope.wrapperNodeId
}

function resolveNodeRect(node: WorkflowPlacementNode): WorkflowPlacementRect {
  if (!isFinitePoint(node.position)) {
    throw new RangeError(`node ${node.id} must have a finite canonical position`)
  }
  if (!isValidSize(node.defaultSize)) {
    throw new RangeError(`node ${node.id} must have a positive finite default size`)
  }
  const size = isValidSize(node.measuredSize) ? node.measuredSize : node.defaultSize
  return { x: node.position.x, y: node.position.y, width: size.width, height: size.height }
}

function overlapsWithGap(
  candidate: WorkflowPlacementRect,
  occupied: WorkflowPlacementRect,
  gap: number,
): boolean {
  return (
    candidate.x < occupied.x + occupied.width + gap &&
    candidate.x + candidate.width + gap > occupied.x &&
    candidate.y < occupied.y + occupied.height + gap &&
    candidate.y + candidate.height + gap > occupied.y
  )
}

function containsRect(container: WorkflowPlacementRect, candidate: WorkflowPlacementRect): boolean {
  return (
    candidate.x >= container.x &&
    candidate.y >= container.y &&
    candidate.x + candidate.width <= container.x + container.width &&
    candidate.y + candidate.height <= container.y + container.height
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

interface GridOffset {
  readonly x: number
  readonly y: number
}

/** One rectangular-grid ring (Chebyshev shell), nearest-Euclidean first so a
 * blocked point resolves to the closest open spot; clockwise angle from the
 * positive X axis breaks distance ties deterministically. */
function spiralRing(ring: number): GridOffset[] {
  const entries: Array<{ offset: GridOffset; euclid: number; angle: number }> = []
  for (let y = -ring; y <= ring; y += 1) {
    for (let x = -ring; x <= ring; x += 1) {
      if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue
      entries.push({ offset: { x, y }, euclid: Math.hypot(x, y), angle: clockwiseAngle({ x, y }) })
    }
  }
  entries.sort((a, b) => {
    if (a.euclid !== b.euclid) return a.euclid - b.euclid
    if (a.angle !== b.angle) return a.angle - b.angle
    if (a.offset.x !== b.offset.x) return a.offset.x - b.offset.x
    return a.offset.y - b.offset.y
  })
  return entries.map((entry) => entry.offset)
}

function clockwiseAngle(offset: GridOffset): number {
  const angle = Math.atan2(offset.y, offset.x)
  return angle < 0 ? angle + Math.PI * 2 : angle
}

/**
 * Find the first collision-free canonical absolute top-left point.
 *
 * The desired point is tried first. Subsequent candidates scan outward in
 * PLACEMENT_SEARCH_STEP-sized Chebyshev shells, nearest-Euclidean first within
 * each shell, so a blocked point resolves to (approximately) the closest open
 * spot in a stable deterministic order — never a full node-stride teleport. At
 * top level, top-level wrapper rectangles are occupied so a visually-contained
 * but non-member node is never created. Inside a wrapper, only explicit direct
 * members are occupied; neither containment nor transitive descendants are
 * treated as membership authority. Wrapper-scoped candidates are additionally
 * constrained to the target wrapper's canonical content rectangle; a missing
 * target or insufficient content area fails explicitly.
 */
export function findOpenPlacement(input: FindOpenPlacementInput): WorkflowPlacementPoint {
  if (!isFinitePoint(input.desiredPoint)) {
    throw new RangeError('desiredPoint must contain finite coordinates')
  }
  if (!isValidSize(input.candidateSize)) {
    throw new RangeError('candidateSize must have positive finite width/height')
  }
  const gap = input.gap ?? DEFAULT_GAP
  if (!Number.isFinite(gap) || gap < 0) {
    throw new RangeError('gap must be a non-negative finite number')
  }
  const maxRings = input.maxRings ?? DEFAULT_MAX_RINGS
  if (!Number.isInteger(maxRings) || maxRings < 0) {
    throw new RangeError('maxRings must be a non-negative integer')
  }

  let wrapperContentBounds: WorkflowPlacementRect | undefined
  let searchOrigin = input.desiredPoint
  if (input.scope.kind === 'wrapper') {
    const targetWrapperId = input.scope.wrapperNodeId
    const matches = input.wrapperRects.filter((wrapper) => wrapper.id === targetWrapperId)
    if (matches.length !== 1) {
      throw new RangeError(
        matches.length === 0
          ? `target wrapper '${targetWrapperId}' is missing from wrapperRects`
          : `target wrapper '${targetWrapperId}' is not unique in wrapperRects`,
      )
    }
    const target = matches[0]!
    assertRect(target, `target wrapper ${target.id}`)
    wrapperContentBounds = {
      x: target.x,
      y: target.y,
      width: target.width,
      height: target.height,
    }
    const maxX = target.x + target.width - input.candidateSize.width
    const maxY = target.y + target.height - input.candidateSize.height
    if (maxX < target.x || maxY < target.y) {
      throw new RangeError(
        `wrapper '${target.id}' content bounds cannot fit the placement candidate`,
      )
    }
    searchOrigin = {
      x: clamp(input.desiredPoint.x, target.x, maxX),
      y: clamp(input.desiredPoint.y, target.y, maxY),
    }
  }

  // Wrapper rectangles are authoritative for wrapper ids, avoiding a second
  // collision rect built from a wrapper's stale position/default size.
  const wrapperIds = new Set(input.wrapperRects.map((wrapper) => wrapper.id))
  const occupied: WorkflowPlacementRect[] = []
  for (const node of input.nodes) {
    if (wrapperIds.has(node.id)) continue
    if (!belongsToScope(node.directWrapperNodeId, input.scope)) continue
    occupied.push(resolveNodeRect(node))
  }
  for (const wrapper of input.wrapperRects) {
    if (!belongsToScope(wrapper.directWrapperNodeId, input.scope)) continue
    assertRect(wrapper, `wrapper ${wrapper.id}`)
    occupied.push({
      x: wrapper.x,
      y: wrapper.y,
      width: wrapper.width,
      height: wrapper.height,
    })
  }

  const isOpen = (point: WorkflowPlacementPoint): boolean => {
    const candidate: WorkflowPlacementRect = {
      x: point.x,
      y: point.y,
      width: input.candidateSize.width,
      height: input.candidateSize.height,
    }
    if (wrapperContentBounds !== undefined && !containsRect(wrapperContentBounds, candidate)) {
      return false
    }
    return occupied.every((rect) => !overlapsWithGap(candidate, rect, gap))
  }

  if (isOpen(searchOrigin)) {
    return { x: searchOrigin.x, y: searchOrigin.y }
  }

  // Inside a wrapper the clamped origin plus any offset beyond the wrapper's
  // own extent is out of bounds by construction — cap the shells accordingly
  // so a full wrapper fails fast instead of scanning the whole radius.
  const ringCap =
    wrapperContentBounds === undefined
      ? maxRings
      : Math.min(
          maxRings,
          Math.ceil(
            Math.max(wrapperContentBounds.width, wrapperContentBounds.height) /
              PLACEMENT_SEARCH_STEP,
          ) + 1,
        )
  for (let ring = 1; ring <= ringCap; ring += 1) {
    for (const offset of spiralRing(ring)) {
      const point = {
        x: searchOrigin.x + offset.x * PLACEMENT_SEARCH_STEP,
        y: searchOrigin.y + offset.y * PLACEMENT_SEARCH_STEP,
      }
      if (isOpen(point)) return point
    }
  }

  throw new RangeError(
    input.scope.kind === 'wrapper'
      ? `no open workflow placement found within wrapper '${input.scope.wrapperNodeId}' content bounds`
      : `no open workflow placement found within ${maxRings} spiral rings`,
  )
}
