// RFC-326 — anchor canonicalisation (proposal AC-9 / AC-10; design §3).
//
// WHY THIS FILE EXISTS (regression intent):
//   - Strategy 0 (`recomputeOccurrenceIndex`): an anchor whose `offsetStart` IS
//     an occurrence and whose non-empty context sides match there is taken as
//     posted. Before, identical ±30-char contexts (repeated table rows) made the
//     legacy exact-context strategy pick the FIRST such occurrence, overriding
//     the caller's explicit choice — the design-gate F2 reproduction
//     (`offs=[8,61,114,167]` → occurrenceIndex 2 for the 3rd row). Removing
//     strategy 0 turns the F2 case below red (mutation evidence ②, plan §3).
//   - `canonicalizeAnchor` now rewrites `offsetStart/End` to the chosen
//     occurrence, so a stored row is self-consistent:
//       body.slice(offsetStart, offsetEnd) === selectedText
//       findAllOccurrences(body, selectedText).indexOf(offsetStart) + 1 === occurrenceIndex
//   - Server-resolved anchors (`anchorRequest`) are persisted VERBATIM — only a
//     consistency assertion runs, and a mismatch is a programming error (bare
//     Error → 500), never a silent fix-up (AC-9).
//   - `AnchorValidationError extends ValidationError` (P6): a made-up
//     selectedText is a 422, not the 500 the old bare Error produced (AC-16).

import { describe, expect, test } from 'bun:test'
import type { ReviewCommentAnchor } from '@agent-workflow/shared'
import {
  buildReviewAnchorDocument,
  resolveReviewAnchor,
} from '../src/modules/collaboration/public/queries'
import {
  AnchorValidationError,
  assertResolvedAnchorConsistent,
  canonicalizeAnchor,
  findAllOccurrences,
  recomputeOccurrenceIndex,
  resolveCommentAnchor,
} from '../src/services/review'
import { DomainError, ValidationError } from '../src/util/errors'

// Design-gate F2 document: a heading, then four byte-identical 53-char table
// rows. The quote starts at column 0 of every row, so its occurrences sit at
// 8 / 61 / 114 / 167 and rows 2-4 share identical ±30-char contexts.
const HEADER = '# Table\n'
const ROW = '| Fe | iron | 26 | transition metal | solid |'.padEnd(52) + '\n'
const F2_BODY = HEADER + ROW.repeat(4)
const F2_QUOTE = '| Fe | iron | 26 |'
const F2_OFFSETS = [8, 61, 114, 167]

function contextsAt(body: string, offset: number, len: number): { before: string; after: string } {
  return {
    before: body.slice(Math.max(0, offset - 30), offset),
    after: body.slice(offset + len, offset + len + 30),
  }
}

function webAnchor(
  body: string,
  quote: string,
  offsetStart: number,
  overrides: Partial<ReviewCommentAnchor> = {},
): ReviewCommentAnchor {
  const { before, after } = contextsAt(body, offsetStart, quote.length)
  return {
    sectionPath: '# Table',
    paragraphIdx: 0,
    offsetStart,
    offsetEnd: offsetStart + quote.length,
    selectedText: quote,
    contextBefore: before,
    contextAfter: after,
    occurrenceIndex: 1,
    ...overrides,
  }
}

function expectSelfConsistent(body: string, anchor: ReviewCommentAnchor): void {
  expect(body.slice(anchor.offsetStart, anchor.offsetEnd)).toBe(anchor.selectedText)
  expect(findAllOccurrences(body, anchor.selectedText).indexOf(anchor.offsetStart) + 1).toBe(
    anchor.occurrenceIndex,
  )
}

