// RFC-085 T6 — turn a (fetched) forward call chain into a UML-ish sequence model:
// participants (lifelines = the classes involved) + ordered messages (each call,
// DFS pre-order = execution order, caller-class → callee-class). PURE so the
// ordering/dedup is unit-tested independent of the SVG renderer (T7).

export const UNRESOLVED_LIFELINE = '«unresolved»'

/** A node of the eagerly-fetched chain (built from CallTarget rows). */
export interface SeqCallNode {
  /** callee owner class id `${file}::${ClassQn}`, or null when unresolved. */
  ownerClass: string | null
  /** display label, e.g. `charge()`. */
  method: string
  resolution: 'resolved' | 'external' | 'unresolved'
  children: SeqCallNode[]
}

export interface SeqMessage {
  /** caller lifeline (owner-class id). */
  from: string
  /** callee lifeline (owner-class id, or UNRESOLVED_LIFELINE). */
  to: string
  label: string
  /** nesting depth (0 = direct call of the root). */
  depth: number
  resolution: 'resolved' | 'external' | 'unresolved'
}

export interface SequenceModel {
  /** lifelines in first-appearance order (root class first). */
  participants: string[]
  messages: SeqMessage[]
}

/** Leaf class name for a lifeline id (`file::a.b.C` → `C`). */
export function classDisplay(ownerClass: string): string {
  if (ownerClass === UNRESOLVED_LIFELINE) return ownerClass
  const qn = ownerClass.includes('::') ? (ownerClass.split('::')[1] ?? ownerClass) : ownerClass
  return qn.split('.').pop() ?? qn
}

/** Build the sequence model. `rootClass` is the root method's owner-class id; its
 *  direct callees are `children`. Messages are emitted DFS pre-order so they read
 *  top-to-bottom as the call executes; only resolved nodes recurse. */
export function buildSequence(rootClass: string, children: readonly SeqCallNode[]): SequenceModel {
  const participants: string[] = []
  const add = (p: string): void => {
    if (!participants.includes(p)) participants.push(p)
  }
  add(rootClass)
  const messages: SeqMessage[] = []
  const walk = (parentClass: string, nodes: readonly SeqCallNode[], depth: number): void => {
    for (const n of nodes) {
      const to = n.ownerClass ?? UNRESOLVED_LIFELINE
      add(to)
      messages.push({ from: parentClass, to, label: n.method, depth, resolution: n.resolution })
      if (n.resolution === 'resolved' && n.children.length > 0) walk(to, n.children, depth + 1)
    }
  }
  walk(rootClass, children, 0)
  return { participants, messages }
}

// --- Sequence diagram layout (pure; rendered by SequenceDiagram.tsx) -----------
// Constants live here so the SVG size can be computed — and unit-tested — without
// a DOM. The width MUST include message-label text that extends past the
// participant columns; in particular self-call labels are drawn to the RIGHT of
// their lifeline, so on the last participant they used to overflow the svg's
// width and get clipped by overflow:hidden (rightmost-column truncation bug).

export const SEQ_COL_W = 150
export const SEQ_ROW_H = 34
export const SEQ_HEAD_H = 40
export const SEQ_PAD = 24
/** x of a self-call label = lifeline x + this (matches the `h 22` loop + gap). */
export const SEQ_SELF_LABEL_OFFSET = 26
/** gap from an inter-participant arrow's left endpoint to its left-aligned label. */
export const SEQ_LABEL_GAP = 8
/** approx glyph advance of the 11px ui-monospace msg label. Slightly generous so
 *  we never under-size (clip); over-sizing only adds harmless right padding. */
export const SEQ_CHAR_W = 6.7
/** approx glyph advance of the 12px head label. */
export const SEQ_HEAD_CHAR_W = 7.3

/** Label string exactly as drawn. No depth indentation: labels are left-aligned
 *  flush to their arrow's left end, and leading spaces (white-space:pre) would
 *  push the visible method name away from the arrow. Call depth is already shown
 *  by the lifelines involved + top-to-bottom order. */
export function seqMessageLabel(m: Pick<SeqMessage, 'label'>): string {
  return m.label
}

export interface SeqLayout {
  width: number
  height: number
}

/** Lifeline center x for a participant. */
function seqCenterX(model: SequenceModel, p: string): number {
  const i = Math.max(0, model.participants.indexOf(p))
  return SEQ_PAD + i * SEQ_COL_W + SEQ_COL_W / 2
}

/** Pure SVG size for the diagram. `width` accounts for label text that extends
 *  past the participant columns (centered message labels and, crucially,
 *  self-call labels drawn to the right of the last lifeline). */
export function seqDiagramLayout(model: SequenceModel): SeqLayout {
  // Rightmost content x (absolute). Columns occupy [PAD, PAD + n*COL_W]; a final
  // PAD is added below so the base equals the old PAD*2 + n*COL_W width.
  let maxRight = SEQ_PAD + model.participants.length * SEQ_COL_W
  for (const p of model.participants) {
    // head label is textAnchor=middle, so it spreads half its width each side.
    const right = seqCenterX(model, p) + (classDisplay(p).length * SEQ_HEAD_CHAR_W) / 2
    if (right > maxRight) maxRight = right
  }
  for (const m of model.messages) {
    const textW = seqMessageLabel(m).length * SEQ_CHAR_W
    const x1 = seqCenterX(model, m.from)
    const x2 = seqCenterX(model, m.to)
    const right =
      x1 === x2
        ? x1 + SEQ_SELF_LABEL_OFFSET + textW // self-call: label starts right of lifeline
        : Math.min(x1, x2) + SEQ_LABEL_GAP + textW // label left-aligned at the arrow's left end
    if (right > maxRight) maxRight = right
  }
  const width = Math.ceil(maxRight + SEQ_PAD)
  const height = SEQ_HEAD_H + SEQ_PAD + model.messages.length * SEQ_ROW_H + SEQ_PAD
  return { width, height }
}
