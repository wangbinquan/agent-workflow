// RFC-021: lock the CSS contract that makes the task detail page fit
// the viewport. Same shape as `editor-layout-viewport-fit.test.ts`.
//
// Why these as source-level assertions instead of layout assertions: JSDOM
// doesn't run layout. The risk we're guarding against is a future
// "let's reset these styles" cleanup that silently restores 70vh / 520px
// floors and brings the document-level scrollbar back.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const STYLES = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function ruleBody(selector: string): string {
  // Escape every regex metachar so we can match `:has(.x)`, `[hidden]`,
  // `[aria-current='true']` etc. without per-selector special casing.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
  const re = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`)
  const m = STYLES.match(re)
  if (m === null) throw new Error(`rule ${selector} not found in styles.css`)
  return m[1] ?? ''
}

describe('.page--task-detail fits the viewport without a document scrollbar', () => {
  test('locks height to 100% + min-height 0 + overflow hidden (mirror of .page--editor)', () => {
    const body = ruleBody('.page--task-detail')
    expect(body).toMatch(/height:\s*100%/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('.content padding shrinks on task detail pages via :has()', () => {
    const body = ruleBody('.content:has(.page--task-detail)')
    expect(body).toMatch(/padding-top:\s*12px/)
    expect(body).toMatch(/padding-bottom:\s*12px/)
  })

  test('panes wrapper takes the remaining vertical space and can shrink', () => {
    const workspace = ruleBody('.task-detail__workspace')
    expect(workspace).toMatch(/flex:\s*1/)
    expect(workspace).toMatch(/width:\s*100%/)
    expect(workspace).toMatch(/min-width:\s*0/)
    expect(workspace).toMatch(/min-height:\s*0/)
    const body = ruleBody('.task-detail__panes')
    expect(body).toMatch(/flex:\s*1/)
    expect(body).toMatch(/min-height:\s*0/)
  })

  test('top banner stack is bounded and independently scrollable', () => {
    const body = ruleBody('.task-detail__banner-stack')
    expect(body).toMatch(/max-height:\s*min\(32dvh,\s*240px\)/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/overscroll-behavior-y:\s*contain/)

    const item = ruleBody('.task-detail__banner-stack > .task-error-banner')
    expect(item).toMatch(/padding:\s*var\(--space-2\)\s+var\(--space-3\)/)
    expect(item).toMatch(/margin-bottom:\s*0/)
  })

  test('individual panes own their overflow and toggle via [hidden]', () => {
    const pane = ruleBody('.task-detail__pane')
    expect(pane).toMatch(/height:\s*100%/)
    expect(pane).toMatch(/min-height:\s*0/)
    expect(pane).toMatch(/overflow:\s*auto/)
    const hidden = ruleBody(`.task-detail__pane[hidden]`)
    expect(hidden).toMatch(/display:\s*none/)
  })

  test('canvas-frame--task fills its containing tab pane', () => {
    const body = ruleBody('.canvas-frame--task')
    expect(body).toMatch(/height:\s*100%/)
    expect(body).not.toMatch(/height:\s*70vh/)
  })
})

describe('changes pane layout (RFC-239 merged view)', () => {
  // These migrate the pre-merge worktree-diff contracts one-for-one onto the
  // unified changes pane: named inline-size container, row layout that fills
  // the pane, a bounded scrollable sidebar, narrow-pane stacking, and the
  // .diff__file height chain that keeps a long diff scrolling internally.
  test('the real task-detail changes pane exposes its inline width as a named container', () => {
    const body = ruleBody('.task-detail__pane--changes')
    expect(body).toMatch(/container:\s*changes-pane\s*\/\s*inline-size/)
  })

  test('two-column layout fills the pane vertically', () => {
    const body = ruleBody('.changes__body')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex:\s*1/)
    expect(body).toMatch(/min-height:\s*clamp\(22rem,\s*52dvh,\s*34rem\)/)
  })

  // Regression: an expanded AI walkthrough plus the symbol outline could
  // shrink the actual diff/code surface to ~170px on an 817px viewport. The
  // navigation aids must scroll within a bounded budget; code stays primary.
  test('toolbar and review aids cannot consume the code-review height budget', () => {
    const scopeField = ruleBody('.changes__toolbar-field--scope')
    expect(scopeField).toMatch(/flex:\s*0 1 20rem/)

    const scopeSelect = ruleBody('.changes__toolbar-field--scope > .select')
    expect(scopeSelect).toMatch(/width:\s*auto/)
    expect(scopeSelect).toMatch(/min-width:\s*0/)
    expect(scopeSelect).toMatch(/flex:\s*1 1 12rem/)

    const narrative = ruleBody('.changes__narrative')
    expect(narrative).toMatch(/flex:\s*0 0 auto/)
    expect(narrative).toMatch(/max-height:\s*min\(24dvh,\s*180px\)/)
    expect(narrative).toMatch(/min-height:\s*0/)
    expect(narrative).toMatch(/overflow-y:\s*auto/)
    expect(narrative).toMatch(/overscroll-behavior-y:\s*contain/)

    const reviewWorkspace = ruleBody('.changes__review-workspace')
    expect(reviewWorkspace).toMatch(/display:\s*flex/)
    expect(reviewWorkspace).toMatch(/flex:\s*1 1 0%/)
    expect(reviewWorkspace).toMatch(/min-height:\s*0/)

    const codeSurface = ruleBody('.changes__review-surface')
    expect(codeSurface).toMatch(/display:\s*flex/)
    expect(codeSurface).toMatch(/flex:\s*1 1 0%/)
    expect(codeSurface).toMatch(/min-width:\s*0/)
    expect(codeSurface).toMatch(/min-height:\s*0/)

    const outline = ruleBody('.changes__review-workspace > .changes__outline')
    expect(outline).toMatch(/flex:\s*0 0 clamp\(15rem,\s*24cqi,\s*22rem\)/)
    expect(outline).toMatch(/width:\s*auto/)
    expect(outline).toMatch(/max-height:\s*none/)
    expect(outline).toMatch(/overflow-x:\s*hidden/)
    expect(outline).toMatch(/overflow-y:\s*auto/)

    const outlineGroupHeader = ruleBody(
      '.changes__review-workspace > .changes__outline > .structure__group > .structure__group-header',
    )
    expect(outlineGroupHeader).toMatch(/padding-left:\s*0/)

    const outlineGroupMembers = ruleBody(
      '.changes__review-workspace > .changes__outline > .structure__group > .structure__symbols',
    )
    expect(outlineGroupMembers).toMatch(/padding-left:\s*16px/)

    const outlineSymbol = ruleBody(
      '.changes__review-workspace > .changes__outline .structure__symbol',
    )
    expect(outlineSymbol).toMatch(/display:\s*grid/)
    expect(outlineSymbol).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\) auto/)

    const outlineSymbolMain = ruleBody(
      '.changes__review-workspace > .changes__outline .structure__symbol-main',
    )
    expect(outlineSymbolMain).toMatch(/flex-wrap:\s*wrap/)
    expect(outlineSymbolMain).toMatch(/min-width:\s*0/)

    const outlineFold = ruleBody(
      '.changes__review-workspace > .changes__outline .changes__outline-fold',
    )
    expect(outlineFold).toMatch(/width:\s*100%/)
    expect(outlineFold).toMatch(/min-width:\s*0/)
    expect(outlineFold).toMatch(/text-align:\s*left/)

    const outlineLabel = ruleBody(
      '.changes__review-workspace > .changes__outline .changes__outline-label',
    )
    expect(outlineLabel).toMatch(/overflow-wrap:\s*anywhere/)

    const detailStats = ruleBody('.changes__file-head > .changes__file-stats')
    expect(detailStats).toMatch(/margin-left:\s*0/)

    const anchorBar = ruleBody('.changes__anchorbar')
    expect(anchorBar).toMatch(/flex:\s*0 0 auto/)
    expect(anchorBar).toMatch(/flex-wrap:\s*nowrap/)
    expect(anchorBar).toMatch(/overflow-x:\s*auto/)
    expect(anchorBar).toMatch(/overflow-y:\s*hidden/)
    expect(anchorBar).toMatch(/overscroll-behavior-inline:\s*contain/)

    const anchor = ruleBody('.changes__anchor')
    expect(anchor).toMatch(/flex:\s*0 0 auto/)

    expect(STYLES).toMatch(
      /@container\s+changes-pane\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\.changes__review-workspace\s*\{[^}]*flex-direction:\s*column[^}]*\}[\s\S]*?\.changes__review-workspace\s*>\s*\.changes__outline\s*\{[^}]*flex:\s*0 0 auto[^}]*width:\s*100%[^}]*max-height:\s*7rem[^}]*overflow:\s*auto/,
    )
  })

  test('sidebar is a bounded independently scrollable column', () => {
    const body = ruleBody('.changes__sidebar')
    expect(body).toMatch(/flex:\s*0 0 300px/)
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/)
  })

  test('narrow task panes stack the sidebar above a full-width detail column', () => {
    expect(STYLES).toMatch(
      /@container\s+changes-pane\s*\(max-width:\s*880px\)\s*\{[\s\S]*?\.changes__body\s*\{[^}]*flex-direction:\s*column[^}]*min-height:\s*clamp\(46rem,\s*90dvh,\s*60rem\)[^}]*\}[\s\S]*?\.changes__sidebar\s*\{[^}]*flex:\s*0 0 auto[^}]*width:\s*100%[^}]*max-height:\s*12rem/,
    )
  })

  test('main column grows and clips (inner surfaces own their scrolling)', () => {
    const body = ruleBody('.changes__main')
    expect(body).toMatch(/flex:\s*1/)
    expect(body).toMatch(/min-width:\s*0/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('inner .diff__file fills the full main column height (RFC-021 contract carried over)', () => {
    const file = ruleBody('.changes__main .diff__file')
    expect(file).toMatch(/flex:\s*1/)
    expect(file).toMatch(/display:\s*flex/)
    expect(file).toMatch(/flex-direction:\s*column/)
    expect(file).toMatch(/min-width:\s*0/)
    expect(file).toMatch(/min-height:\s*0/)
    const pre = ruleBody('.changes__main .diff__file > .diff__body')
    expect(pre).toMatch(/flex:\s*1/)
    expect(pre).toMatch(/min-height:\s*0/)
    expect(pre).toMatch(/max-height:\s*none/)
    expect(pre).toMatch(/overflow:\s*auto/)
  })

  test('file tab truncates long names with ellipsis (hover title fallback in JSX)', () => {
    const body = ruleBody('.changes__file-name')
    expect(body).toMatch(/white-space:\s*nowrap/)
    expect(body).toMatch(/text-overflow:\s*ellipsis/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('current file selector has a distinct visual via button aria-current', () => {
    expect(STYLES).toMatch(/\.changes__file-tab--active\b/)
    expect(STYLES).toMatch(/\.changes__file-tab\[aria-current='true'\]/)
  })

  test('mobile and coarse pointers get 44px group, file, and viewed targets', () => {
    expect(STYLES).toMatch(
      /@media\s+\(max-width:\s*720px\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.changes__group-header,\s*\.changes__file-tab\s*\{[^}]*min-height:\s*44px/,
    )
    expect(STYLES).toMatch(
      /@media\s+\(max-width:\s*720px\),\s*\(pointer:\s*coarse\)\s*\{[\s\S]*?\.changes__file-row\s*>\s*\.form-checkbox\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/,
    )
  })
})
