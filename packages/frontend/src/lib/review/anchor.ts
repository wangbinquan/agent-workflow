// Client-side anchor computation for RFC-005 review comments.
//
// User selects text in the rendered markdown DOM; we translate that to a
// canonical anchor whose fields match the backend ReviewCommentAnchor
// shape. Backend (services/review.ts:canonicalizeAnchor) recomputes the
// occurrence_index on insert, so the client number is best-effort — if our
// proportional-position heuristic picks the wrong occurrence the server's
// context-match takes over.
//
// Pure functions, no React. Imported by CommentPopover (build anchor on
// selection submit) and CommentSidebar (re-anchor for scroll-spy).

import type { ReviewCommentAnchor } from '@agent-workflow/shared'
import { findAllOccurrences } from '@agent-workflow/shared'

// RFC-326: ONE occurrence counter for the whole product (non-overlapping,
// 1-based when stored) — the backend resolver, the canonicalisation, this
// selection math and the page's highlighter all import it from shared.
export { findAllOccurrences }

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

/**
 * Compose the breadcrumb path of headings reachable from `target` by
 * walking up the DOM + scanning preceding siblings for headings.
 *
 * Returns the empty string when no heading appears above the target.
 */
export function computeSectionPath(rootEl: HTMLElement, target: Node): string {
  const buckets: Record<number, string> = {}
  // Walk: find target's element ancestor, then iterate previous siblings
  // backwards looking for headings. Repeat one level up. Stops at rootEl.
  let cur: Node | null = target.nodeType === Node.ELEMENT_NODE ? target : target.parentNode
  while (cur !== null && cur !== rootEl) {
    let sib: ChildNode | null = (cur as ChildNode).previousSibling
    while (sib !== null) {
      if (sib.nodeType === Node.ELEMENT_NODE) {
        const el = sib as HTMLElement
        const m = /^H([1-6])$/.exec(el.tagName)
        if (m !== null) {
          const level = Number(m[1])
          if (buckets[level] === undefined) {
            buckets[level] = (el.textContent ?? '').trim()
          }
        }
      }
      sib = sib.previousSibling
    }
    cur = (cur as Node).parentNode
  }
  const parts: string[] = []
  for (let lvl = 1; lvl <= 6; lvl++) {
    if (buckets[lvl] !== undefined) {
      parts.push('#'.repeat(lvl) + ' ' + buckets[lvl])
    }
  }
  return parts.join(' > ')
}

/**
 * Best-effort: count paragraph-like blocks (`<p>`, `<li>`, `<pre>`, table
 * rows) that appear in the deepest enclosing section before `target`.
 * Anchor section is identified by the closest preceding heading.
 */
export function computeParagraphIdx(rootEl: HTMLElement, target: Node): number {
  const headings = Array.from(rootEl.querySelectorAll<HTMLElement>(HEADING_SELECTOR))
  let lastHeadingBefore: HTMLElement | null = null
  for (const h of headings) {
    if (h.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) {
      lastHeadingBefore = h
    } else {
      break
    }
  }
  const startNode: Node | null = lastHeadingBefore ?? rootEl.firstChild
  if (startNode === null) return 0
  // Walk forward from startNode (exclusive) to target, counting block tags.
  let count = 0
  const blocks = new Set(['P', 'LI', 'PRE', 'TR', 'BLOCKQUOTE'])
  const iterate = (current: Node): boolean => {
    if (current === target || current.contains(target)) return true
    if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as HTMLElement
      if (blocks.has(el.tagName)) count++
    }
    let next: Node | null = current.nextSibling
    while (next === null) {
      const parent = current.parentNode
      if (parent === null || parent === rootEl) return false
      current = parent
      next = parent.nextSibling
    }
    return iterate(next)
  }
  const cursor: Node | null = startNode.nextSibling
  if (cursor === null) return 0
  iterate(cursor)
  return count
}

