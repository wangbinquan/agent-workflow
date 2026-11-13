// RFC-493 (RFC-294 S13): review comment-anchor normalisation, moved verbatim from `infrastructure/review.ts` — pure functions over a
// document body and a comment anchor (occurrence recompute, canonicalisation, consistency, comment anchor resolution).
//
// ---------------------------------------------------------------------------
// Anchor — pure functions.
// ---------------------------------------------------------------------------

// RFC-326: the occurrence math is ONE shared implementation
// (packages/shared/src/textOccurrences.ts) used by this canonicaliser, the
// collaboration anchor resolver and the web highlighter — the number stored in
// `occurrence_index` and the number the page counts must be the same number.
//
// (`findAllOccurrences` is taken from `@agent-workflow/shared` directly; this file does not re-export it.)

import {
  type ReviewCommentAnchor,
  type ReviewAnchorRequest,
  type ReviewAnchorWarning,
  findAllOccurrences,
} from '@agent-workflow/shared'
import {
  buildReviewAnchorDocument,
  resolveReviewAnchor,
  type ReviewAnchorFailure,
} from './reviewAnchor'
import { ValidationError } from '@/util/errors'

export interface OccurrenceRecomputeResult {
  /** 1-based occurrence index in the full document body. */
  occurrenceIndex: number
  /** Absolute char offset of the chosen occurrence in the doc body. */
  absoluteOffset: number
  /** True when context disambiguated (contextBefore / After matched). */
  contextMatched: boolean
}

/**
 * Recompute the 1-based occurrence index of `anchor.selectedText` inside
 * `docBody`, choosing the occurrence whose immediate ±context best matches
 * `anchor.contextBefore` / `anchor.contextAfter`.
 *
 * Selection criteria (in order):
 *   1. The occurrence whose (contextBefore endsWith && contextAfter startsWith)
 *      pair fully matches the doc body's surrounding chars.
 *   2. Else: the occurrence whose Levenshtein distance on the context windows
 *      is minimal (longest common prefix on contextBefore + suffix on
 *      contextAfter as a cheap proxy — we avoid pulling in a full edit-distance
 *      lib for one screen of code).
 *   3. Else: fall back to the client-claimed occurrenceIndex if it's a valid
 *      1..N index against the actual occurrence count.
 *
 * Throws ValidationError when `selectedText` is empty or not present at all.
 */
export class AnchorValidationError extends ValidationError {
  constructor(code: string, message: string) {
    // RFC-326 (P6): was a bare Error → the route surfaced a 500 for a made-up
    // selectedText although the docstring above promised a ValidationError.
    super(code, message)
    this.name = 'AnchorValidationError'
  }
}

export function recomputeOccurrenceIndex(
  docBody: string,
  anchor: ReviewCommentAnchor,
): OccurrenceRecomputeResult {
  if (anchor.selectedText.length === 0) {
    throw new AnchorValidationError(
      'anchor-empty-selection',
      'anchor.selectedText must be non-empty',
    )
  }
  const offsets = findAllOccurrences(docBody, anchor.selectedText)
  if (offsets.length === 0) {
    throw new AnchorValidationError(
      'anchor-selection-not-found',
      `anchor.selectedText '${truncate(anchor.selectedText, 40)}' not present in document`,
    )
  }

  // RFC-326 strategy 0 — a self-consistent anchor is taken as-is: `offsetStart`
  // IS an occurrence (so the slice equals selectedText) and every non-empty
  // context side matches there. Server-resolved anchors always satisfy this;
  // web anchors do whenever the proportional heuristic landed on the right
  // occurrence. Without it two occurrences with identical ±30-char contexts
  // (repeated table rows) were both "resolved" to the first one, overriding
  // the caller's explicit choice — the design-gate reproduction of RFC-326.
  const exactIdx = offsets.indexOf(anchor.offsetStart)
  if (exactIdx >= 0 && contextMatchesAt(docBody, anchor, anchor.offsetStart)) {
    return {
      occurrenceIndex: exactIdx + 1,
      absoluteOffset: anchor.offsetStart,
      contextMatched: true,
    }
  }

  // Strategy 1: exact context match. Only applies if AT LEAST ONE context
  // side is non-empty — otherwise every occurrence trivially "matches" and
  // we'd skip strategies 2/3 wrongly.
  const hasContext = anchor.contextBefore.length > 0 || anchor.contextAfter.length > 0
  if (hasContext) {
    let bestExact = -1
    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i]!
      const before = docBody.slice(Math.max(0, off - anchor.contextBefore.length), off)
      const after = docBody.slice(
        off + anchor.selectedText.length,
        off + anchor.selectedText.length + anchor.contextAfter.length,
      )
      if (
        (anchor.contextBefore.length === 0 || before === anchor.contextBefore) &&
        (anchor.contextAfter.length === 0 || after === anchor.contextAfter)
      ) {
        bestExact = i
        break
      }
    }
    if (bestExact >= 0) {
      return {
        occurrenceIndex: bestExact + 1,
        absoluteOffset: offsets[bestExact]!,
        contextMatched: true,
      }
    }
  }

  // Strategy 2: cheap proxy — longest common suffix on contextBefore + longest
  // common prefix on contextAfter. Picks the candidate with the highest sum.
  let bestIdx = 0
  let bestScore = -1
  for (let i = 0; i < offsets.length; i++) {
    const off = offsets[i]!
    const before = docBody.slice(Math.max(0, off - anchor.contextBefore.length), off)
    const after = docBody.slice(
      off + anchor.selectedText.length,
      off + anchor.selectedText.length + anchor.contextAfter.length,
    )
    const beforeScore = commonSuffixLength(before, anchor.contextBefore)
    const afterScore = commonPrefixLength(after, anchor.contextAfter)
    const score = beforeScore + afterScore
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  if (bestScore > 0) {
    return {
      occurrenceIndex: bestIdx + 1,
      absoluteOffset: offsets[bestIdx]!,
      contextMatched: false,
    }
  }

  // Strategy 3: fall back to the client's claim, clamped to 1..N.
  const claimed = anchor.occurrenceIndex
  if (Number.isInteger(claimed) && claimed >= 1 && claimed <= offsets.length) {
    return {
      occurrenceIndex: claimed,
      absoluteOffset: offsets[claimed - 1]!,
      contextMatched: false,
    }
  }
  // Last resort: pick the first occurrence. Server still owns the index.
  return {
    occurrenceIndex: 1,
    absoluteOffset: offsets[0]!,
    contextMatched: false,
  }
}

