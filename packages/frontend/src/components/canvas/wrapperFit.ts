// RFC-302 — wrapper geometry is canonical in @agent-workflow/shared.
// This frontend adapter owns only chrome-derived minimum sizes for rendered
// port labels, then re-exports the pure primitives for existing canvas callers.

import {
  isWrapperKind,
  WRAPPER_EMPTY_MIN_HEIGHT,
  WRAPPER_EMPTY_MIN_WIDTH,
  type WrapperMinimumSize,
} from '@agent-workflow/shared'

export {
  AUTO_FIT_BOTTOM_CLEARANCE,
  AUTO_FIT_HANDLE_SLACK,
  AUTO_FIT_LEFT_CLEARANCE,
  AUTO_FIT_RIGHT_CLEARANCE,
  AUTO_FIT_TOP_CLEARANCE,
  computeFitBounds,
  DEFAULT_NODE_SIZE_BY_KIND,
  fitWrapperToInner,
  WRAPPER_DEFAULT_PADDING,
  WRAPPER_EMPTY_MIN_HEIGHT,
  WRAPPER_EMPTY_MIN_WIDTH,
  WRAPPER_HEADER_HEIGHT,
} from '@agent-workflow/shared'
export type {
  WorkflowWrapperFitBounds,
  WrapperMinimumSize,
  WrapperMinimumSizes,
} from '@agent-workflow/shared'

// Wrapper-git / wrapper-loop output handles sit in one bottom row. These
// values mirror `.canvas-node__bottom-ports` and `.canvas-node__port-label`.
const BOTTOM_PORTS_HORIZONTAL_PADDING = 20
const BOTTOM_PORT_GAP = 16
const PORT_LABEL_HORIZONTAL_PADDING = 8
const PORT_LABEL_MAX_WIDTH = 140
const PORT_LABEL_ASCII_GLYPH_WIDTH = 8
const PORT_LABEL_WIDE_GLYPH_WIDTH = 13

// Wrapper-fanout boundary ports stack down each side.
const SIDE_PORT_ROW_HEIGHT = 28
const SIDE_PORT_GAP = 6
const SIDE_PORT_TOP = 30
const SIDE_PORT_BOTTOM = 6

function portNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((port): port is string => typeof port === 'string')
    : []
}

function estimatedPortLabelWidth(port: string): number {
  let contentWidth = 0
  for (const glyph of Array.from(port)) {
    contentWidth += /^[\x20-\x7e]$/.test(glyph)
      ? PORT_LABEL_ASCII_GLYPH_WIDTH
      : PORT_LABEL_WIDE_GLYPH_WIDTH
  }
  return (
    Math.min(PORT_LABEL_MAX_WIDTH, Math.max(PORT_LABEL_ASCII_GLYPH_WIDTH, contentWidth)) +
    PORT_LABEL_HORIZONTAL_PADDING
  )
}

/** Derive intrinsic constraints from the ports the canvas actually renders. */
export function buildWrapperPortMinimumSizes(
  flowNodes: ReadonlyArray<{ id: string; type?: string; data: unknown }>,
): Map<string, WrapperMinimumSize> {
  const out = new Map<string, WrapperMinimumSize>()
  for (const node of flowNodes) {
    if (!isWrapperKind(node.type)) continue
    const data =
      node.data !== null && typeof node.data === 'object'
        ? (node.data as Record<string, unknown>)
        : {}
    const inputs = portNames(data.inputPorts)
    const outputs = portNames(data.outputPorts)
    let width = WRAPPER_EMPTY_MIN_WIDTH
    let height = WRAPPER_EMPTY_MIN_HEIGHT

    if (node.type === 'wrapper-fanout') {
      const sideCount = Math.max(inputs.length, outputs.length)
      if (sideCount > 0) {
        height = Math.max(
          height,
          SIDE_PORT_TOP +
            SIDE_PORT_BOTTOM +
            sideCount * SIDE_PORT_ROW_HEIGHT +
            Math.max(0, sideCount - 1) * SIDE_PORT_GAP,
        )
      }
    } else if (outputs.length > 0) {
      width = Math.max(
        width,
        BOTTOM_PORTS_HORIZONTAL_PADDING +
          outputs.reduce((sum, port) => sum + estimatedPortLabelWidth(port), 0) +
          Math.max(0, outputs.length - 1) * BOTTOM_PORT_GAP,
      )
    }

    if (width > WRAPPER_EMPTY_MIN_WIDTH || height > WRAPPER_EMPTY_MIN_HEIGHT) {
      out.set(node.id, { width: Math.round(width), height: Math.round(height) })
    }
  }
  return out
}
