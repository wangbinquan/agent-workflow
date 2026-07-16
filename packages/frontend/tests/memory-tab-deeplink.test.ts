// RFC-190 — /memory `?tab=` deep-link (design gate P2-6).
//
// Why this test exists: the homepage memory tile counts the APPROVED pool and
// deep-links to `/memory?tab=all` (whose default view is that pool). The
// route's validateSearch is the contract: legal tabs pass through, junk falls
// back to the stable All default (empty search), and the
// PRE-EXISTING RFC-041 `focus` param (written by distill-job CandidatesList)
// keeps flowing — swallowing it would break those deep-links.

import { describe, expect, test } from 'vitest'
import { Route, withMemoryTab } from '../src/routes/memory'

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

  test('junk / absent tab falls back to empty search (All default) without dropping adjacent state', () => {
    expect(validate({})).toEqual({})
    expect(validate({ tab: 'bogus' })).toEqual({})
    expect(validate({ tab: 42 })).toEqual({})
    expect(validate({ tab: 'bogus', focus: 'mem_1', source: 'distill' })).toEqual({
      focus: 'mem_1',
      source: 'distill',
    })
  })

  test('pre-existing focus param is preserved (RFC-041 CandidatesList links)', () => {
    expect(validate({ focus: 'mem_123' })).toEqual({ focus: 'mem_123' })
    expect(validate({ tab: 'all', focus: 'mem_123' })).toEqual({ tab: 'all', focus: 'mem_123' })
    expect(validate({ focus: 7 })).toEqual({})
  })
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('RFC-201 /memory URL section authority', () => {
  test('functional tab updates preserve focus and adjacent search state', () => {
    expect(withMemoryTab({ focus: 'mem_123', source: 'distill', tab: 'all' }, 'fusion')).toEqual({
      focus: 'mem_123',
      source: 'distill',
      tab: 'fusion',
    })
  })

  test('route defaults to All and uses PageSectionNav without tab semantics', () => {
    const src = readFileSync(resolve(__dirname, '../src/routes/memory.tsx'), 'utf-8')
    expect(src).toContain("const requestedTab = isMemoryTab(search.tab) ? search.tab : 'all'")
    expect(src).toContain('const navigate = Route.useNavigate()')
    expect(src).toContain('search: (previous) => withMemoryTab(previous, next)')
    expect(src).toContain('hash })')
    expect(src).toContain('<PageSectionNav<MemoryTab>')
    expect(src).toContain('pageSectionCurrent={destination.ariaCurrent}')
    expect(src).not.toContain('<TabBar')
    expect(src).not.toContain('role="tabpanel"')
    expect(src).not.toContain('setTab(')
  })
})
