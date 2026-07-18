// Locks in the review detail page layout fixes reported on
// /reviews/01KRPE30VQT3R4G24PV3ZAG82D and the May 2026 follow-ups:
//   1. The comment column must sit on the right via a grid layout in
//      styles.css. (Originally an <aside class="review-detail__sidebar">;
//      after the May 2026 bubble-redesign feedback it became
//      <div class="review-detail__bubbles"> — see review-detail-bubble-
//      redesign.test.ts for the bubble-specific locks.)
//   2. The three decision buttons (approve / iterate / reject) used to
//      sit in a bottom `.review-detail__footer`. May 2026 user feedback
//      pinned them to the top-right of the page so they're always visible
//      and only the document + comment column scroll. This file locks the
//      new shape: page is a flex column locked to viewport height, layout
//      grid is `flex: 1` + overflow auto, decision buttons live in the
//      header actions cluster, and the old `.review-detail__footer` CSS
//      rule is gone.
//   3. Buttons must NOT carry inline `<kbd>A|I|R</kbd>` keyboard hints —
//      the keyboard handler in the route's useEffect still fires for those
//      letters, but the visual hint inside the button label is gone.
//
// Source-text assertions only (per CLAUDE.md §Test-with-every-change "源
// 代码层文本断言"): JSDOM can't evaluate CSS positioning, so the lowest-cost
// regression guard is to pin the CSS rules and the JSX shape directly. If
// any of these flip back, the user's feedback re-emerges immediately.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const REVIEWS_DETAIL_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')
// RFC-082: the comment sidebar (jump buttons, jumpComment, scroll-spy) moved
// into the shared <ReviewDocPane>; those assertions read the pane now.
const PANE_TSX = resolve(__dirname, '..', 'src', 'components', 'review', 'ReviewDocPane.tsx')

describe('review detail layout — sidebar position + top-right action cluster + no kbd', () => {
  test('styles.css declares the .review-detail__layout grid with a fixed right column', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.review-detail__layout\s*\{[^}]*display:\s*grid/)
    expect(css).toMatch(
      /\.review-detail__layout\s*\{[^}]*grid-template-columns:[^}]*1fr[^}]*var\(--review-sidebar-width,\s*280px\)/,
    )
  })

  test('resizable width uses a custom property so the mobile media query can override the grid', () => {
    const pane = readFileSync(PANE_TSX, 'utf8')
    expect(pane).toContain("'--review-sidebar-width'")
    expect(pane).not.toMatch(/style=\{[^}]*gridTemplateColumns/s)
  })

  test('styles.css declares the right comment column as a relative positioning context', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.review-detail__bubbles\s*\{[^}]*position:\s*relative/)
  })

  test('styles.css locks the review-detail page to viewport height with an internally scrolling layout', () => {
    // The page itself stops scrolling; the layout grid becomes the single
    // scrollable region so the action cluster stays pinned at the top.
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.page--review-detail\s*\{[^}]*height:\s*100%/)
    expect(css).toMatch(/\.page--review-detail\s*\{[^}]*overflow:\s*hidden/)
    // Vertical scroll only — a horizontal scrollbar on the layout would be
    // wrong since wide markdown elements (pre/table/math) have their own
    // `overflow-x: auto` inside `.prose`.
    expect(css).toMatch(/\.review-detail__layout\s*\{[^}]*overflow-y:\s*auto/)
    expect(css).toMatch(/\.review-detail__layout\s*\{[^}]*overflow-x:\s*hidden/)
    expect(css).toMatch(/\.review-detail__layout\s*\{[^}]*flex:\s*1/)
  })

  test('styles.css no longer ships the old .review-detail__footer rule', () => {
    // The bottom footer was removed when the buttons moved to the header.
    // Keeping the rule would just be dead CSS — guard against re-adding it.
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).not.toMatch(/\.review-detail__footer\s*\{/)
  })

  test('reviews.detail.tsx renders the decision buttons inside the page header actions cluster', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    // The decision buttons cluster wraps Approve / Iterate / Reject and
    // lives inside `.review-detail__page-header-actions` (next to the
    // download button). The cluster must NOT live inside the old
    // `<footer className="review-detail__footer">` block.
    expect(tsx).toMatch(/review-detail__decision-actions/)
    expect(tsx).not.toMatch(/review-detail__footer/)
  })

  test('reviews.detail.tsx does not render <kbd> shortcut hints inside the decision buttons', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).not.toMatch(/reviews\.approveButton'\)\}\s*<kbd>A<\/kbd>/)
    expect(tsx).not.toMatch(/reviews\.iterateButton'\)\}\s*<kbd>I<\/kbd>/)
    expect(tsx).not.toMatch(/reviews\.rejectButton'\)\}\s*<kbd>R<\/kbd>/)
  })

  test('reviews.detail.tsx keeps the A/I/R keyboard handler — feature is still keyboard-driven', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).toMatch(/if \(k === 'a'\) void onApprove\(\)/)
    expect(tsx).toMatch(/else if \(k === 'r'\) void onReject\(\)/)
    expect(tsx).toMatch(/else if \(k === 'i'\) void onIterate\(\)/)
  })

  test('A/I/R decisions ignore every modified key chord', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    const handler = tsx.slice(
      tsx.indexOf('const onKey = (e: KeyboardEvent)'),
      tsx.indexOf('const k = e.key.toLowerCase()'),
    )
    expect(handler).toMatch(/e\.metaKey/)
    expect(handler).toMatch(/e\.ctrlKey/)
    expect(handler).toMatch(/e\.altKey/)
    expect(handler).toMatch(/e\.shiftKey/)
    expect(handler).toMatch(/return/)
  })
})

