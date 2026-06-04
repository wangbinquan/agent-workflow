// RFC-051 — Review-detail anchor wrapping goes through the React tree,
// not via post-mount DOM mutation.
//
// Three regression locks:
//
//  1. React-managed marks: `<Prose anchors={...}>` renders the
//     `<mark class="comment-anchor" data-comment-id="...">` element via
//     react-markdown, not via an external DOM mutation. This is the
//     contract the bubble layout / scroll-spy / `data-active` logic
//     depends on (they look up marks with the same CSS selector).
//
//  2. A → B → A rerender doesn't throw: the user-reported crash
//     ("clicking review A → review B → review A turns the page white
//     with NotFoundError: removeChild") was the legacy
//     `wrapAnchorsInDom(useLayoutEffect)` mutating react-managed DOM and
//     conflicting with reconciliation on the next body change. Swapping
//     to the rehype path means React owns the DOM end-to-end and the
//     scenario must rerender cleanly.
//
//  3. Source-level: reviews.detail.tsx must NOT call `wrapAnchorsInDom`.
//     If a future revert accidentally re-introduces the external DOM
//     mutation path the assertion fails immediately.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Prose } from '@/components/prose/Prose'

const ROUTE_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')

describe('reviews.detail anchor wrap goes through React tree (RFC-051)', () => {
  test('marks land in DOM via react-markdown render (not via post-mount mutation)', () => {
    // Why: bubble layout + scroll-spy + data-active all use the
    // `mark.comment-anchor[data-comment-id="..."]` selector. We need
    // that selector to keep matching, but the elements MUST be react-
    // rendered (so reconciliation owns their lifetime). Verifying both
    // points in one shot: render-only assertion + selector hit.
    const { container } = render(
      <Prose
        body="Lorem ipsum dolor sit amet."
        anchors={[{ commentId: 'cm_lorem', selectedText: 'ipsum', occurrenceIndex: 1 }]}
      />,
    )
    const mark = container.querySelector<HTMLElement>(
      'mark.comment-anchor[data-comment-id="cm_lorem"]',
    )
    expect(mark).not.toBeNull()
    expect(mark?.textContent).toBe('ipsum')
    // The mark is inside `.prose` — i.e. it's part of the react tree
    // that Prose returned, not a node grafted in by a side-effect.
    expect(mark?.closest('.prose')).not.toBeNull()
  })

  test("rerender across body+anchors A → B → A doesn't throw NotFoundError", () => {
    // Why: this is the user-reported crash. Pre-fix, switching documents
    // while the legacy `wrapAnchorsInDom` had inserted marks into the
    // existing DOM would trip react reconciliation on the next render
    // with "Failed to execute 'removeChild' on 'Node': The node to be
    // removed is not a child of this node". With the rehype path,
    // rerendering with new body+anchors should complete cleanly because
    // React owns every DOM node.
    const bodyA = 'alpha bravo charlie'
    const bodyB = 'delta echo foxtrot'
    const anchorsA = [{ commentId: 'cm_a', selectedText: 'bravo', occurrenceIndex: 1 }]
    const anchorsB = [{ commentId: 'cm_b', selectedText: 'echo', occurrenceIndex: 1 }]
    const { container, rerender } = render(<Prose body={bodyA} anchors={anchorsA} />)
    expect(container.querySelector('mark[data-comment-id="cm_a"]')).not.toBeNull()
    // Switch to B — old code would throw here.
    rerender(<Prose body={bodyB} anchors={anchorsB} />)
    expect(container.querySelector('mark[data-comment-id="cm_b"]')).not.toBeNull()
    expect(container.querySelector('mark[data-comment-id="cm_a"]')).toBeNull()
    // And back to A — old code would throw here on the second crossing.
    rerender(<Prose body={bodyA} anchors={anchorsA} />)
    expect(container.querySelector('mark[data-comment-id="cm_a"]')).not.toBeNull()
    expect(container.querySelector('mark[data-comment-id="cm_b"]')).toBeNull()
  })

  test('source-level: reviews.detail.tsx no longer calls wrapAnchorsInDom', () => {
    // Why: AC-4. The bug is rooted in the external DOM mutation; we
    // must guarantee it stays gone. A future revert is the most likely
    // regression path (someone reads the legacy comment "wrap each
    // anchor in <mark>" and re-wires it), so a grep guard is cheap and
    // catches that immediately. The utility module itself stays alive
    // (still used by `anchor.ts` for selection→anchor computation) so
    // we only assert against the route file.
    const src = readFileSync(ROUTE_TSX, 'utf8')
    expect(src).not.toMatch(/\bwrapAnchorsInDom\s*\(/)
    expect(src).not.toContain("from '@/lib/review/wrapAnchorsInDom'")
    // RFC-082: the <Prose anchors> render moved into <ReviewDocPane>; the new
    // rehype-anchor path (no wrapAnchorsInDom) is wired up there. `diffActive`
    // is the pane's diff flag (host passes diffMode through).
    const pane = readFileSync(
      resolve(__dirname, '..', 'src', 'components', 'review', 'ReviewDocPane.tsx'),
      'utf8',
    )
    expect(pane).not.toMatch(/\bwrapAnchorsInDom\s*\(/)
    expect(pane).toContain('anchors={diffActive ? undefined : proseAnchors}')
  })
})
