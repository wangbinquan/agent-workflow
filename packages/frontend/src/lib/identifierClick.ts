// RFC-258 §4.1/§4.2 — the identifier-click layer shared by the full-file view
// and the hunk view. Pure/DOM-light helpers only; components wire the events.
// Gate findings baked in:
//  - F-10: shiki output is nested token spans — the caret APIs give a NODE +
//    node-local offset, so the LINE column is recovered by summing the text
//    lengths of the preceding text nodes inside the line element (never by
//    trusting the caret offset alone). `#private` names match explicitly.
//  - F-11: clicks on real controls (button/a/[role=button]) are never treated
//    as identifier clicks — existing affordances keep their single action.

/** The identifier token covering 1-based `col` in `lineText`, or null. */
export function tokenAt(lineText: string, col: number): string | null {
  if (col < 1 || col > lineText.length) return null
  const re = /#?[A-Za-z_$][A-Za-z0-9_$]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(lineText)) !== null) {
    const start = m.index + 1 // 1-based
    const end = start + m[0].length // exclusive
    if (col >= start && col < end) return m[0]
    if (start > col) break
  }
  return null
}

/** True when the click landed on an interactive control that owns its own
 *  action (F-11) — the identifier layer must not double-fire. */
export function isInteractiveClickTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return target.closest('button, a, [role="button"]') !== null
}

interface CaretHit {
  node: Node
  offset: number
}

/** Caret position from viewport coords — Chromium's caretPositionFromPoint
 *  with WebKit's caretRangeFromPoint as the fallback shape. */
function caretAt(doc: Document, x: number, y: number): CaretHit | null {
  const d = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (typeof d.caretPositionFromPoint === 'function') {
    const p = d.caretPositionFromPoint(x, y)
    return p === null ? null : { node: p.offsetNode, offset: p.offset }
  }
  if (typeof d.caretRangeFromPoint === 'function') {
    const r = d.caretRangeFromPoint(x, y)
    return r === null ? null : { node: r.startContainer, offset: r.startOffset }
  }
  return null
}

/** 1-based column of a caret hit within `lineEl`, summing every text node
 *  before the hit (F-10). Null when the hit is outside the line element. */
export function columnInLine(lineEl: Element, hit: CaretHit): number | null {
  if (!lineEl.contains(hit.node)) return null
  let col = 0
  const walker = lineEl.ownerDocument.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT)
  let node: Node | null = walker.nextNode()
  while (node !== null) {
    if (node === hit.node) return col + hit.offset + 1
    col += node.textContent?.length ?? 0
    node = walker.nextNode()
  }
  // hit on the element itself (offset = child index) — treat as no column
  return null
}

export interface IdentifierClick {
  /** 1-based line (from the row's data attribute). */
  line: number
  /** 1-based column within the line's text. */
  col: number
  name: string
  /** Viewport coords of the click (menu anchoring). */
  clientX: number
  clientY: number
}

/**
 * Resolve a container click into an identifier hit, or null. `lineAttr` names
 * the data attribute carrying the 1-based line number on each rendered row
 * (`data-ln` in the full view; the hunk view passes its own).
 */
export function resolveIdentifierClick(
  ev: { target: EventTarget | null; clientX: number; clientY: number },
  lineAttr = 'data-ln',
): IdentifierClick | null {
  if (isInteractiveClickTarget(ev.target)) return null
  if (!(ev.target instanceof Element)) return null
  const lineEl = ev.target.closest(`[${lineAttr}]`)
  if (lineEl === null) return null
  const line = Number(lineEl.getAttribute(lineAttr))
  if (!Number.isInteger(line) || line < 1) return null
  const codeEl = lineEl.querySelector('[data-code]') ?? lineEl
  const hit = caretAt(lineEl.ownerDocument, ev.clientX, ev.clientY)
  if (hit === null) return null
  const col = columnInLine(codeEl, hit)
  if (col === null) return null
  const name = tokenAt(codeEl.textContent ?? '', col)
  if (name === null) return null
  return { line, col, name, clientX: ev.clientX, clientY: ev.clientY }
}
