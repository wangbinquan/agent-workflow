// Locks the alignment between /clarify and /reviews list pages.
//
// User asked to "拉齐评审、反问两个页签的样式" — both inbox pages should share
// the same overall structure: `.page__hint` paragraph under the title,
// `<div className="tabs" role="tablist">` with role="tab" + aria-selected
// buttons, a `.reviews-group` per task, a `.data-table` body with a
// status-chip column and a per-row "Open" button. Source-text assertions
// only — the routes are awkward to mount under JSDOM (TanStack Router
// context) and the visual contract is in JSX shape + CSS, both of which
// flip back loudly if regressed.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CLARIFY_TSX = resolve(__dirname, '..', 'src', 'routes', 'clarify.tsx')
const REVIEWS_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.tsx')

describe('clarify ↔ reviews list — aligned page shell', () => {
  const clarify = readFileSync(CLARIFY_TSX, 'utf8')
  const reviews = readFileSync(REVIEWS_TSX, 'utf8')

  test('both pages render a .page__hint paragraph under the h1', () => {
    expect(clarify).toMatch(/<p className="page__hint">\{t\('clarify\.list\.hint'\)\}<\/p>/)
    expect(reviews).toMatch(/<p className="page__hint">\{t\('reviews\.hint'\)\}<\/p>/)
  })

  test('both pages use an accessible tablist with aria-selected', () => {
    for (const src of [clarify, reviews]) {
      expect(src).toMatch(/<div className="tabs" role="tablist">/)
      expect(src).toMatch(/role="tab"/)
      expect(src).toMatch(/aria-selected=\{filter === k\}/)
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
    // CLARIFY_ROUND_STATUS_CHIP table in lib/clarify-status.ts.
    expect(clarify).toMatch(/status-chip status-chip--\$\{clarifyRoundStatusChip\(/)
    expect(clarify).not.toMatch(/\? 'amber' : 'green'/)
  })

  test('clarify rows carry a per-row Open button using the same .btn .btn--sm style as reviews', () => {
    expect(clarify).toMatch(/className="btn btn--sm"[\s\S]*clarify\.list\.openButton/)
    expect(reviews).toMatch(/className="btn btn--sm"[\s\S]*reviews\.openButton/)
  })
})