describe('RFC-326 AC-10 — strategy 0 trusts a self-consistent client anchor', () => {
  test('fixture sanity: the F2 document has the design-gate offsets', () => {
    expect(ROW.length).toBe(53)
    expect(findAllOccurrences(F2_BODY, F2_QUOTE)).toEqual(F2_OFFSETS)
    // Rows 2-4 share the same ±30 contexts; row 1 differs (preceded by the heading).
    const c2 = contextsAt(F2_BODY, 61, F2_QUOTE.length)
    const c3 = contextsAt(F2_BODY, 114, F2_QUOTE.length)
    const c4 = contextsAt(F2_BODY, 167, F2_QUOTE.length)
    expect(c3).toEqual(c2)
    expect(c4).toEqual(c2)
    expect(contextsAt(F2_BODY, 8, F2_QUOTE.length).before).toBe(HEADER)
  })

  test('F2: the 3rd table row stays the 3rd — occurrenceIndex 3, offsetStart 114', () => {
    // The client names the third row (offsets + matching contexts) but its
    // occurrenceIndex is a stale guess; the offsets are the caller's real choice.
    const posted = webAnchor(F2_BODY, F2_QUOTE, 114, { occurrenceIndex: 2 })
    const recomputed = recomputeOccurrenceIndex(F2_BODY, posted)
    expect(recomputed).toEqual({ occurrenceIndex: 3, absoluteOffset: 114, contextMatched: true })

    const canonical = canonicalizeAnchor(F2_BODY, posted)
    expect(canonical.occurrenceIndex).toBe(3)
    expect(canonical.offsetStart).toBe(114)
    expect(canonical.offsetEnd).toBe(114 + F2_QUOTE.length)
    expectSelfConsistent(F2_BODY, canonical)
  })

  test('strategy 0 with empty contexts: the offset alone is trusted (last row)', () => {
    const posted = webAnchor(F2_BODY, F2_QUOTE, 167, {
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 1,
    })
    const canonical = canonicalizeAnchor(F2_BODY, posted)
    expect(canonical.occurrenceIndex).toBe(4)
    expect(canonical.offsetStart).toBe(167)
    expectSelfConsistent(F2_BODY, canonical)
  })

  test('strategy 0 needs the context to match: a mismatching side falls through to the legacy strategies', () => {
    const posted = webAnchor(F2_BODY, F2_QUOTE, 114, { contextBefore: 'not what is there' })
    const canonical = canonicalizeAnchor(F2_BODY, posted)
    // Not trusted as posted — the legacy strategies pick by context, and the
    // stored offsets follow whatever they picked.
    expect(canonical.occurrenceIndex).not.toBe(3)
    expectSelfConsistent(F2_BODY, canonical)
  })

  test('sectionPath / paragraphIdx / contexts stay exactly as posted', () => {
    const posted = webAnchor(F2_BODY, F2_QUOTE, 61, {
      sectionPath: '# Table > ## Rows',
      paragraphIdx: 7,
    })
    const canonical = canonicalizeAnchor(F2_BODY, posted)
    expect(canonical.sectionPath).toBe('# Table > ## Rows')
    expect(canonical.paragraphIdx).toBe(7)
    expect(canonical.contextBefore).toBe(posted.contextBefore)
    expect(canonical.contextAfter).toBe(posted.contextAfter)
    expect(canonical.selectedText).toBe(F2_QUOTE)
  })
})

describe('RFC-326 AC-10 — offsets are corrected to the chosen occurrence', () => {
  test('a client offset that is not an occurrence is replaced by the context-chosen one', () => {
    // Offsets point at the heading (not an occurrence) while the contexts are
    // those of the second row: strategy 0 cannot apply, legacy strategy 1 (first
    // exact context match) picks row 2, and the stored offsets follow it.
    const { before, after } = contextsAt(F2_BODY, 61, F2_QUOTE.length)
    const posted = webAnchor(F2_BODY, F2_QUOTE, 0, {
      contextBefore: before,
      contextAfter: after,
      occurrenceIndex: 3,
    })
    const recomputed = recomputeOccurrenceIndex(F2_BODY, posted)
    expect(recomputed).toEqual({ occurrenceIndex: 2, absoluteOffset: 61, contextMatched: true })
    const canonical = canonicalizeAnchor(F2_BODY, posted)
    expect(canonical.offsetStart).toBe(61)
    expect(canonical.offsetEnd).toBe(61 + F2_QUOTE.length)
    expectSelfConsistent(F2_BODY, canonical)
  })

  test('an off-by-one offset with drifted contexts still lands ON an occurrence', () => {
    // 115 is inside row 3 but not where the quote starts; whichever legacy
    // strategy wins, the persisted row must point at a real occurrence.
    const posted = webAnchor(F2_BODY, F2_QUOTE, 115, { occurrenceIndex: 3 })
    const canonical = canonicalizeAnchor(F2_BODY, posted)
    expect(canonical.offsetStart).not.toBe(115)
    expect(F2_OFFSETS).toContain(canonical.offsetStart)
    expectSelfConsistent(F2_BODY, canonical)
  })

  test('the pre-RFC-326 shape (index rewritten, offsets left alone) can no longer be produced', () => {
    const body = 'alpha beta\n\nalpha gamma\n\nalpha delta\n'
    const quote = 'alpha'
    // Contexts describe the SECOND occurrence; offsets claim the first.
    const posted: ReviewCommentAnchor = {
      sectionPath: '',
      paragraphIdx: 0,
      offsetStart: 0,
      offsetEnd: 5,
      selectedText: quote,
      contextBefore: 'beta\n\n',
      contextAfter: ' gamma',
      occurrenceIndex: 1,
    }
    const canonical = canonicalizeAnchor(body, posted)
    expect(canonical.occurrenceIndex).toBe(2)
    expect(canonical.offsetStart).toBe(body.indexOf('alpha gamma'))
    expectSelfConsistent(body, canonical)
  })
})

