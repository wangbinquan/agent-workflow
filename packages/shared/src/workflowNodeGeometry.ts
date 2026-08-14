// RFC-302 — canonical workflow-node geometry shared by the editor and Intent.
//
// This module is deliberately free of DOM/React state. Imported or legacy
// definitions may omit positions, so every geometry consumer must use the same
// historical fallback grid rather than inventing its own coordinates.

import type { NodeKind } from './schemas/workflow'

export interface WorkflowPlacementPoint {
  readonly x: number
  readonly y: number
}

export interface WorkflowPlacementSize {
  readonly width: number
  readonly height: number
}

export interface WorkflowPositionSource {
  readonly position?: WorkflowPlacementPoint
}

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
 * Stable pre-measurement dimensions. Values intentionally match the canvas
 * card chrome and are also the deterministic sizes used by server-side Intent
 * layout, where no DOM measurements exist.
 */
export const DEFAULT_NODE_SIZE_BY_KIND: Record<NodeKind, WorkflowPlacementSize> = {
  'agent-single': { width: 280, height: 180 },
  input: { width: 220, height: 120 },
  output: { width: 220, height: 140 },
  review: { width: 280, height: 180 },
  clarify: { width: 240, height: 140 },
  'clarify-cross-agent': { width: 240, height: 160 },
  'wrapper-git': { width: 240, height: 160 },
  'wrapper-loop': { width: 240, height: 160 },
  'wrapper-fanout': { width: 240, height: 160 },
  'call-workflow': { width: 280, height: 180 },
  'call-workgroup': { width: 280, height: 180 },
  script: { width: 280, height: 180 },
  'code-host-call': { width: 280, height: 180 },
}
