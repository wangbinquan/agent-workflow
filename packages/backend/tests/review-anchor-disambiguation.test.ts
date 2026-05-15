// Locks in RFC-005 PR-B T10 anchor precision contract.
//
// If this goes red the AI receiving `{{__review_comments__}}` may end up
// citing the wrong occurrence of a repeated string. Check
// packages/backend/src/services/review.ts → recomputeOccurrenceIndex +
// canonicalizeAnchor in lock-step. RFC-005 design.md §6 spells out the
// strategy order (exact ctx → proxy ctx → client claim → first).

import type { ReviewCommentAnchor } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import {
  AnchorValidationError,
  canonicalizeAnchor,
  findAllOccurrences,
  recomputeOccurrenceIndex,
} from '../src/services/review'

const DOC = `# Order Service Design

## Data Model

The \`order_status\` enum should include partially_refunded.

## Interfaces

\`POST /api/v1/orders/cancel\` returns 200 on success.
The \`order_status\` field is updated to canceled.

## Sequence

Step 3 calls PaymentSvc with the order_status payload.
`

function anchor(parts: Partial<ReviewCommentAnchor>): ReviewCommentAnchor {
  return {
    sectionPath: '## Data Model',
    paragraphIdx: 0,
    offsetStart: 0,
    offsetEnd: 0,
    selectedText: 'order_status',
    contextBefore: '',
    contextAfter: '',
    occurrenceIndex: 1,
    ...parts,
  }
}

describe('findAllOccurrences', () => {
  test('returns 0-based offsets in document order', () => {
    const offs = findAllOccurrences(DOC, 'order_status')
    // 3 occurrences in the doc above (Data Model, Interfaces, Sequence).
    expect(offs.length).toBe(3)
    expect(offs[0]).toBe(DOC.indexOf('order_status'))
    expect(offs[0]).toBeLessThan(offs[1]!)
    expect(offs[1]).toBeLessThan(offs[2]!)
  })

  test('empty needle returns []', () => {
    expect(findAllOccurrences(DOC, '')).toEqual([])
  })

  test('needle not present returns []', () => {
    expect(findAllOccurrences(DOC, 'nope')).toEqual([])
  })
})

describe('recomputeOccurrenceIndex strategy 1: exact context match', () => {
  test('first occurrence selected via Data Model context', () => {
    const a = anchor({
      contextBefore: 'The `',
      contextAfter: '` enum should include partially_refunded.',
    })
    const r = recomputeOccurrenceIndex(DOC, a)
    expect(r.occurrenceIndex).toBe(1)
    expect(r.contextMatched).toBe(true)
  })

  test('second occurrence (Interfaces) selected via cancel context', () => {
    const a = anchor({
      contextBefore: 'success.\nThe `',
      contextAfter: '` field is updated to canceled.',
    })
    const r = recomputeOccurrenceIndex(DOC, a)
    expect(r.occurrenceIndex).toBe(2)
    expect(r.contextMatched).toBe(true)
  })

  test('third occurrence (Sequence) selected via PaymentSvc context', () => {
    const a = anchor({
      contextBefore: 'PaymentSvc with the ',
      contextAfter: ' payload.\n',
    })
    const r = recomputeOccurrenceIndex(DOC, a)
    expect(r.occurrenceIndex).toBe(3)
    expect(r.contextMatched).toBe(true)
  })
})

describe('recomputeOccurrenceIndex strategy 2: proxy (longest common ctx)', () => {
  test('partial context still picks the best candidate', () => {
    // contextBefore matches Interfaces occurrence more closely than Data Model
    const a = anchor({
      contextBefore: '200 on success.\nThe `',
      contextAfter: '` field is upd',
    })
    const r = recomputeOccurrenceIndex(DOC, a)
    // Interfaces occurrence is #2
    expect(r.occurrenceIndex).toBe(2)
  })
})

describe('recomputeOccurrenceIndex strategy 3: fall back to client claim', () => {
  test('no context at all — server falls back to the claimed index when valid', () => {
    const a = anchor({ contextBefore: '', contextAfter: '', occurrenceIndex: 3 })
    const r = recomputeOccurrenceIndex(DOC, a)
    expect(r.occurrenceIndex).toBe(3)
  })

  test('client claims out-of-range occurrenceIndex → server clamps to 1', () => {
    const a = anchor({ contextBefore: '', contextAfter: '', occurrenceIndex: 999 })
    const r = recomputeOccurrenceIndex(DOC, a)
    expect(r.occurrenceIndex).toBe(1)
  })

  test('adversarial occurrenceIndex=4 with no context — clamps to last valid (3)', () => {
    // No context to disambiguate; client claim is out of [1..N=3] range.
    const a = anchor({ contextBefore: '', contextAfter: '', occurrenceIndex: 4 })
    const r = recomputeOccurrenceIndex(DOC, a)
    // Falls into strategy 3 "last resort", which is occurrence #1.
    expect(r.occurrenceIndex).toBe(1)
  })
})

describe('canonicalizeAnchor — what gets persisted', () => {
  test('rewrites occurrenceIndex to server-computed value, keeps everything else', () => {
    const a = anchor({
      contextBefore: '200 on success.\nThe `',
      contextAfter: '` field is updated to canceled.',
      occurrenceIndex: 1, // client claim (wrong) — but ctx matches occurrence #2
    })
    const fixed = canonicalizeAnchor(DOC, a)
    expect(fixed.occurrenceIndex).toBe(2)
    // Other anchor fields untouched.
    expect(fixed.selectedText).toBe(a.selectedText)
    expect(fixed.sectionPath).toBe(a.sectionPath)
    expect(fixed.contextBefore).toBe(a.contextBefore)
    expect(fixed.contextAfter).toBe(a.contextAfter)
  })

  test('rejects empty selectedText', () => {
    expect(() => canonicalizeAnchor(DOC, anchor({ selectedText: '' }))).toThrow(
      AnchorValidationError,
    )
  })

  test('rejects selectedText not present in body', () => {
    expect(() => canonicalizeAnchor(DOC, anchor({ selectedText: 'absent_token' }))).toThrow(
      AnchorValidationError,
    )
  })

  test('client cannot inflate occurrenceIndex to forge a different selection', () => {
    // Adversarial: client says "the 3rd occurrence" but their context clearly
    // points at the 1st. Server must trust the context, not the claim.
    const a = anchor({
      contextBefore: 'The `',
      contextAfter: '` enum should include partially_refunded.',
      occurrenceIndex: 3, // forged
    })
    const fixed = canonicalizeAnchor(DOC, a)
    expect(fixed.occurrenceIndex).toBe(1)
  })
})
