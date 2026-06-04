// RFC-013 source-level lock for the read-only historical view on
// /reviews/$nodeRunId?version=<vid>. JSDOM can't reasonably mount this
// route (it pulls in TanStack Router, react-query, useTaskSync, the
// Prose pipeline, IntersectionObserver, etc.) and the readonly contract
// is a list of NEGATIVE assertions — "this affordance is not in the DOM
// when readonly is true". The cheapest way to keep that contract from
// rotting under a future refactor is to scan the source for the
// patterns that implement it.
//
// If a future change drops one of the `!readonly &&` guards (or renames
// `readonly`), the corresponding assertion below fails.

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

describe('RFC-013 reviews.detail.tsx — readonly historical view', () => {
  test('route declares validateSearch for ?version=<vid>', () => {
    const s = src()
    expect(s).toMatch(/validateSearch\s*:/)
    expect(s).toMatch(/raw\.version/)
  })

  test('component reads search via useSearch and resolves view via resolveReviewView', () => {
    const s = src()
    expect(s).toMatch(/useSearch\(\s*\{\s*from:\s*Route\.id\s*\}\s*\)/)
    expect(s).toMatch(/resolveReviewView\(/)
    // The readonly flag derives from view.mode === 'historical'.
    expect(s).toMatch(/const readonly\s*=\s*view\.mode\s*===\s*'historical'/)
  })

  test('keyboard handler short-circuits when readonly', () => {
    const s = src()
    // Effect body opens with the readonly short-circuit before touching
    // popover / editingId / activeElement / diffMode.
    expect(s).toMatch(/onKey\s*=\s*\(e:[^)]*\)\s*=>\s*\{[\s\S]*?if\s*\(\s*readonly\s*\)\s*return/)
    // RFC-082: right after the readonly bail, the route keyboard also bails
    // when the pane is capturing keystrokes (popover open / inline-editing),
    // so A/R/I never fire mid-comment.
    expect(s).toMatch(
      /if\s*\(\s*readonly\s*\)\s*return[\s\S]{0,80}if\s*\(\s*paneCapturing\s*\)\s*return/,
    )
    // RFC-082: `editingId` moved into <ReviewDocPane> with the comment
    // machinery; the route's A/R/I keyboard now gates on `paneCapturing`
    // (reported by the pane) instead — still alongside `readonly` in the deps.
    expect(s).toMatch(/paneCapturing[\s\S]{0,200}readonly\s*\]/m)
  })

  test('decision buttons + dialog are gated behind !readonly (route); popover gated in pane', () => {
    const s = src()
    // The three decision buttons live in a header-actions cluster wrapped
    // by `{!readonly && (<div className="review-detail__decision-actions" ...>)}`.
    // (May 2026: the bottom <footer> was retired when the buttons moved to
    // the top-right of the page.)
    expect(s).toMatch(
      /\{\s*!readonly\s*&&\s*\(\s*<div\s+className="review-detail__decision-actions"/,
    )
    // The styled in-app decision dialog is also gated.
    expect(s).toMatch(/\{\s*!readonly\s*&&\s*decisionDialog\s*!==\s*null\s*&&/)
    // RFC-082: the selection→comment popover moved to <ReviewDocPane>; its
    // !readonly gate lives there now.
    expect(pane()).toMatch(/\{\s*!readonly\s*&&\s*popover\s*!==\s*null\s*&&/)
  })

  test('comment-bubble write actions (edit/copy/delete) are gated behind !readonly (pane)', () => {
    // RFC-082: the bubble write actions moved to <ReviewDocPane>.
    expect(pane()).toMatch(/\{\s*!readonly\s*&&\s*!isEditing\s*&&\s*\(/)
  })

  test('diff toolbar is gated behind !readonly', () => {
    const s = src()
    // The whole diff-mode toolbar lives under {!readonly && data.currentVersion.versionIndex > 1 && (...)}.
    expect(s).toMatch(/\{\s*!readonly\s*&&\s*data\.currentVersion\.versionIndex\s*>\s*1\s*&&\s*\(/)
  })

  test('onMouseUpInDoc bails out early when readonly (pane)', () => {
    // RFC-082: onMouseUpInDoc moved into <ReviewDocPane>.
    expect(pane()).toMatch(
      /onMouseUpInDoc\s*=\s*useCallback\(\s*async\s*\(\)\s*=>\s*\{\s*if\s*\(\s*readonly\s*\)\s*return/,
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
    // We use window.alert + navigate with replace: true on the invalid path.
    expect(s).toMatch(/window\.alert\(\s*t\(\s*'reviews\.unknownVersion'/)
    expect(s).toMatch(/navigate\(\s*\{\s*to:\s*'\/reviews\/\$nodeRunId'[\s\S]*?replace:\s*true/)
  })

  test('readonly banner renders + has a back-to-current Link', () => {
    const s = src()
    expect(s).toMatch(/readonly-banner/)
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
    // readonly (we want the download available on the historical view
    // too — that's the whole point of downloading a historical version).
    // We check the few characters immediately before the actions div
    // opener: it should be a closing tag `</div>` of the page-header-text
    // block, not `{!readonly && (`.
    const actionsIdx = s.indexOf('review-detail__page-header-actions')
    expect(actionsIdx).toBeGreaterThan(-1)
    const justBefore = s.slice(Math.max(0, actionsIdx - 50), actionsIdx)
    expect(justBefore).not.toMatch(/!readonly\s*&&\s*\(/)
    // Filename uses the version index — not just the node id — so users
    // can keep multiple versions of the same review on disk.
    expect(s).toMatch(/headerVersionIndex/)
    // The blob has the right MIME type so OSes recognize the .md extension.
    expect(s).toMatch(/text\/markdown/)
  })
})
