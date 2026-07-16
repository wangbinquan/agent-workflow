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

describe('worktree diff vertical file tabs', () => {
  test('the real task-detail diff pane exposes its inline width as a named container', () => {
    const body = ruleBody('.task-detail__pane--worktree-diff')
    expect(body).toMatch(/container:\s*worktree-diff-pane\s*\/\s*inline-size/)
  })

  test('two-column layout fills the pane vertically', () => {
    const body = ruleBody('.worktree-diff')
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*row/)
    expect(body).toMatch(/height:\s*100%/)
    expect(body).toMatch(/width:\s*100%/)
    expect(body).toMatch(/min-width:\s*0/)
    expect(body).toMatch(/min-height:\s*0/)
  })

  // Regression: a fixed 280px rail made the actual diff frame unnecessarily
  // narrow at laptop / split-window widths. Keep the tree readable, but let it
  // yield a predictable share of the row to the primary diff surface.
  test('left file list is a bounded responsive independently scrollable column', () => {
    const body = ruleBody('.worktree-diff__files')
    expect(body).toMatch(/flex:\s*0 1 clamp\(220px,\s*24%,\s*280px\)/)
    expect(body).not.toMatch(/flex:\s*0 0 280px/)
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

  test('narrow task panes stack the file rail above a full-width diff body', () => {
    expect(STYLES).toMatch(
      /@container\s+worktree-diff-pane\s*\(max-width:\s*880px\)\s*\{[\s\S]*?\.worktree-diff\s*\{[^}]*flex-direction:\s*column[^}]*\}[\s\S]*?\.worktree-diff__files\s*\{[^}]*flex:\s*0 0 auto[^}]*width:\s*100%[^}]*max-height:\s*12rem/,
    )
  })

  test('right body grows + lays inner card out as a flex column', () => {
    // Outer body itself doesn't scroll — it just sizes the inner
    // .diff__file card, which then handles vertical overflow internally
    // via its <pre>.  Locking this keeps a future "let's just give body
    // overflow:auto and let things stack" regression from coming back.
    const body = ruleBody('.worktree-diff__body')
    expect(body).toMatch(/flex:\s*1/)
    expect(body).toMatch(/min-width:\s*0/)
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/overflow:\s*hidden/)
  })

  test('inactive file tabpanels do not participate in the flex row', () => {
    const body = ruleBody('.worktree-diff__body[hidden]')
    expect(body).toMatch(/display:\s*none/)
  })

  test('inner .diff__file fills the full right column height (RFC-021 contract)', () => {
    // Without these rules the .diff__file was intrinsic-content-sized
    // and its <pre> hit a 480px max-height cap, leaving ~190px of empty
    // space at the bottom of the right column.
    const file = ruleBody('.worktree-diff__body > .diff__file')
    expect(file).toMatch(/flex:\s*1/)
    expect(file).toMatch(/display:\s*flex/)
    expect(file).toMatch(/flex-direction:\s*column/)
    // A <pre> has a very large min-content width. Without min-width:0 on its
    // flex parent, the card grows past the body and the body's overflow:hidden
    // clips the frame instead of leaving scrolling to .diff__body.
    expect(file).toMatch(/min-width:\s*0/)
    expect(file).toMatch(/min-height:\s*0/)
    const pre = ruleBody('.worktree-diff__body > .diff__file > .diff__body')
    expect(pre).toMatch(/flex:\s*1/)
    expect(pre).toMatch(/min-height:\s*0/)
    // Explicit override of the legacy 480px cap that ships with .diff__body.
    expect(pre).toMatch(/max-height:\s*none/)
    expect(pre).toMatch(/overflow:\s*auto/)
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
