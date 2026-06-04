// Locks in the "跨章节选择无法添加评审意见" light hint added to
// /reviews/$nodeRunId.
//
// Background: computeAnchorFromSelection silently rejects selections that
// cross an <h*> boundary. Before this hint, the popover would just never
// open and users were left wondering whether the click had registered.
// We now (1) detect the cross-heading case via selectionCrossesHeading
// and (2) show a small auto-dismissing tooltip near the selection.
//
// JSDOM-mounting the whole route is impractical (TanStack Router +
// react-query + useTaskSync + Prose pipeline). The cheapest way to keep
// the wiring from rotting is to scan the source for the four pieces
// that have to coexist: the helper import, the helper call in the
// mouse-up handler, the dedicated state, and the rendered hint.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// RFC-082: the selection → comment popover (incl. the cross-heading hint)
// moved into the shared <ReviewDocPane>, so the wiring is asserted there now.
const PANE_TSX = resolve(__dirname, '..', 'src', 'components', 'review', 'ReviewDocPane.tsx')
const EN_TS = resolve(__dirname, '..', 'src', 'i18n', 'en-US.ts')
const ZH_TS = resolve(__dirname, '..', 'src', 'i18n', 'zh-CN.ts')

function src(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('ReviewDocPane — cross-heading selection hint', () => {
  test('imports selectionCrossesHeading from anchor lib', () => {
    expect(src(PANE_TSX)).toMatch(/selectionCrossesHeading[\s\S]*?from\s*'@\/lib\/review\/anchor'/)
  })

  test('mouse-up handler invokes selectionCrossesHeading when anchor is null', () => {
    const s = src(PANE_TSX)
    // The handler must call the helper inside the `anchor === null` branch
    // — otherwise we either nag on every empty selection (bad) or never
    // nag at all (the original bug).
    expect(s).toMatch(/if\s*\(\s*anchor\s*===\s*null\s*\)\s*\{[\s\S]*?selectionCrossesHeading\(/)
  })

  test('crossHeadingHint state + auto-clear timer are wired', () => {
    const s = src(PANE_TSX)
    expect(s).toMatch(/setCrossHeadingHint/)
    // The auto-dismiss effect must clear the hint so it doesn't stick.
    expect(s).toMatch(/setCrossHeadingHint\(null\)/)
  })

  test('hint element renders with the i18n key and is gated behind !readonly', () => {
    const s = src(PANE_TSX)
    expect(s).toMatch(
      /\{\s*!readonly\s*&&\s*crossHeadingHint\s*!==\s*null\s*&&[\s\S]*?reviews\.crossHeadingHint/,
    )
    expect(s).toMatch(/review-cross-heading-hint/)
  })

  test('i18n bundles define reviews.crossHeadingHint in both locales', () => {
    expect(src(EN_TS)).toMatch(/crossHeadingHint:\s*'[^']+'/)
    expect(src(ZH_TS)).toMatch(/crossHeadingHint:\s*'[^']+'/)
  })
})