describe('review detail decision dialog — replaces window.confirm / prompt / alert', () => {
  test('reviews.detail.tsx no longer uses native confirm / prompt / alert for the three decisions', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).not.toMatch(/window\.confirm\([^)]*reviews\.approveDraft/)
    expect(tsx).not.toMatch(/window\.confirm\([^)]*reviews\.iterate/)
    expect(tsx).not.toMatch(/window\.prompt\([^)]*reviews\.rejectPrompt/)
    expect(tsx).not.toMatch(/window\.alert/)
  })

  test('reviews.detail.tsx mounts the DecisionDialog component', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).toMatch(/function DecisionDialog\(/)
    expect(tsx).toMatch(/<DecisionDialog/)
  })

  test('DecisionDialog uses shared Dialog chrome and legacy bespoke chrome cannot return', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    const css = readFileSync(STYLES_CSS, 'utf8')
    const decisionDialog = tsx.slice(tsx.indexOf('function DecisionDialog('))
    expect(decisionDialog).toMatch(/<Dialog/)
    expect(decisionDialog).not.toMatch(/panelClassName="review-decision-dialog__panel"/)
    for (const legacyPart of ['overlay', 'panel', 'header', 'close', 'body', 'actions']) {
      expect(css).not.toMatch(new RegExp(`\\.review-decision-dialog__${legacyPart}\\s*\\{`))
    }
  })
})

describe('review detail decision dialog — approve confirms when submitted comments exist', () => {
  // BUG (fixed): on the markdown review page, when the doc carried any
  // submitted review comments and the user clicked "通过" / "Approve",
  // the action fired immediately with no confirm prompt. Users expected
  // a "are you sure?" dialog whenever there are open review signals on
  // the doc, not only when there are unsubmitted drafts. The fix routes
  // both `draftCount > 0` AND `commentCount > 0` through DecisionDialog.
  // Locking the source-text shape here so a future refactor that drops
  // the commentCount branch re-introduces the regression visibly.
  test('onApprove counts submitted comments alongside drafts and triggers the dialog when either > 0', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).toMatch(/const commentCount = detail\.data\.comments\.length/)
    expect(tsx).toMatch(/if \(draftCount > 0 \|\| commentCount > 0\)/)
    expect(tsx).toMatch(/setDecisionDialog\(\{ kind: 'approve', draftCount, commentCount \}\)/)
  })

  test('approve dialog body renders the new approveCommentWarning copy', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).toMatch(/reviews\.approveCommentWarning/)
    // Both warnings sit behind their respective count guards so the
    // dialog never shows "0 条" copy.
    expect(tsx).toMatch(/state\.commentCount > 0 &&/)
    expect(tsx).toMatch(/state\.draftCount > 0 &&/)
  })
})

