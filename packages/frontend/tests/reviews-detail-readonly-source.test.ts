// RFC-013 source-level lock for the read-only historical view on
// /reviews/$nodeRunId?version=<vid>. JSDOM can't reasonably mount this
// route (it pulls in TanStack Router, react-query, useTaskSync, the
// Prose pipeline, IntersectionObserver, etc.) and the readonly contract
// is a list of NEGATIVE assertions — "this affordance is not in the DOM
// when the view is historical". The cheapest way to keep that contract
// from rotting under a future refactor is to scan the source for the
// patterns that implement it.
//
// RFC-149 rewrite: the old `readonly` + `isAwaiting` boolean pair became the
// three-state `mode: ReviewPaneMode` ('awaiting' | 'decided' | 'historical').
// RFC-340 then made actor-specific write affordances capability-driven:
// current reviewers can comment and edit their own pending comments without
// gaining decision or deletion controls. The assertions below therefore lock
// both axes: the viewed round's mode and the server-projected capabilities.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROUTE_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')
// RFC-082: the markdown body + comment bubbles + popover + onMouseUpInDoc moved
// into the shared <ReviewDocPane>. Readonly guards on those affordances now live
// there, so assertions about them read the pane source instead of the route.
const PANE_TSX = resolve(__dirname, '..', 'src', 'components', 'review', 'ReviewDocPane.tsx')

function src(): string {
  return readFileSync(ROUTE_TSX, 'utf8')
}
function pane(): string {
  return readFileSync(PANE_TSX, 'utf8')
}

