// Locks the alignment between /clarify and /reviews list pages.
//
// User asked to "拉齐评审、反问两个页签的样式" — both inbox pages should share
// the same overall structure: a shared segmented filter, a `.reviews-group` per task, a
// `.data-table` body with a status-chip column and a per-row "Open" button.
// (RFC-155 removed the static `.page__hint` header paragraph from BOTH pages
// — the alignment now includes its absence.) Source-text assertions only —
// the routes are awkward to mount under JSDOM (TanStack Router context) and
// the visual contract is in JSX shape + CSS, both of which flip back loudly
// if regressed.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CLARIFY_TSX = resolve(__dirname, '..', 'src', 'routes', 'clarify.tsx')
const REVIEWS_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.tsx')

describe('clarify ↔ reviews list — aligned page shell', () => {
  const clarify = readFileSync(CLARIFY_TSX, 'utf8')
  const reviews = readFileSync(REVIEWS_TSX, 'utf8')

  test('neither page renders a static .page__hint paragraph under the h1 (RFC-155)', () => {
    expect(clarify).not.toMatch(/page__hint/)
    expect(reviews).not.toMatch(/page__hint/)
  })

  test('both pages use PageHeader and Segmented without tab semantics', () => {
    // RFC-198: list status is a filter, not a panel switch. Both pages use
    // radio semantics through Segmented and reserve TabBar for true tabs.
    for (const src of [clarify, reviews]) {
      expect(src).toMatch(/<PageHeader\b/)
      expect(src).toContain('<div className="page-filter">')
      expect(src).toMatch(/<Segmented\b/)
      expect(src).toMatch(/options=\{FILTERS\.map\(/)
      expect(src).toMatch(/value=\{filter\}/)
      expect(src).toMatch(/onChange=\{setFilter\}/)
      expect(src).not.toMatch(/<TabBar\b/)
      expect(src).not.toMatch(/role="tablist"/)
    }
  })

  test('both pages share query feedback and preserve their table DOM inside TableViewport', () => {
    for (const src of [clarify, reviews]) {
      expect(src).toMatch(/<ErrorBanner\b[\s\S]*?list\.refetch\(\)/)
      expect(src).toMatch(/<LoadingState\b/)
      expect(src).toMatch(/<EmptyState\b/)
      expect(src).toMatch(/<TableViewport\b[\s\S]*?<table className="data-table">/)
    }
  })

  test('clarify list renders rows in a .data-table (no more <ul> list shape)', () => {
    expect(clarify).toMatch(/<table className="data-table">/)
    // The pre-alignment shape was an unordered list of cards keyed off
    // `.reviews-group__items` / `.reviews-group__item`. Lock that out so
    // we don't silently regress back to two visually-divergent layouts.
    expect(clarify).not.toMatch(/reviews-group__items/)
    expect(clarify).not.toMatch(/reviews-group__item"/)
  })

  test('clarify rows carry a status-chip column driven by the shared status table', () => {
    // flag-audit W0: the inline `awaiting_human ? 'amber' : 'green'` ternary
    // (which rendered a CANCELED round as green "Answered") was replaced by the
    // CLARIFY_ROUND_STATUS_CHIP table in lib/clarify-status.ts. RFC-150 PR-1:
    // the bare span was folded into the <StatusChip> primitive on top of it.
    expect(clarify).toMatch(/<StatusChip kind=\{clarifyRoundStatusChip\(/)
    expect(clarify).not.toMatch(/\? 'amber' : 'green'/)
  })

  test('clarify rows carry a per-row Open button using the same .btn .btn--sm style as reviews', () => {
    expect(clarify).toMatch(/className="btn btn--sm"[\s\S]*clarify\.list\.openButton/)
    expect(reviews).toMatch(/className="btn btn--sm"[\s\S]*reviews\.openButton/)
  })
})
