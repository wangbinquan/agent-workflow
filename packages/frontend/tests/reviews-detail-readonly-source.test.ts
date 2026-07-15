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
// Guards now read `mode !== 'historical'` (render gate) and
// `mode !== 'awaiting'` (disable gate — the 'decided' state renders write
// affordances greyed out instead of hiding them). If a future change drops
// one of the `mode !== 'historical' &&` guards (or reverts to scattered
// booleans), the corresponding assertion below fails.

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

  test('keyboard handler short-circuits when historical', () => {
    const s = src()
    // Effect body opens with the mode short-circuit before touching
    // popover / editingId / activeElement / diffMode.
    expect(s).toMatch(
      /onKey\s*=\s*\(e:[^)]*\)\s*=>\s*\{[\s\S]*?if\s*\(\s*mode\s*===\s*'historical'\s*\)\s*return/,
    )
    // RFC-082: right after the historical bail, the route keyboard also bails
    // when the pane is capturing keystrokes (popover open / inline-editing),
    // so A/R/I never fire mid-comment.
    expect(s).toMatch(
      /if\s*\(\s*mode\s*===\s*'historical'\s*\)\s*return[\s\S]{0,80}if\s*\(\s*paneCapturing\s*\)\s*return/,
    )
    // `mode` sits in the effect deps alongside paneCapturing.
    expect(s).toMatch(/paneCapturing[\s\S]{0,200}mode\s*\]/m)
  })

  test('decision buttons + dialog are gated behind mode (route); popover gated in pane', () => {
    const s = src()
    // The three decision buttons live in a header-actions cluster wrapped by
    // `{mode !== 'historical' && (<div className="review-detail__decision-actions" ...>)}`
    // — rendered on BOTH current states ('awaiting' AND 'decided')…
    expect(s).toMatch(
      /\{\s*mode !== 'historical'\s*&&\s*\(\s*<div\s+className="review-detail__decision-actions"/,
    )
    // …and disabled unless the round is actually awaiting a decision.
    const disabledDecisions = s.match(
      /disabled=\{mode !== 'awaiting' \|\| submitDecision\.isPending\}/g,
    )
    expect(disabledDecisions?.length).toBe(3)
    // The styled in-app decision dialog is also gated.
    expect(s).toMatch(/\{\s*mode !== 'historical'\s*&&\s*decisionDialog\s*!==\s*null\s*&&/)
    // RFC-082: the selection→comment popover moved to <ReviewDocPane>; its
    // historical gate lives there now.
    // RFC-149 impl-gate: NEW comment creation is awaiting-only (a decided
    // round would only get a server-side rejection).
    expect(pane()).toMatch(/\{\s*mode === 'awaiting'\s*&&\s*popover\s*!==\s*null\s*&&/)
  })

  test('comment-bubble write actions render unless historical; edit/delete disabled unless awaiting (pane)', () => {
    const p = pane()
    // RFC-082: the bubble write actions moved to <ReviewDocPane>.
    expect(p).toMatch(/\{\s*mode !== 'historical'\s*&&\s*!isEditing\s*&&\s*\(/)
    // RFC-149 'decided' contract: edit (✎) + delete (×) stay visible but
    // disabled on a current-but-decided round.
    const disabledWrites = p.match(/disabled=\{mode !== 'awaiting'\}/g)
    expect(disabledWrites?.length).toBe(2)
    // The pane takes the single three-state prop, not the retired boolean pair.
    expect(p).toMatch(/mode:\s*ReviewPaneMode/)
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

  test('onMouseUpInDoc bails out unless awaiting (pane)', () => {
    // RFC-082: onMouseUpInDoc moved into <ReviewDocPane>. RFC-149 impl-gate:
    // the bail widened from historical-only to non-awaiting (decided rounds
    // must not open the add-comment popover either).
    expect(pane()).toMatch(/if\s*\(\s*mode\s*!==\s*'awaiting'\s*\)\s*return/)
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