/**
 * Server-side fixup applied before persisting a review_comment row: the
 * client-supplied anchor is replaced with one whose `occurrenceIndex` reflects
 * what the canonical document actually says AND whose `offsetStart/End` point at
 * that same occurrence (RFC-326 P5 — before, only the index was rewritten and
 * the offsets stayed at the client's heuristic guess, so a stored row could
 * name occurrence 3 while its offsets sat on occurrence 2; the web highlighter
 * now locates comments by offset, which needs the row to be self-consistent).
 * `sectionPath` / `paragraphIdx` / contexts stay as posted.
 */
export function canonicalizeAnchor(
  docBody: string,
  anchor: ReviewCommentAnchor,
): ReviewCommentAnchor {
  const recomputed = recomputeOccurrenceIndex(docBody, anchor)
  return {
    ...anchor,
    occurrenceIndex: recomputed.occurrenceIndex,
    offsetStart: recomputed.absoluteOffset,
    offsetEnd: recomputed.absoluteOffset + anchor.selectedText.length,
  }
}

function contextMatchesAt(docBody: string, anchor: ReviewCommentAnchor, offset: number): boolean {
  const before = docBody.slice(Math.max(0, offset - anchor.contextBefore.length), offset)
  const end = offset + anchor.selectedText.length
  const after = docBody.slice(end, end + anchor.contextAfter.length)
  return (
    (anchor.contextBefore.length === 0 || before === anchor.contextBefore) &&
    (anchor.contextAfter.length === 0 || after === anchor.contextAfter)
  )
}

/**
 * RFC-326 — translate a resolver refusal into the 422 the route returns. The
 * candidate keys ride in `message` (the MCP channel forwards only the message)
 * and the structured lists in `details` (REST callers read them as-is).
 */
export function anchorResolutionError(failure: ReviewAnchorFailure): ValidationError {
  return new ValidationError(failure.code, failure.message, {
    candidates: failure.candidates,
    total: failure.total,
    truncated: failure.truncated,
    suggestions: failure.suggestions,
  })
}

/**
 * RFC-326 AC-9 — a server-resolved anchor is persisted verbatim; the only check
 * is that it still describes the body it was resolved against. A mismatch is a
 * programming error (the resolver and this service disagree about the body),
 * not a client error, hence a bare Error (500).
 */
export function assertResolvedAnchorConsistent(docBody: string, anchor: ReviewCommentAnchor): void {
  if (docBody.slice(anchor.offsetStart, anchor.offsetEnd) !== anchor.selectedText) {
    throw new Error(
      `resolved review anchor is inconsistent with the document body at ${anchor.offsetStart}-${anchor.offsetEnd}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function commonSuffixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++
  return i
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/**
 * RFC-326 — resolve whichever anchor form the caller gave against `body`.
 * Web anchors are canonicalised (strategy 0 first, then the legacy context
 * strategies); simplified locators go through the collaboration resolver and
 * are persisted verbatim.
 */
export function resolveCommentAnchor(
  body: string,
  input: { anchor?: ReviewCommentAnchor; anchorRequest?: ReviewAnchorRequest },
): { anchor: ReviewCommentAnchor; warnings: ReviewAnchorWarning[] } {
  if ((input.anchor === undefined) === (input.anchorRequest === undefined)) {
    throw new Error('addReviewComment: pass exactly one of `anchor` / `anchorRequest`')
  }
  if (input.anchorRequest !== undefined) {
    const resolution = resolveReviewAnchor(buildReviewAnchorDocument(body), input.anchorRequest)
    if (!resolution.ok) throw anchorResolutionError(resolution)
    assertResolvedAnchorConsistent(body, resolution.anchor)
    return { anchor: resolution.anchor, warnings: resolution.warnings }
  }
  return { anchor: canonicalizeAnchor(body, input.anchor!), warnings: [] }
}
