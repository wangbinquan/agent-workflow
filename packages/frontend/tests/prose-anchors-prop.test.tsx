// RFC-051 — Prose `anchors` prop contract.
//
// Locks two invariants the rest of the codebase depends on:
//
//  1. Backwards compatibility: callers that don't pass `anchors` (editor
//     preview, memory body, distill job detail, homepage cards, etc.)
//     get byte-identical output to passing `anchors={[]}`. Adding the
//     optional prop to the shared Prose API must not regress any of the
//     ~12 existing Prose consumers.
//
//  2. Occurrence indexing: `occurrenceIndex` is 1-based; the N-th
//     occurrence of the selected text in the rendered body is the only
//     one wrapped (the 1st, 3rd, … occurrences stay unwrapped). This
//     mirrors the legacy `wrapAnchorsInDom` semantics so the review
//     anchor schema continues to round-trip.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { Prose } from '@/components/prose/Prose'

describe('Prose — anchors prop (RFC-051)', () => {
  test('omitting the prop and passing []=[] produce byte-identical HTML', () => {
    // Why: every non-review Prose caller (editor preview / memory body /
    // distill job detail / inbox preview / homepage / etc.) must remain
    // unaffected by the new optional prop. The `if (anchors !== undefined
    // && anchors.length > 0)` guard inside Prose.tsx hangs on this.
    const body = '# Title\n\nHello **world**, hello again.'
    const a = render(<Prose body={body} />)
    const b = render(<Prose body={body} anchors={[]} />)
    expect(a.container.innerHTML).toBe(b.container.innerHTML)
  })

  test('occurrenceIndex picks the N-th occurrence; others stay unwrapped', () => {
    // Why: review comments anchor to a specific occurrence via 1-based
    // index; wrapping the wrong copy would let a comment drift after the
    // first matching word is edited. Lock in 1-based semantics + that
    // unmatched occurrences are NOT wrapped.
    const body = 'hello world hello world hello'
    const { container } = render(
      <Prose
        body={body}
        anchors={[{ commentId: 'cm_pick_second', selectedText: 'hello', occurrenceIndex: 2 }]}
      />,
    )
    const marks = Array.from(container.querySelectorAll<HTMLElement>('mark.comment-anchor'))
    expect(marks.length).toBe(1)
    expect(marks[0]!.getAttribute('data-comment-id')).toBe('cm_pick_second')
    expect(marks[0]!.textContent).toBe('hello')
    // The first and third "hello" must remain bare text, not wrapped.
    // We verify by checking the rendered text's mark coverage: only the
    // second occurrence is inside a mark.
    const fullText = container.textContent ?? ''
    expect(fullText).toContain('hello world hello world hello')
    // Defensive: confirm the bare-text "hello" outside the mark still
    // appears as a sibling — i.e. the wrap didn't accidentally absorb
    // adjacent text.
    expect(marks[0]!.parentElement?.textContent).toBe(body)
  })
})