/**
 * Translate a `Selection` made inside `rootEl` (the rendered markdown
 * area) into a backend-shape ReviewCommentAnchor against the canonical
 * `sourceBody` (the markdown text the backend stored).
 *
 * Returns null when the selection is collapsed, empty after trim, spans
 * across a heading boundary, or the selected text isn't found in
 * sourceBody. Callers should treat null as "no anchor to submit".
 */
export function computeAnchorFromSelection(
  rootEl: HTMLElement,
  selection: Selection,
  sourceBody: string,
): ReviewCommentAnchor | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const selectedText = range.toString().trim()
  if (selectedText.length === 0) return null

  // Cross-heading selection rejected.
  if (rangeCrossesHeading(rootEl, range)) return null

  const occurrences = findAllOccurrences(sourceBody, selectedText)
  if (occurrences.length === 0) return null

  // Map rendered position → canonical position by proportional progress.
  const renderedText = rootEl.textContent ?? ''
  const renderedBefore = textBeforeRange(rootEl, range)
  const progress = renderedText.length > 0 ? renderedBefore.length / renderedText.length : 0
  const targetOffset = Math.floor(progress * sourceBody.length)

  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < occurrences.length; i++) {
    const dist = Math.abs(occurrences[i]! - targetOffset)
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }
  const chosen = occurrences[bestIdx]!
  const offsetEnd = chosen + selectedText.length

  return {
    sectionPath: computeSectionPath(rootEl, range.startContainer),
    paragraphIdx: computeParagraphIdx(rootEl, range.startContainer),
    offsetStart: chosen,
    offsetEnd,
    selectedText,
    contextBefore: sourceBody.slice(Math.max(0, chosen - 30), chosen),
    contextAfter: sourceBody.slice(offsetEnd, offsetEnd + 30),
    occurrenceIndex: bestIdx + 1,
  }
}

/**
 * True iff the user's selection spans across an `<h1>…<h6>` boundary
 * inside `rootEl`. Used by the UI to show a "cross-section selection
 * not supported" hint — without this, computeAnchorFromSelection just
 * returns null and the user sees no feedback at all.
 */
export function selectionCrossesHeading(rootEl: HTMLElement, selection: Selection): boolean {
  if (selection.rangeCount === 0 || selection.isCollapsed) return false
  return rangeCrossesHeading(rootEl, selection.getRangeAt(0))
}

/**
 * Stable hash of an anchor used to key draftStore entries. Same anchor →
 * same hash; different selections → different hash (best-effort, FNV-1a
 * over selected text + section path + offsetStart).
 */
export function anchorKey(a: ReviewCommentAnchor): string {
  const s = `${a.sectionPath}|${a.paragraphIdx}|${a.offsetStart}|${a.selectedText}|${a.occurrenceIndex}`
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function rangeCrossesHeading(rootEl: HTMLElement, range: Range): boolean {
  if (range.startContainer === range.endContainer) return false
  const between = rootEl.querySelectorAll<HTMLElement>(HEADING_SELECTOR)
  for (const h of between) {
    // h.compareDocumentPosition(other) bits describe `other` relative to h:
    //   PRECEDING → other is before h
    //   FOLLOWING → other is after h
    // A forward selection crosses h iff the start is before h AND the end
    // is after h. The previous impl had the two bits swapped, which made
    // this check effectively unreachable — the silent-failure UX the
    // crossHeadingHint addresses depended on the helper actually firing.
    const startPos = h.compareDocumentPosition(range.startContainer)
    const endPos = h.compareDocumentPosition(range.endContainer)
    if (startPos & Node.DOCUMENT_POSITION_PRECEDING && endPos & Node.DOCUMENT_POSITION_FOLLOWING) {
      return true
    }
  }
  return false
}

function textBeforeRange(rootEl: HTMLElement, range: Range): string {
  // Build a Range from rootEl start to range.startContainer/Offset, then
  // toString. Cheap-and-correct DOM way to measure character progress.
  try {
    const r = (rootEl.ownerDocument ?? document).createRange()
    r.setStart(rootEl, 0)
    r.setEnd(range.startContainer, range.startOffset)
    return r.toString()
  } catch {
    return ''
  }
}
