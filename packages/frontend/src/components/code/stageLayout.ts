// RFC-307 — laying a capability's stage sequence out on a canvas.
//
// Split out from the renderer and kept pure because layout is the part with
// actual rules in it, and rules that live inside a React component get verified
// by squinting at a screenshot. Everything here is a function of the graph.
//
// The shape being laid out is not a free-form DAG. Stages RUN in array order —
// that is the contract's whole point — so the sequence is a spine, and the
// edges are data dependencies drawn over it. Two consequences:
//
//   · x is the stage's position in the sequence. Reading left to right is
//     reading run order, which is the first question anyone asks of a flow.
//   · a dependency that skips over intervening stages (`ledger` reading
//     `published` from four stages back) is a real feature of the contract, not
//     a layout failure. Those get a lane above the spine so they read as
//     "carried forward" instead of crossing through the cards.

export type StageLayoutKind = 'program' | 'script' | 'ai' | 'invoke'

export interface StageLayoutNode {
  name: string
  kind: StageLayoutKind
  index: number
  x: number
  y: number
}

export interface StageLayoutEdge {
  id: string
  from: string
  to: string
  artifact: string
  /** True when the edge skips at least one stage — drawn as a carried lane. */
  carried: boolean
}

export interface StageLayout {
  nodes: readonly StageLayoutNode[]
  edges: readonly StageLayoutEdge[]
  width: number
  height: number
}

/** Card pitch. Wide enough that a stage name is readable without hover. */
export const STAGE_X_PITCH = 260
export const STAGE_CARD_WIDTH = 200
/** Rows per wrap. Thirteen stages in one line is a horizontal scrollbar. */
export const STAGE_PER_ROW = 5
export const STAGE_Y_PITCH = 190

export interface StageLayoutInput {
  nodes: readonly { name: string; kind: StageLayoutKind; index: number }[]
  edges: readonly { id: string; from: string; to: string; artifact: string }[]
}

/**
 * Place stages in run order, wrapping into rows.
 *
 * Boustrophedon — alternate rows run right-to-left — so the last card of one
 * row sits directly above the first card of the next. Wrapping left-to-right
 * every row would send a long connector back across the whole canvas at every
 * wrap, which is exactly the "spaghetti" that makes a generated graph unusable.
 */
export function layoutStageGraph(input: StageLayoutInput): StageLayout {
  const order = new Map<string, number>()
  const nodes: StageLayoutNode[] = input.nodes.map((node) => {
    const row = Math.floor(node.index / STAGE_PER_ROW)
    const withinRow = node.index % STAGE_PER_ROW
    const column = row % 2 === 0 ? withinRow : STAGE_PER_ROW - 1 - withinRow
    order.set(node.name, node.index)
    return { ...node, x: column * STAGE_X_PITCH, y: row * STAGE_Y_PITCH }
  })

  const edges: StageLayoutEdge[] = input.edges.map((edge) => {
    const from = order.get(edge.from)
    const to = order.get(edge.to)
    // `carried` marks a dependency reaching over intervening stages. Unknown
    // endpoints (which the projection does not emit) count as not carried
    // rather than throwing — a layout that refuses to draw is worse than one
    // that draws a plain line.
    const carried = from !== undefined && to !== undefined && to - from > 1
    return { ...edge, carried }
  })

  const rows = Math.max(1, Math.ceil(input.nodes.length / STAGE_PER_ROW))
  const columns = Math.min(Math.max(input.nodes.length, 1), STAGE_PER_ROW)
  return {
    nodes,
    edges,
    width: (columns - 1) * STAGE_X_PITCH + STAGE_CARD_WIDTH,
    height: (rows - 1) * STAGE_Y_PITCH + 120,
  }
}

/**
 * Which handles an edge should attach to, given where its endpoints landed.
 *
 * Direction matters visually: on a right-to-left row the "next" card is to the
 * LEFT, so an edge leaving its right side would double back over the card it
 * just left. Deciding this from coordinates rather than from row parity keeps
 * it correct for carried edges too, which can span rows.
 */
export function edgeHandles(
  from: StageLayoutNode,
  to: StageLayoutNode,
): { source: 'left' | 'right' | 'bottom'; target: 'left' | 'right' | 'top' } {
  if (to.y > from.y) return { source: 'bottom', target: 'top' }
  if (to.x >= from.x) return { source: 'right', target: 'left' }
  return { source: 'left', target: 'right' }
}
