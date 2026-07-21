// Locks in RFC-009 review sidebar enhancements (inline edit, copy,
// collapse, resize, line-ref, count badge).
//
// We use source-text + CSS-text assertions for the same reason the d9072c6
// `review-detail-bubble-redesign.test.ts` does: jsdom can't compute layout
// for the absolute-positioned bubbles, and standing up a full
// RouterProvider + QueryClient + ws-mock harness around reviews.detail.tsx
// is heavy-handed for what amounts to "did the right classes / handlers
// stay wired up". Pure functions (computeLineRange) and pure hooks live
// in their own test files.
//
// If any of these fail, RFC-009's feature surface in reviews.detail.tsx
// has drifted; fix the route or update this file with intent.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// RFC-082: the whole RFC-009 sidebar surface (resize/collapse/inline-edit/copy/
// line-ref/measure) moved into the shared <ReviewDocPane>. Assert it there; the
// CSS + useResizable hook are unchanged.
const PANE_TSX = resolve(__dirname, '..', 'src', 'components', 'review', 'ReviewDocPane.tsx')
const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const USE_RESIZABLE = resolve(__dirname, '..', 'src', 'hooks', 'useResizable.ts')

describe('RFC-009 sidebar enhancements — ReviewDocPane surface', () => {
  test('reviews.detail.tsx wires the useResizable hook + bounds constants', () => {
    const src = readFileSync(PANE_TSX, 'utf8')
    expect(src).toContain("from '@/hooks/useResizable'")
    expect(src).toMatch(/useResizable\(\s*\{/)
    expect(src).toContain('storageKey: SIDEBAR_WIDTH_KEY')
    // Width clamp constants are committed as named constants so they're
    // greppable and reviewable.
    expect(src).toMatch(/SIDEBAR_WIDTH_DEFAULT\s*=\s*280/)
    expect(src).toMatch(/SIDEBAR_WIDTH_MIN\s*=\s*240/)
    expect(src).toMatch(/SIDEBAR_WIDTH_MAX\s*=\s*520/)
    expect(src).toMatch(/SIDEBAR_COLLAPSED_PX\s*=\s*32/)
  })

  test('reviews.detail.tsx persists collapsed state to localStorage', () => {
    const src = readFileSync(PANE_TSX, 'utf8')
    expect(src).toContain("SIDEBAR_COLLAPSED_KEY = 'agw-review-sidebar-collapsed'")
    expect(src).toContain("SIDEBAR_WIDTH_KEY = 'agw-review-sidebar-width'")
    expect(src).toMatch(/setItem\(SIDEBAR_COLLAPSED_KEY/)
  })

  test('reviews.detail.tsx renders the collapsed rail when collapsed === true', () => {
    const src = readFileSync(PANE_TSX, 'utf8')
    expect(src).toContain('comments-collapsed-rail')
    expect(src).toContain('comments-collapsed-rail__toggle')
    expect(src).toContain('comments-collapsed-rail__count')
    // The expanded sidebar still has the resizer + sticky header.
    expect(src).toContain('review-detail__sidebar-resizer')
    expect(src).toContain('review-detail__sidebar-header')
    expect(src).toContain('review-detail__sidebar-toggle')
    expect(src).toContain('review-detail__sidebar-count')
  })

  test('reviews.detail.tsx renders the action toolbar (edit / copy / delete)', () => {
    const src = readFileSync(PANE_TSX, 'utf8')
    expect(src).toContain('comment-bubble__actions')
    expect(src).toContain('comment-bubble__action')
    // Delete button still present (we kept the original class).
    expect(src).toContain('comment-bubble__delete')
    // Three action labels exist in the i18n round-trip.
    expect(src).toContain("t('reviews.commentEdit')")
    expect(src).toContain("t('reviews.commentCopy')")
    expect(src).toMatch(/t\(\s*'common\.delete'\s*\)/)
  })

  test('reviews.detail.tsx wires the inline-edit form with Cmd/Ctrl+Enter + Esc', () => {
    const src = readFileSync(PANE_TSX, 'utf8')
    expect(src).toContain('comment-bubble__edit-form')
    expect(src).toContain('comment-bubble--editing')
    expect(src).toContain('updateComment')
    expect(src).toMatch(/api\.patch\(/)
    // Cmd/Ctrl+Enter saves, Escape cancels — same shape as the popover.
    expect(src).toMatch(/e\.key\s*===\s*'Enter'\s*&&\s*\(e\.ctrlKey\s*\|\|\s*e\.metaKey\)/)
    expect(src).toMatch(/e\.key\s*===\s*'Escape'/)
    // Single-key shortcuts (J/K) must not fire while editing — the pane's
    // keyboard handler bails on editingId.
    expect(src).toMatch(/if\s*\(\s*editingId\s*!==\s*null\s*\)\s*return/)
  })

  test('reviews.detail.tsx wires the copy button through copyText with feedback', () => {
    // 2026-07-21: the direct Clipboard API dereference moved behind
    // lib/clipboard.ts#copyText (secure-context fallback); the repo-wide ban
    // lives in clipboard-insecure-context.test.ts.
    const src = readFileSync(PANE_TSX, 'utf8')
    expect(src).toMatch(/copyText\(/)
    expect(src).toContain("from '@/lib/clipboard'")
    expect(src).toContain('copiedId')
    expect(src).toContain('copyFailedId')
    // Transient label flicker — checked indirectly via the i18n key list.
    expect(src).toContain("t('reviews.commentCopied')")
    expect(src).toContain("t('reviews.commentCopyFailed')")
  })

  test('reviews.detail.tsx renders the line-ref chip + count badge', () => {
    const src = readFileSync(PANE_TSX, 'utf8')
    expect(src).toContain('comment-bubble__line-ref')
    expect(src).toContain("from '@/lib/review/lineRange'")
    expect(src).toContain('computeLineRange')
    // Single vs. multi-line variants both exist.
    expect(src).toContain("t('reviews.lineRef'")
    expect(src).toContain("t('reviews.lineRefRange'")
    // Count badge label.
    expect(src).toContain("t('reviews.sidebarCountLabel'")
  })

  test('ReviewDocPane bails out of measure() when collapsed', () => {
    const src = readFileSync(PANE_TSX, 'utf8')
    // RFC-082: the measure useLayoutEffect lives in the useCommentBubbles hook
    // and early-returns when `!enabled`; `enabled` folds in the collapsed +
    // diff guards so a 0-height (collapsed) column never gets measured.
    expect(src).toMatch(/if\s*\(!enabled\)\s*return/)
    expect(src).toMatch(/enabled:\s*!diffActive\s*&&\s*!collapsed/)
    // And measure re-runs when those inputs / editingId toggle (so the
    // expanding textarea pushes lower bubbles down before the per-bubble
    // ResizeObserver kicks in).
    expect(src).toMatch(
      /\[markdownRef,\s*bubblesRef,\s*sortedComments,\s*enabled,\s*sidebarWidth,\s*editingId\]/,
    )
    // Per-bubble ResizeObserver — bubble grows when its inline editor opens,
    // and the column's own minHeight masks the change from a column-level
    // observer.
    expect(src).toMatch(/querySelectorAll[^)]*'\.comment-bubble'[^)]*\)/)
    expect(src).toMatch(/\.forEach\(\(b\)\s*=>\s*ro\.observe\(b\)/)
  })

  test('reviews.detail.tsx offsets the bubble cursor by the sticky header', () => {
    // Hot-fix locked in after the initial RFC-009 landing: the first bubble
    // was sliding under the sticky sidebar header because measure() started
    // its cursor at 0 (= column top = header top). The fix reads the
    // header element's offsetHeight once per measure pass and uses that
    // value as the cursor floor. If a future refactor reverts this, the
    // first comment overlaps the count badge again.
    const src = readFileSync(PANE_TSX, 'utf8')
    // Grabs the header element and reads offsetHeight.
    expect(src).toMatch(/querySelector[^)]*review-detail__sidebar-header/)
    expect(src).toMatch(/headerEl[^.]*\.offsetHeight/)
    // RFC-082: the floor is handed to computeBubbleLayout (whose
    // review-bubble-layout.test.ts locks `cursor = headerFloor` as the start),
    // so the first bubble can never sit under the sticky header.
    expect(src).toMatch(/computeBubbleLayout\(\{[\s\S]*?headerFloor/)
    // And the floor itself includes the BUBBLE_GAP_PX clearance.
    expect(src).toMatch(/headerFloor[\s\S]{0,80}BUBBLE_GAP_PX/)
  })
})

describe('RFC-009 sidebar enhancements — CSS surface', () => {
  test('styles.css declares the new sidebar classes', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.review-detail__sidebar-header\s*\{[^}]*position:\s*sticky/)
    expect(css).toMatch(/\.review-detail__sidebar-resizer\s*\{[^}]*cursor:\s*col-resize/)
    expect(css).toMatch(/\.review-detail__sidebar-toggle\s*\{/)
    expect(css).toMatch(/\.comments-collapsed-rail\s*\{/)
    expect(css).toMatch(/\.comment-bubble__actions\s*\{/)
    expect(css).toMatch(/\.comment-bubble__action\s*\{/)
    expect(css).toMatch(/\.comment-bubble__edit-form\s*\{/)
    expect(css).toMatch(/\.comment-bubble__line-ref\s*\{/)
  })

  test('styles.css action toolbar is a static-flow row, not absolute', () => {
    // Iteration after first user review: reserving 76px of right padding on
    // the bubble for the absolutely-positioned action row was visually ugly
    // and squeezed text. The actions are now an in-flow flex row above the
    // section header — they take vertical height instead of horizontal
    // padding, so quote / body / section path get the full bubble width.
    const css = readFileSync(STYLES_CSS, 'utf8')
    // Must NOT use absolute positioning anymore.
    expect(css).not.toMatch(/\.comment-bubble__actions\s*\{[^}]*position:\s*absolute/)
    // Must declare flex layout with right-alignment.
    expect(css).toMatch(
      /\.comment-bubble__actions\s*\{[^}]*display:\s*flex[^}]*justify-content:\s*flex-end/,
    )
  })

  test('.comment-bubble padding-right is symmetric (actions no longer overlay)', () => {
    // Once the action row moved into the bubble's normal flow above the
    // section header, the wide 80px right padding was unnecessary — it
    // just squeezed text. Lock in a small (≤ 16px) padding-right so any
    // future revert to the absolutely-positioned action row would fail
    // here and force a conscious choice.
    const css = readFileSync(STYLES_CSS, 'utf8')
    const m = css.match(/\.comment-bubble\s*\{[^}]*padding:\s*\d+px\s+(\d+)px\s+\d+px\s+\d+px/)
    expect(m).not.toBeNull()
    const rightPad = Number.parseInt(m![1]!, 10)
    expect(rightPad).toBeLessThanOrEqual(16)
  })

  test('useResizable hook exists and clamps width to [min, max]', () => {
    const src = readFileSync(USE_RESIZABLE, 'utf8')
    expect(src).toContain('export function useResizable')
    // Clamp logic: Math.max(min, Math.min(max, n)).
    expect(src).toMatch(/Math\.max\(min,\s*Math\.min\(max,\s*n\)\)/)
    // Pointer-driven drag with global pointermove/up listeners.
    expect(src).toContain('pointermove')
    expect(src).toContain('pointerup')
    // Restores cursor on release.
    expect(src).toMatch(/cursor\s*=\s*['"]col-resize['"]/)
  })
})
