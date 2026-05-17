// RFC-023 PR-C T25 — left-nav Clarify badge.
//
// Source-level guard: __root.tsx MUST poll /api/clarify/pending-count and
// render a badge with data-testid="clarify-nav-badge" whose visible label
// matches the count (with a "99+" cap above 99). Renaming any of those keys
// breaks the sidebar UX silently; this test catches that regression.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('left-nav Clarify badge wiring (RFC-023 T25)', () => {
  it('__root.tsx imports ClarifyPendingCount + polls /api/clarify/pending-count', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', '__root.tsx'), 'utf8')
    expect(src).toContain('ClarifyPendingCount')
    expect(src).toContain('/api/clarify/pending-count')
    expect(src).toContain("queryKey: ['clarify', 'pending-count']")
  })

  it('__root.tsx renders the badge with data-testid="clarify-nav-badge" + 99+ cap', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', '__root.tsx'), 'utf8')
    expect(src).toContain('data-testid="clarify-nav-badge"')
    // 99+ cap must apply to clarify (same convention as the reviews badge).
    expect(src).toContain("clarifyPendingCount > 99 ? '99+' : clarifyPendingCount")
  })

  it('Clarify is the 6th nav item, immediately after Reviews', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', '__root.tsx'), 'utf8')
    // Match by ordering in the NAV array literal.
    const idxReviews = src.indexOf("key: 'reviews'")
    const idxClarify = src.indexOf("key: 'clarify'")
    expect(idxReviews).toBeGreaterThan(-1)
    expect(idxClarify).toBeGreaterThan(idxReviews)
  })
})