describe('RFC-326 AC-16 — anchor validation failures are ValidationErrors (422), not bare Errors', () => {
  test('empty selectedText → AnchorValidationError / anchor-empty-selection', () => {
    const posted = webAnchor(F2_BODY, F2_QUOTE, 8, { selectedText: '' })
    let caught: unknown
    try {
      canonicalizeAnchor(F2_BODY, posted)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AnchorValidationError)
    expect(caught).toBeInstanceOf(ValidationError)
    expect((caught as AnchorValidationError).code).toBe('anchor-empty-selection')
    expect((caught as AnchorValidationError).name).toBe('AnchorValidationError')
  })

  test('selectedText absent from the body → AnchorValidationError / anchor-selection-not-found', () => {
    const posted = webAnchor(F2_BODY, F2_QUOTE, 8, { selectedText: 'not in this document' })
    let caught: unknown
    try {
      recomputeOccurrenceIndex(F2_BODY, posted)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ValidationError)
    expect((caught as ValidationError).code).toBe('anchor-selection-not-found')
  })
})

describe('RFC-326 AC-9 — server-resolved anchors are persisted verbatim', () => {
  const body =
    '# Spec\n\nThe `order_status` enum should include partially_refunded.\n\n## Notes\n\nenum again\n'

  test('resolveCommentAnchor(anchorRequest) returns the resolver output field-by-field, no recompute', () => {
    const request = { quote: 'enum should include' }
    const resolution = resolveReviewAnchor(buildReviewAnchorDocument(body), request)
    if (!resolution.ok) throw new Error(`fixture: ${resolution.code}`)
    const out = resolveCommentAnchor(body, { anchorRequest: request })
    expect(out.anchor).toEqual(resolution.anchor)
    expect(out.warnings).toEqual(resolution.warnings)
    expectSelfConsistent(body, out.anchor)
  })

  test('resolver refusals surface as ValidationError with the resolver code + structured details', () => {
    let caught: unknown
    try {
      resolveCommentAnchor(body, { anchorRequest: { quote: 'enum' } }) // 2 occurrences → ambiguous
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ValidationError)
    const err = caught as ValidationError
    expect(err.code).toBe('review-anchor-ambiguous')
    const details = err.details as { candidates: unknown[]; total: number }
    expect(details.total).toBe(2)
    expect(details.candidates.length).toBe(2)
  })

  test('the web form still goes through canonicalisation', () => {
    const quote = 'enum'
    const second = body.indexOf('enum again')
    const out = resolveCommentAnchor(body, { anchor: webAnchor(body, quote, second) })
    expect(out.warnings).toEqual([])
    expect(out.anchor.occurrenceIndex).toBe(2)
    expect(out.anchor.offsetStart).toBe(second)
  })

  test('exactly one of anchor / anchorRequest — both or neither is a programming error (bare Error)', () => {
    const anchor = webAnchor(body, 'enum', body.indexOf('enum'))
    for (const input of [{}, { anchor, anchorRequest: { quote: 'enum' } }]) {
      let caught: unknown
      try {
        resolveCommentAnchor(body, input)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(Error)
      expect(caught).not.toBeInstanceOf(DomainError)
      expect((caught as Error).message).toContain('exactly one')
    }
  })

  test('assertResolvedAnchorConsistent: a consistent anchor passes, a drifted one is a bare Error (500)', () => {
    const resolution = resolveReviewAnchor(buildReviewAnchorDocument(body), { quote: 'Notes' })
    if (!resolution.ok) throw new Error(`fixture: ${resolution.code}`)
    expect(() => assertResolvedAnchorConsistent(body, resolution.anchor)).not.toThrow()

    const drifted: ReviewCommentAnchor = {
      ...resolution.anchor,
      offsetStart: resolution.anchor.offsetStart + 1,
      offsetEnd: resolution.anchor.offsetEnd + 1,
    }
    let caught: unknown
    try {
      assertResolvedAnchorConsistent(body, drifted)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(DomainError)
    expect((caught as Error).message).toContain('inconsistent')
  })
})
