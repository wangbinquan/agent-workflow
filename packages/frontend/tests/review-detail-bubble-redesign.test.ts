// Source-code-level regression locks for the review-detail bubble redesign.
//
// User report (May 2026): the review-detail right sidebar listed comments
// in fixed top-to-bottom order in a sticky `<aside>` and used bare default
// browser styling (.comment-list__* had no CSS rules), so:
//   1. comments did not follow their anchored text as the document scrolled,
//   2. the sidebar rendered as an ugly bullet list / unstyled blockquote.
// We replaced the sidebar with a bubble column where each `<article
// class="comment-bubble">` is positioned absolutely at the vertical offset
// of its anchor's `<mark.comment-anchor data-comment-id>` in the rendered
// markdown body — so they ride the document scroll naturally — and added
// real CSS for the bubble cards.
//
// These tests lock that swap in at the source-text level (jsdom can't
// evaluate computed layout, and the bubble-position effect needs a real
// browser layout engine to produce non-zero rects). If a future refactor
// drops the bubble redesign and reintroduces the old class names, these
// assertions fail immediately.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROUTE_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')
const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
// RFC-082: the bubble column + sortedComments + scroll remeasure + data-active
// wiring moved into the shared <ReviewDocPane>. The new bubble JSX is asserted
// there; the route negatives (old comment-list gone) still hold on the route.
const PANE_TSX = resolve(__dirname, '..', 'src', 'components', 'review', 'ReviewDocPane.tsx')

describe('review-detail bubble redesign', () => {
  test('reviews.detail.tsx no longer renders the old <ul class="comment-list">', () => {
    const src = readFileSync(ROUTE_TSX, 'utf8')
    expect(src).not.toContain('comment-list__item')
    expect(src).not.toContain('comment-list__section')
    expect(src).not.toContain('comment-list__selection')
    expect(src).not.toContain('comment-list__body')
    // The wrapping <aside class="review-detail__sidebar"> is also gone.
    // Negative-lookahead suffix so RFC-009's family of related classes
    // (review-detail__sidebar-header / -toggle / -resizer / -count, all
    // genuinely new names) does not trip this assertion.
    expect(src).not.toMatch(/\breview-detail__sidebar(?![-\w])/)
  })

  test('ReviewDocPane renders the bubble column with bubble articles', () => {
    const src = readFileSync(PANE_TSX, 'utf8')
    expect(src).toContain('review-detail__bubbles')
    expect(src).toContain('comment-bubble')
    expect(src).toContain('comment-bubble__section')
    expect(src).toContain('comment-bubble__quote')
    expect(src).toContain('comment-bubble__body')
    // RFC-051: anchors are wrapped inside the React tree via `<Prose anchors>`
    // (rehypeWrapAnchors), not a post-mount wrapAnchorsInDom call — see the
    // dedicated reviews-detail-anchor-rehype lock.
    expect(src).toContain('proseAnchors')
  })

  test('styles.css drops the sticky sidebar and adds bubble styling', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    // The old .review-detail__sidebar rule and its sticky positioning are gone.
    expect(css).not.toMatch(/\.review-detail__sidebar\s*\{/)
    // The new bubble column + bubble card + anchor highlight rules are present.
    expect(css).toMatch(/\.review-detail__bubbles\s*\{/)
    expect(css).toMatch(/\.comment-bubble\s*\{/)
    expect(css).toMatch(/\.comment-bubble--active\s*\{/)
    expect(css).toMatch(/mark\.comment-anchor\s*\{/)
    // Bubbles are absolutely positioned inside the relative column — that's
    // what makes them ride document scroll without any JS scroll-sync.
    expect(css).toMatch(/\.comment-bubble\s*\{[^}]*position:\s*absolute/)
    expect(css).toMatch(/\.review-detail__bubbles\s*\{[^}]*position:\s*relative/)
    // The popover is no longer unstyled (it used to fall back to browser default).
    expect(css).toMatch(/\.comment-popover\s*\{/)
  })

  test('styles.css fixes the column width per design decision (280px)', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(
      /\.review-detail__layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*280px/,
    )
  })

  test('styles.css insets the layout right edge so bubble borders clear the scrollbar', () => {
    // RFC-082 fix: `.comment-bubble { right: 0 }` sat flush against the layout's
    // right edge, where the (macOS overlay) vertical scrollbar lives + where
    // `overflow-x: hidden` clips — so the bubble's right border / rounded corner
    // / shadow got cut ("评审意见框右边框出界"). A padding-right keeps them clear.
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.review-detail__layout\s*\{[^}]*padding-right:\s*\d+px/)
  })

  test('styles.css stacks bubbles vertically on narrow viewports', () => {
    // Below 720px the absolute positioning collapses so the bubbles flow
    // normally under the document — matches the existing mobile fallback
    // the original sidebar had.
    const css = readFileSync(STYLES_CSS, 'utf8')
    const mediaIdx = css.indexOf('@media (max-width: 720px)')
    expect(mediaIdx).toBeGreaterThan(-1)
    const mediaBlock = css.slice(mediaIdx)
    expect(mediaBlock).toMatch(/\.comment-bubble\s*\{[^}]*position:\s*static/)
  })

  // Locks in the second-round feedback from the user (May 2026): bubbles
  // must (a) be ordered by where their anchor sits in the reviewed text,
  // (b) follow the document as the user scrolls, (c) highlight the
  // anchored text when their bubble is clicked.
  test('ReviewDocPane renders comments sorted by anchor.offsetStart', () => {
    const src = readFileSync(PANE_TSX, 'utf8')
    // A `sortedComments` memo exists and sorts by offsetStart with
    // occurrenceIndex as tiebreaker.
    expect(src).toMatch(/sortedComments/)
    expect(src).toMatch(/anchor\.offsetStart\s*-\s*[ab]\.anchor\.offsetStart|offsetStart\s*-/)
    // The bubble-column JSX iterates sortedComments, not the raw
    // detail.data.comments array.
    expect(src).toMatch(/sortedComments\.map\(/)
  })

  test('ReviewDocPane remeasures bubble positions on scroll', () => {
    // Both the bubble column and the markdown body live in the same
    // .content scroll container, so the (anchor.top - col.top) math is
    // invariant under scroll *today* — but if any container later
    // introduces its own overflow:auto the bubbles would drift. The
    // scroll listener is cheap insurance.
    const src = readFileSync(PANE_TSX, 'utf8')
    expect(src).toMatch(/addEventListener\(\s*'scroll'/)
    // Must use the capture phase — scroll events don't bubble.
    expect(src).toMatch(/'scroll'[^)]*,\s*true\s*\)/)
  })

  test('ReviewDocPane wires click-bubble → highlight-anchor-text', () => {
    const src = readFileSync(PANE_TSX, 'utf8')
    // An effect toggles data-active on the matching mark when
    // activeCommentId changes.
    expect(src).toMatch(/data-active/)
    expect(src).toMatch(/setAttribute\(\s*'data-active'/)
  })

  test('styles.css paints the active anchor with a stronger highlight', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/mark\.comment-anchor\[data-active=['"]true['"]\]\s*\{/)
  })
})
