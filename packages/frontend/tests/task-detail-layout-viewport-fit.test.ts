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
  // `[aria-selected='true']` etc. without per-selector special casing.
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
    expect(body).toMatch(/min-height:\s*0/)
  })

  test('sidebar is a bounded independently scrollable column', () => {
    const body = ruleBody('.changes__sidebar')
    expect(body).toMatch(/flex:\s*0 0 300px/)
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/)
  })

  test('narrow task panes stack the sidebar above a full-width detail column', () => {
    expect(STYLES).toMatch(
      /@container\s+changes-pane\s*\(max-width:\s*880px\)\s*\{[\s\S]*?\.changes__body\s*\{[^}]*flex-direction:\s*column[^}]*\}[\s\S]*?\.changes__sidebar\s*\{[^}]*flex:\s*0 0 auto[^}]*width:\s*100%[^}]*max-height:\s*12rem/,
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

  test('selected file tab has a distinct visual via [aria-selected=true]', () => {
    expect(STYLES).toMatch(/\.changes__file-tab--active\b/)
    expect(STYLES).toMatch(/\.changes__file-tab\[aria-selected='true'\]/)
  })
})