describe('RFC-013/RFC-149 reviews.detail.tsx — readonly historical view', () => {
  test('route declares validateSearch for ?version=<vid>', () => {
    const s = src()
    expect(s).toMatch(/validateSearch\s*:/)
    expect(s).toMatch(/raw\.version/)
  })

  test('component reads search via useSearch and resolves the three-state mode', () => {
    const s = src()
    expect(s).toMatch(/useSearch\(\s*\{\s*from:\s*Route\.id\s*\}\s*\)/)
    expect(s).toMatch(/resolveReviewView\(/)
    // RFC-149: the mode derives from view.mode === 'historical', then splits
    // the current view into 'awaiting' / 'decided' off awaitingReview.
    expect(s).toMatch(
      /const mode:\s*ReviewPaneMode\s*=\s*view\.mode\s*===\s*'historical'\s*\?\s*'historical'\s*:\s*detail\.data\?\.summary\.awaitingReview\s*===\s*true\s*\?\s*'awaiting'\s*:\s*'decided'/,
    )
    // The retired boolean pair must not come back.
    expect(s).not.toMatch(/const readonly\s*=/)
    expect(s).not.toMatch(/const isAwaiting\s*=/)
  })

  test('viewed-version fields converge through pickViewedVersion (no per-field ternary fork)', () => {
    const s = src()
    // RFC-149: one picker call selects decision / decisionReason / decidedAt /
    // decidedBy / decidedByRole / versionIndex together.
    expect(s).toMatch(
      /pickViewedVersion\(view,\s*historicalDetail\.data,\s*detail\.data\?\.currentVersion\)/,
    )
    // The seven per-field `view.mode === 'historical' ? historicalDetail…` ternaries
    // must not re-grow next to the picker.
    expect(s).not.toMatch(/view\.mode\s*===\s*'historical'\s*\?\s*historicalDetail\.data/)
    // The decision info block reads the picked object.
    expect(s).toMatch(/decision=\{viewed\.decision\}/)
    expect(s).toMatch(/decidedBy=\{viewed\.decidedBy\}/)
  })

  test('decision keyboard short-circuits when historical or canDecide is absent', () => {
    const s = src()
    // The route owns A/R/I. Historical views and actors without the projected
    // decision capability both bail before pane capture or shortcut handling.
    expect(s).toMatch(
      /onKey\s*=\s*\(e:[^)]*\)\s*=>\s*\{\s*if\s*\(mode\s*===\s*'historical'\)\s*return\s*if\s*\(detail\.data\?\.capabilities\.canDecide\s*!==\s*true\)\s*return/,
    )
    // RFC-082: right after the historical bail, the route keyboard also bails
    // when the pane is capturing keystrokes (popover open / inline-editing).
    expect(s).toMatch(
      /capabilities\.canDecide\s*!==\s*true\)\s*return\s*if\s*\(paneCapturing\)\s*return/,
    )
    // Mode and capability payload are both dependencies of the handler.
    expect(s).toMatch(
      /\[paneCapturing,\s*onApprove,\s*onReject,\s*onIterate,\s*diffMode,\s*mode,\s*detail\.data\]/,
    )
  })

  test('decision controls and comment popover combine mode with projected capabilities', () => {
    const s = src()
    // The three decision buttons live in a header-actions cluster wrapped by
    // both the current-view gate and `canDecide`, so assigned reviewers never
    // receive approve / iterate / reject controls.
    expect(s).toMatch(
      /\{\s*mode !== 'historical'\s*&&\s*data\.capabilities\.canDecide\s*&&\s*\(\s*<div\s+className="review-detail__decision-actions"/,
    )
    // Owners/admins keep the decided-state controls visible but disabled.
    const disabledDecisions = s.match(
      /disabled=\{mode !== 'awaiting' \|\| submitDecision\.isPending\}/g,
    )
    expect(disabledDecisions?.length).toBe(3)
    // The styled in-app decision dialog carries the same two gates.
    expect(s).toMatch(
      /\{\s*mode !== 'historical'\s*&&\s*data\.capabilities\.canDecide\s*&&\s*decisionDialog\s*!==\s*null\s*&&/,
    )
    // Comment creation is independently projected. It remains awaiting-only,
    // but assigned reviewers with canAddComment receive the popover.
    const p = pane()
    expect(p).toMatch(
      /const canAddComment\s*=\s*mode\s*===\s*'awaiting'\s*&&\s*capabilities\.canAddComment/,
    )
    expect(p).toMatch(/\{canAddComment\s*&&\s*popover\s*!==\s*null\s*&&\s*\(/)
  })

  test('comment-bubble writes follow projected own/manage capabilities (pane)', () => {
    const p = pane()
    // Edit and delete are separate decisions: a reviewer can edit only their
    // own pending comment, while delete stays absent unless its own capability
    // is projected. Copy remains available inside the shared actions cluster.
    expect(p).toContain('(capabilities.canEditOwnComments && actorUserId === comment.author)')
    expect(p).toContain('(capabilities.canDeleteOwnComments && actorUserId === comment.author)')
    expect(p).toMatch(/\{canEditComment\(c\)\s*&&\s*\(\s*<button/)
    expect(p).toMatch(/\{canDeleteComment\(c\)\s*&&\s*\(\s*<button/)
    expect(p).toMatch(/disabled=\{deleteComment\.isPending\}/)
    // The pane takes the single three-state prop, not the retired boolean pair.
    expect(p).toMatch(/mode:\s*ReviewPaneMode/)
    expect(p).toMatch(/capabilities:\s*ReviewCapabilities/)
    expect(p).not.toMatch(/readonly:\s*boolean/)
    expect(p).not.toMatch(/awaiting:\s*boolean/)
  })

  test('diff toolbar is gated behind mode !== historical', () => {
    const s = src()
    // The whole diff-mode toolbar lives under {mode !== 'historical' && data.currentVersion.versionIndex > 1 && (...)}.
    expect(s).toMatch(
      /\{\s*mode !== 'historical'\s*&&\s*data\.currentVersion\.versionIndex\s*>\s*1\s*&&\s*\(/,
    )
  })

  test('onMouseUpInDoc requires awaiting mode plus canAddComment (pane)', () => {
    const p = pane()
    expect(p).toMatch(
      /const canAddComment\s*=\s*mode\s*===\s*'awaiting'\s*&&\s*capabilities\.canAddComment/,
    )
    expect(p).toMatch(/if\s*\(!canAddComment\)\s*return/)
    expect(p).toMatch(
      /onMouseUp=\{canAddComment\s*\?\s*\(\)\s*=>\s*void onMouseUpInDoc\(\)\s*:\s*undefined\}/,
    )
  })

  test('historical body / comments come from a separate query keyed by vid', () => {
    const s = src()
    // `historicalDetail` query enables only when there's a historical vid.
    expect(s).toMatch(/const historicalDetail\s*=\s*useQuery/)
    expect(s).toMatch(/enabled:\s*historicalVid\s*!==\s*null/)
    // Body and comments switch through memoized active* values.
    expect(s).toMatch(/const activeBody\s*=\s*useMemo/)
    expect(s).toMatch(/const activeComments\s*=\s*useMemo/)
  })

  test('invalid mode navigates back to current with a one-shot warning', () => {
    const s = src()
    expect(s).toMatch(/setInvalidVersionWarning\(\{[\s\S]*?message:\s*t\('reviews\.unknownVersion'/)
    expect(s).toMatch(/<NoticeBanner/)
    expect(s).not.toMatch(/window\.alert/)
    expect(s).toMatch(/navigate\(\s*\{\s*to:\s*'\/reviews\/\$nodeRunId'[\s\S]*?replace:\s*true/)
  })

  test('readonly banner renders + has a back-to-current Link', () => {
    const s = src()
    expect(s).toMatch(/\{\s*mode === 'historical'\s*&&\s*\(\s*<div className="readonly-banner"/)
    expect(s).toMatch(/reviews\.historicalBanner/)
    expect(s).toMatch(/reviews\.backToCurrent/)
    // Search is empty object on the back link so the no-query path is hit.
    expect(s).toMatch(/search=\{\{\}\}/)
  })

  test('markdown download button is wired to the active body (current AND historical)', () => {
    const s = src()
    // Button class + i18n key for the visible label.
    expect(s).toMatch(/review-detail__download/)
    expect(s).toMatch(/reviews\.downloadMarkdown/)
    // The handler reads `activeBody` — the same memo that flips between
    // currentBody (current mode) and historical body (historical mode),
    // so the button works in BOTH modes without an extra readonly branch.
    expect(s).toMatch(/handleDownloadMarkdown[\s\S]*?activeBody/)
    // The button lives inside an actions div that itself is NOT gated on
    // the mode (we want the download available on the historical view
    // too — that's the whole point of downloading a historical version).
    // We check the few characters immediately before the actions div
    // opener: it should be a closing tag `</div>` of the page-header-text
    // block, not `{mode !== 'historical' && (`.
    const actionsIdx = s.indexOf('review-detail__page-header-actions')
    expect(actionsIdx).toBeGreaterThan(-1)
    const justBefore = s.slice(Math.max(0, actionsIdx - 60), actionsIdx)
    expect(justBefore).not.toMatch(/mode !== 'historical'\s*&&\s*\(/)
    // Filename uses the viewed version index — not just the node id — so
    // users can keep multiple versions of the same review on disk.
    expect(s).toMatch(/viewed\.versionIndex/)
    // The blob has the right MIME type so OSes recognize the .md extension.
    expect(s).toMatch(/text\/markdown/)
  })
})
