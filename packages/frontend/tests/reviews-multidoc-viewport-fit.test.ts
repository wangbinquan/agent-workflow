// Lock the CSS + DOM contract for the multi-document review page.
//
// History:
//  1. The doc rail used to be `position: sticky` + `max-height: calc(100vh -
//     120px)`; the hard-coded 120px underestimated the header so a 24-doc rail
//     spilled past the viewport and forced a whole-page scroll. Fixed by the
//     full-height flex layout (mirror of .page--review-detail).
//  2. RFC-082 retired the bespoke flat comment list (.review-multidoc__scroll /
//     __comments / __doc-pane). The active document now renders through the
//     SHARED <ReviewDocPane> — the same component the single-doc page uses — so
//     each doc gets anchored bubbles / collapse / scroll-spy / jump. The right
//     column (.review-multidoc__pane) just stacks the per-doc accept/reject bar
//     above the pane.
//
// JSDOM doesn't run layout, so these are source-level assertions — they protect
// the full-height layout AND that the multi-doc page keeps reusing ReviewDocPane
// instead of re-growing its own comment UI.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const STYLES = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)
const VIEW = readFileSync(
  join(__dirname, '..', 'src', 'components', 'review', 'MultiDocReviewView.tsx'),
  'utf8',
)

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`)
  const m = STYLES.match(re)
  if (m === null) throw new Error(`rule ${selector} not found in styles.css`)
  return m[1] ?? ''
}

describe('.page.review-multidoc fits the viewport without a document scrollbar', () => {
  test('page is a full-height flex column (mirror of .page--review-detail)', () => {
    const body = ruleBody('.page.review-multidoc')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
    expect(body).toMatch(/height:\s*100%/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('.content padding shrinks on multi-doc review pages via :has()', () => {
    const body = ruleBody('.content:has(.review-multidoc)')
    expect(body).toMatch(/padding-top:\s*12px/)
    expect(body).toMatch(/padding-bottom:\s*12px/)
  })

  test('body grid is rail | pane, fills the remaining height, can shrink', () => {
    const body = ruleBody('.review-multidoc__body')
    expect(body).toMatch(/flex:\s*1/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/)
    // Two tracks: the doc navigator + the right pane column.
    expect(body).toMatch(/grid-template-columns:\s*240px minmax\(0,\s*1fr\)\s*;/)
  })

  test('doc list is a self-contained scroller — NOT sticky + magic vh', () => {
    const body = ruleBody('.review-multidoc__list')
    expect(body).toMatch(/align-self:\s*start/)
    expect(body).toMatch(/max-height:\s*100%/)
    expect(body).toMatch(/overflow:\s*auto/)
    // The exact regressions we replaced: never reintroduce them.
    expect(body).not.toMatch(/position:\s*sticky/)
    expect(body).not.toMatch(/calc\(100vh/)
  })
})

describe('RFC-082 — multi-doc reuses <ReviewDocPane> (no bespoke comment UI)', () => {
  test('the right pane column is a flex column (accept bar + pane fill it)', () => {
    const body = ruleBody('.review-multidoc__pane')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
    expect(body).toMatch(/min-height:\s*0/)
  })

  test('the bespoke flat-comment-list CSS is gone (replaced by ReviewDocPane)', () => {
    // These RFC-079 rules were the self-rolled comment column; they must not
    // come back — the doc body is the shared component now.
    expect(STYLES).not.toMatch(/\.review-multidoc__scroll\s*\{/)
    expect(STYLES).not.toMatch(/\.review-multidoc__doc-pane\s*\{/)
    expect(STYLES).not.toMatch(/\.review-multidoc__comment\b/)
    expect(STYLES).not.toMatch(/\.review-multidoc__comments\b/)
  })

  test('MultiDocReviewView renders <ReviewDocPane> for the active document', () => {
    expect(VIEW).toContain("from '@/components/review/ReviewDocPane'")
    expect(VIEW).toMatch(/<ReviewDocPane\b/)
    // Wired to the active doc + awaiting state.
    expect(VIEW).toMatch(/docVersionId=\{activeDocId\}/)
    expect(VIEW).toMatch(/readonly=\{!awaiting\}/)
    expect(VIEW).toMatch(/onInvalidate=\{invalidate\}/)
  })

  test('MultiDocReviewView no longer hand-rolls the comment list / popover', () => {
    // The bespoke flat list item + its own selection→comment popover are gone;
    // ReviewDocPane owns all of that now.
    expect(VIEW).not.toContain('review-multidoc__comment')
    expect(VIEW).not.toContain('comment-popover')
    expect(VIEW).not.toContain('computeAnchorFromSelection')
  })
})
