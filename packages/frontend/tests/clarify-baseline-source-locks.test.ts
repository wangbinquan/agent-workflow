// RFC-058 PR-A baseline (T7): byte-level source-text locks on the frontend
// clarify routes — list page chip / detail page reject modal / multi-source
// banner / abandoned chip / keyboard hints. These are deliberately
// source-grep style tests (cheap, fast, no router/render boilerplate) so
// PR-B refactor that renames a data-testid or removes a banner fires red
// immediately. Detailed behavioral coverage lives in:
//   - clarify-rfc056-list-route.test.tsx
//   - clarify-rfc056-detail-route.test.tsx
//   - cross-clarify-ui-bugs-2026-05-22.test.tsx
//   - cross-clarify-inspector-palette.test.tsx
//
// PR-B will rename `ClarifySession` / `CrossClarifySession` types but MUST
// NOT change the visible DOM contracts the user (or e2e) depends on. This
// baseline is the snapshot.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CLARIFY_LIST = resolve(__dirname, '..', 'src', 'routes', 'clarify.tsx')
const CLARIFY_DETAIL = resolve(__dirname, '..', 'src', 'routes', 'clarify.detail.tsx')
const LIST_SRC = readFileSync(CLARIFY_LIST, 'utf8')
const DETAIL_SRC = readFileSync(CLARIFY_DETAIL, 'utf8')

describe('RFC-058 baseline T7 — list page chip + row data-testid contract', () => {
  test('list page renders per-row kind chip + Open link via data-testid="clarify-row-${id}"', () => {
    expect(LIST_SRC).toContain('data-testid={`clarify-row-${s.id}`}')
    expect(LIST_SRC).toContain('data-testid={`clarify-row-${cross.id}`}')
    expect(LIST_SRC).toContain('data-testid={`clarify-row-kind-${s.id}`}')
    expect(LIST_SRC).toContain('data-testid={`clarify-row-kind-${cross.id}`}')
  })

  test('chip i18n keys: clarify.list.chip.self + clarify.list.chip.cross', () => {
    expect(LIST_SRC).toContain('clarify.list.chip.cross')
    expect(LIST_SRC).toContain('clarify.list.chip.self')
  })

  test('list page top-level testid contract', () => {
    expect(LIST_SRC).toContain('data-testid="clarify-list-page"')
    expect(LIST_SRC).toContain('data-testid="clarify-list-empty"')
  })

  test('cross-clarify row exposes targetDesignerNodeId in clarify-row-designer testid', () => {
    expect(LIST_SRC).toContain('data-testid="clarify-row-designer"')
  })
})

describe('RFC-058 baseline T7 — detail page reject modal + submit hook', () => {
  test('detail page has rejectModalOpen state for the two-step Reject confirmation flow', () => {
    expect(DETAIL_SRC).toContain('rejectModalOpen')
    expect(DETAIL_SRC).toContain('setRejectModalOpen')
  })

  test('detail page renders detail-page data-testid + back / context card + truncation warning testids', () => {
    expect(DETAIL_SRC).toContain('data-testid="clarify-detail-page"')
    expect(DETAIL_SRC).toContain('data-testid="clarify-detail-task-name"')
    expect(DETAIL_SRC).toContain('data-testid="clarify-context-card"')
    expect(DETAIL_SRC).toContain('data-testid="clarify-truncation-warning"')
  })

  test('cross-clarify multi-source banner: role + per-peer link testid pattern', () => {
    // RFC-058 T14/T16: field path renamed `p.crossClarifyNodeId` →
    // `p.intermediaryNodeId` as part of the ClarifyRound unification.
    // User-facing DOM testid prefix `cross-clarify-multi-source-link-` is
    // preserved byte-equivalent; only the source-text aliasing changed
    // (internal behavior layer per RFC-058 Q3).
    expect(DETAIL_SRC).toContain('data-testid="cross-clarify-multi-source-banner"')
    expect(DETAIL_SRC).toContain(
      'data-testid={`cross-clarify-multi-source-link-${p.intermediaryNodeId}`}',
    )
  })

  test('cross-clarify abandoned chip testid + target-designer testid', () => {
    expect(DETAIL_SRC).toContain('data-testid="cross-clarify-abandoned-chip"')
    expect(DETAIL_SRC).toContain('data-testid="cross-clarify-target-designer"')
  })

  test('keyboard hint testid + shard switcher testid', () => {
    expect(DETAIL_SRC).toContain('data-testid="clarify-keyboard-hint"')
    expect(DETAIL_SRC).toContain('data-testid="clarify-shard-switcher"')
  })
})

describe('RFC-058 baseline T7 — shared type imports (PR-B will rename these)', () => {
  test('clarify.tsx imports ClarifyInboxEntry / kind discriminator (PR-B → ClarifyRoundSummary)', () => {
    // RFC-058 PR-A baseline locks: the current type name is ClarifyInboxEntry
    // (RFC-056 union). PR-B will rename to ClarifyRoundSummary with single
    // wire shape + kind discriminator. This test goes red on PR-B; remove
    // when the rename lands.
    expect(LIST_SRC).toMatch(/ClarifyInboxEntry|ClarifyRoundSummary/)
  })

  test('clarify.detail.tsx imports SubmitClarifyAnswersResponse (PR-B preserves)', () => {
    expect(DETAIL_SRC).toContain('SubmitClarifyAnswersResponse')
  })
})
