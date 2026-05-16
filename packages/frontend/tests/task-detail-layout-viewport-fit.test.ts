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
    const body = ruleBody('.task-detail__panes')
    expect(body).toMatch(/flex:\s*1/)
    expect(body).toMatch(/min-height:\s*0/)
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

describe('worktree diff vertical file tabs', () => {
  test('two-column layout fills the pane vertically', () => {
    const body = ruleBody('.worktree-diff')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*row/)
    expect(body).toMatch(/height:\s*100%/)
    expect(body).toMatch(/min-height:\s*0/)
  })

  test('left file list is a fixed-width independently scrollable column', () => {
    const body = ruleBody('.worktree-diff__files')
    expect(body).toMatch(/flex:\s*0 0 280px/)
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(body).toMatch(/min-height:\s*0/)
  })

  test('left file list reads as a full-height panel (border on all sides + bg)', () => {
    // Without these the column was technically 100% tall but only the
    // 1px right border was visible, so the empty space below the last
    // file tab looked like "the box isn't filled". Lock the panel look
    // so a future style cleanup doesn't quietly revert.
    const body = ruleBody('.worktree-diff__files')
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/)
    expect(body).toMatch(/border-radius:\s*6px/)
    expect(body).toMatch(/background:\s*var\(--bg\)/)
    expect(body).not.toMatch(/border-right:\s*1px solid var\(--border\)/)
  })

  test('right body grows + independently scrolls + can shrink horizontally', () => {
    const body = ruleBody('.worktree-diff__body')
    expect(body).toMatch(/flex:\s*1/)
    expect(body).toMatch(/min-width:\s*0/)
    expect(body).toMatch(/overflow:\s*auto/)
  })

  test('file tab truncates long paths with ellipsis (hover title fallback in JSX)', () => {
    const body = ruleBody('.worktree-diff__file-tab')
    expect(body).toMatch(/white-space:\s*nowrap/)
    expect(body).toMatch(/text-overflow:\s*ellipsis/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('selected file tab has a distinct visual via [aria-selected=true]', () => {
    // Both the BEM modifier and the aria-state selectors should resolve to
    // styling rules — protects against either being deleted alone.
    expect(STYLES).toMatch(/\.worktree-diff__file-tab--active\b/)
    expect(STYLES).toMatch(/\.worktree-diff__file-tab\[aria-selected='true'\]/)
  })
})
