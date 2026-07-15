// RFC-190 — /memory `?tab=` deep-link (design gate P2-6).
//
// Why this test exists: the homepage memory tile counts the APPROVED pool and
// deep-links to `/memory?tab=all` (whose default view is that pool). The
// route's validateSearch is the contract: legal tabs pass through, junk falls
// back to the classic approval-queue default (empty search), and the
// PRE-EXISTING RFC-041 `focus` param (written by distill-job CandidatesList)
// keeps flowing — swallowing it would break those deep-links.

import { describe, expect, test } from 'vitest'
import { Route } from '../src/routes/memory'

type ValidateSearch = (search: Record<string, unknown>) => { tab?: string; focus?: string }

function validate(search: Record<string, unknown>): { tab?: string; focus?: string } {
  const fn = (Route.options as { validateSearch?: ValidateSearch }).validateSearch
  expect(fn, '/memory must declare validateSearch').toBeTruthy()
  return fn!(search)
}

describe('RFC-190 /memory tab deep-link', () => {
  test('legal tab values pass through', () => {
    expect(validate({ tab: 'all' })).toEqual({ tab: 'all' })
    expect(validate({ tab: 'approval-queue' })).toEqual({ tab: 'approval-queue' })
    expect(validate({ tab: 'fusion' })).toEqual({ tab: 'fusion' })
  })

  test('junk / absent tab falls back to empty search (approval-queue default)', () => {
    expect(validate({})).toEqual({})
    expect(validate({ tab: 'bogus' })).toEqual({})
    expect(validate({ tab: 42 })).toEqual({})
  })

  test('pre-existing focus param is preserved (RFC-041 CandidatesList links)', () => {
    expect(validate({ focus: 'mem_123' })).toEqual({ focus: 'mem_123' })
    expect(validate({ tab: 'all', focus: 'mem_123' })).toEqual({ tab: 'all', focus: 'mem_123' })
    expect(validate({ focus: 7 })).toEqual({})
  })
})

// Impl-gate Codex P2 regression (source-level lock): the tab-sync effect must
// reset to the approval-queue default when the search param is CLEARED (e.g.
// `?tab=all` → sidebar `/memory` keeps the component mounted with an empty
// search). An `if (search.tab !== undefined)`-guarded effect leaves the page
// stuck on the previous deep-link tab while the URL claims the default.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('RFC-190 /memory tab sync effect', () => {
  test('effect resets to the default when search.tab is absent', () => {
    const src = readFileSync(resolve(__dirname, '../src/routes/memory.tsx'), 'utf-8')
    expect(src).toContain("setTab(search.tab ?? 'approval-queue')")
    expect(src).not.toMatch(/if \(search\.tab !== undefined\) setTab/)
  })
})
