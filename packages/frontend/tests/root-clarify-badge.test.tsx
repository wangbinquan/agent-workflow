// RFC-023 PR-C T25 (original intent) + RFC-032 PR2 (re-targeted) —
// the clarify pending-count badge must still exist; it just lives inside
// the shared inbox footer button now (folded together with reviews).
//
// Why this regression test exists: clarify (RFC-023) and reviews (RFC-005)
// both produce "human waiting" signals; PR2 of RFC-032 merged them into a
// single `<InboxFooterButton>` + `<InboxDrawer>`. Both endpoints still need
// to be polled, the combined badge still needs to cap at 99+, and detail
// pages must still resolve to the workflows group. Any future RFC that
// drops the merge / cap / detail-page mapping breaks downstream tasks
// silently — these assertions catch it.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('left-nav inbox badge wiring (RFC-023 T25 / RFC-032 PR2)', () => {
  it('InboxFooterButton imports ClarifyPendingCount + ReviewPendingCount and polls both endpoints', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'components', 'shell', 'InboxFooterButton.tsx'),
      'utf8',
    )
    expect(src).toContain('ClarifyPendingCount')
    expect(src).toContain('ReviewPendingCount')
    expect(src).toContain('/api/clarify/pending-count')
    expect(src).toContain('/api/reviews/pending-count')
    expect(src).toContain("queryKey: ['clarify', 'pending-count']")
    expect(src).toContain("queryKey: ['reviews', 'pending-count']")
  })

  it('InboxFooterButton renders a "99+" capped badge with a stable data-testid', () => {
    const src = readFileSync(
      join(__dirname, '..', 'src', 'components', 'shell', 'InboxFooterButton.tsx'),
      'utf8',
    )
    expect(src).toContain('data-testid="inbox-footer-badge"')
    expect(src).toMatch(/total > 99 \? '99\+' : String\(total\)/)
  })

  it('Reviews + Clarify detail pages still highlight the workflows group via resolveActiveNav fallback', () => {
    // PR2 removed /reviews + /clarify from `NAV_GROUPS`. The fallback in
    // `resolveActiveNav` must still map both detail-page prefixes to
    // `activeGroup:'workflows'` so the sidebar group keeps its highlight.
    const nav = readFileSync(join(__dirname, '..', 'src', 'lib', 'nav.ts'), 'utf8')
    expect(nav).toMatch(
      /pathname\.startsWith\('\/reviews'\) \|\| pathname\.startsWith\('\/clarify'\)/,
    )
    expect(nav).toMatch(/activeGroup: 'workflows'/)
  })
})