describe('review detail sidebar — ▲/▼ jump buttons mirror the J/K shortcut', () => {
  test('ReviewDocPane renders the up/down jump buttons in the sidebar header', () => {
    const tsx = readFileSync(PANE_TSX, 'utf8')
    // Both buttons must exist, share the `review-detail__sidebar-jump-btn`
    // class, and use the new sidebarJumpPrev / sidebarJumpNext i18n keys.
    expect(tsx).toMatch(/review-detail__sidebar-jump-btn/)
    expect(tsx).toMatch(/reviews\.sidebarJumpPrev/)
    expect(tsx).toMatch(/reviews\.sidebarJumpNext/)
  })

  test('jumpComment helper exists and is reused by both buttons + J/K handler', () => {
    const tsx = readFileSync(PANE_TSX, 'utf8')
    // Single source of truth — the helper is defined once and consumed by
    // the keyboard branch and both arrow onClicks. Locking this prevents a
    // future refactor from drifting the two paths.
    expect(tsx).toMatch(/const jumpComment\s*=\s*useCallback/)
    expect(tsx).toMatch(/jumpComment\('next'\)/)
    expect(tsx).toMatch(/jumpComment\('prev'\)/)
  })

  test('styles.css ships hover + disabled states for the jump buttons', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.review-detail__sidebar-jump-btn\s*\{/)
    expect(css).toMatch(/\.review-detail__sidebar-jump-btn:disabled/)
  })

  test('IntersectionObserver scroll-spy is suppressed during programmatic jumps', () => {
    // BUG (fixed): clicking ▼ briefly set activeCommentId to the target,
    // then the smooth-scroll fired intersection events for every anchor
    // it swept past, and the observer's "topmost intersecting" branch
    // clobbered our intentional active id — the user clicks ▼ at idx 0
    // but lands on idx 3 etc. Confirmed in chrome MCP: index sequence
    // 1,3,1,3,4,2 instead of 0..5.
    //
    // Fix: a timestamp ref `suppressScrollSpyUntilRef` extended by every
    // programmatic jump, checked at the top of the observer callback. We
    // lock both the ref and the check at source-text level so a refactor
    // that drops the suppression immediately re-introduces the bug.
    const tsx = readFileSync(PANE_TSX, 'utf8')
    expect(tsx).toMatch(/const suppressScrollSpyUntilRef\s*=\s*useRef/)
    expect(tsx).toMatch(/suppressScrollSpyUntilRef\.current\s*=\s*Date\.now\(\)\s*\+/)
    expect(tsx).toMatch(/if\s*\(Date\.now\(\)\s*<\s*suppressScrollSpyUntilRef\.current\)\s*return/)
  })
})

describe('review comment mutations — failures stay visible and recoverable', () => {
  test('ReviewDocPane renders action-local errors for create, update, and delete mutations', () => {
    const tsx = readFileSync(PANE_TSX, 'utf8')
    expect(tsx).toContain("import { ErrorBanner } from '@/components/ErrorBanner'")
    expect(tsx).toMatch(/<ErrorBanner\s+error=\{submitComment\.error\}/)
    expect(tsx).toMatch(/<ErrorBanner\s+error=\{updateComment\.error\}/)
    expect(tsx).toMatch(/<ErrorBanner\s+error=\{deleteComment\.error\}/)
  })

  test('failed async create/update calls are caught so drafts remain editable without unhandled rejections', () => {
    const tsx = readFileSync(PANE_TSX, 'utf8')
    expect(tsx).toMatch(/try\s*\{\s*await updateComment\.mutateAsync/s)
    expect(tsx).toMatch(/try\s*\{\s*await submitComment\.mutateAsync/s)
  })
})
