// Supplementary coverage for RFC-005 review anchor + prompt rendering pipeline.
//
// Locks two internal boundaries that were unexercised by the existing
// review-anchor-disambiguation.test.ts / review-render-comments-*.test.ts:
//
//  GAP 1 — recomputeOccurrenceIndex (review.ts:134-224) strategy-2 boundaries:
//    (a) a partial-context proxy SCORE TIE across occurrences must keep the
//        FIRST candidate (strict `>` at line 196), returning contextMatched:false;
//    (b) when contexts are present but match NO occurrence at all (bestScore
//        stays 0 because of the `> 0` gate at line 201), strategy 2 is rejected
//        and control falls through to strategy 3 (the clamped client claim) —
//        a security-relevant boundary so a garbage-context client cannot forge
//        an index, while a VALID claim is still honoured (not silently → occ 1).
//
//  GAP 2 — renderCommentsForPrompt (review.ts:2037-2059) per-comment
//    `**Selection** (occurrence N of "text"):` header + the
//    `> …<before>**<sel>**<after>…` blockquote line, including the empty-context
//    collapse (`> …**sel**…`) and occurrenceIndex > 1. These two lines are the
//    disambiguation payload the iterate agent reads; existing tests only assert
//    the **File** / **Location** / **Comment** lines, so a refactor dropping or
//    reordering the occurrence number would not fail anything.

import type { ReviewComment, ReviewCommentAnchor } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import {
  recomputeOccurrenceIndex,
  renderCommentsForPrompt,
} from '@/modules/collaboration/infrastructure/review'

// ---------------------------------------------------------------------------
// GAP 1 — recomputeOccurrenceIndex strategy-2 tie & bestScore===0 fall-through.
// ---------------------------------------------------------------------------

function anchor(parts: Partial<ReviewCommentAnchor>): ReviewCommentAnchor {
  return {
    sectionPath: 's',
    paragraphIdx: 0,
    offsetStart: 0,
    offsetEnd: 0,
    selectedText: 'X',
    contextBefore: '',
    contextAfter: '',
    occurrenceIndex: 1,
    ...parts,
  }
}

describe('recomputeOccurrenceIndex — strategy-2 proxy boundaries (RFC-005)', () => {
  // Two 'X' occurrences at offsets [4, 14]. Both share the same following
  // char (' '), so the partial-context proxy ties on afterScore=1 / beforeScore=0.
  const DOC = 'foo X bar\nbaz X qux'

  test('proxy SCORE TIE → strict `>` keeps the FIRST occurrence (contextMatched:false)', () => {
    // contextBefore 'ZZ' matches neither boundary (beforeScore 0 for both);
    // contextAfter ' ' matches both (afterScore 1 for both) → tie → bestIdx stays 0.
    const result = recomputeOccurrenceIndex(
      DOC,
      anchor({ contextBefore: 'ZZ', contextAfter: ' ', occurrenceIndex: 1 }),
    )
    expect(result.occurrenceIndex).toBe(1)
    expect(result.contextMatched).toBe(false)
    expect(result.absoluteOffset).toBe(4)
  })

  test('contexts present but match NOTHING → bestScore 0 → strategy 3 honours the valid claim 2', () => {
    // No common prefix/suffix anywhere → bestScore stays 0 → `> 0` gate fails →
    // strategy 3 honours the in-range client claim (occ 2), NOT strategy-2 occ 1.
    const result = recomputeOccurrenceIndex(
      DOC,
      anchor({ contextBefore: 'Q', contextAfter: 'Z', occurrenceIndex: 2 }),
    )
    expect(result.occurrenceIndex).toBe(2)
    expect(result.contextMatched).toBe(false)
    expect(result.absoluteOffset).toBe(14)
  })

  test('after-only garbage context → bestScore 0 → valid claim 2 still wins', () => {
    const result = recomputeOccurrenceIndex(
      DOC,
      anchor({ contextBefore: '', contextAfter: 'NOPE', occurrenceIndex: 2 }),
    )
    expect(result.occurrenceIndex).toBe(2)
    expect(result.contextMatched).toBe(false)
    expect(result.absoluteOffset).toBe(14)
  })
})

// ---------------------------------------------------------------------------
// GAP 2 — renderCommentsForPrompt Selection header + blockquote quote line.
// ---------------------------------------------------------------------------

function comment(anchorParts: Partial<ReviewCommentAnchor>): ReviewComment {
  return {
    id: 'c',
    docVersionId: 'd',
    commentText: 'fix',
    author: 'local',
    createdAt: 1,
    anchor: {
      sectionPath: '## A',
      paragraphIdx: 2,
      offsetStart: 0,
      offsetEnd: 1,
      selectedText: 'order_status',
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 1,
      ...anchorParts,
    },
  }
}

describe('renderCommentsForPrompt — Selection header + quote line (RFC-005)', () => {
  test('occurrenceIndex>1 + non-empty contexts emit verbatim Selection + blockquote lines', () => {
    const out = renderCommentsForPrompt([
      comment({ contextBefore: 'The `', contextAfter: '` enum', occurrenceIndex: 2 }),
    ])
    expect(out).toContain('**Selection** (occurrence 2 of "order_status"):')
    expect(out).toContain('> …The `**order_status**` enum…')
  })

  test('empty contextBefore/After collapse to bare ellipses around the bolded selection', () => {
    const out = renderCommentsForPrompt([
      comment({ contextBefore: '', contextAfter: '', occurrenceIndex: 1 }),
    ])
    expect(out).toContain('> …**order_status**…')
    expect(out).toContain('(occurrence 1 of "order_status")')
  })
})
