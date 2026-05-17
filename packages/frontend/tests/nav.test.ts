// RFC-032 resolveActiveNav — locks the pathname → active-state mapping.
//
// Why this test exists: PR1 of RFC-032 introduces a 3-group sidebar whose
// highlight state is driven by a pure function. Routing-internal active-state
// helpers (TanStack's `useMatch`) are awkward to assert against in isolation,
// so the shell renders highlight purely from `resolveActiveNav(pathname)`.
// Any future tweak to that mapping (e.g. PR2 lifting /reviews + /clarify out
// of NAV_GROUPS) must keep these case-by-case assertions green to avoid
// silently breaking sidebar highlight on detail pages.

import { describe, expect, test } from 'vitest'
import { resolveActiveNav } from '@/lib/nav'

describe('RFC-032 resolveActiveNav — pathname → group / item / chrome flags', () => {
  test('root path activates the home link, nothing else', () => {
    expect(resolveActiveNav('/')).toEqual({
      onHome: true,
      onSettings: false,
      activeGroup: null,
      activeItemTo: null,
    })
  })

  test('/agents and detail children both activate the agents group', () => {
    expect(resolveActiveNav('/agents')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'agents',
      activeItemTo: '/agents',
    })
    expect(resolveActiveNav('/agents/abc')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'agents',
      activeItemTo: '/agents',
    })
  })

  test('capability sub-items all land in the agents group', () => {
    expect(resolveActiveNav('/skills').activeGroup).toBe('agents')
    expect(resolveActiveNav('/skills').activeItemTo).toBe('/skills')
    expect(resolveActiveNav('/mcps').activeGroup).toBe('agents')
    expect(resolveActiveNav('/mcps').activeItemTo).toBe('/mcps')
    expect(resolveActiveNav('/plugins').activeGroup).toBe('agents')
    expect(resolveActiveNav('/plugins').activeItemTo).toBe('/plugins')
  })

  test('skills detail route still maps to the agents group', () => {
    expect(resolveActiveNav('/skills/123/files')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'agents',
      activeItemTo: '/skills',
    })
  })

  test('/workflows + workflow editor deep links activate the workflows group', () => {
    expect(resolveActiveNav('/workflows').activeGroup).toBe('workflows')
    expect(resolveActiveNav('/workflows/edit/x').activeGroup).toBe('workflows')
    expect(resolveActiveNav('/workflows/launch/x').activeGroup).toBe('workflows')
  })

  test('/reviews + /clarify routes map to the workflows group with NO sub-item active (PR2 inbox)', () => {
    // PR2 of RFC-032 lifted /reviews and /clarify out of NAV_GROUPS — both
    // now live behind the unified inbox drawer. The explicit fallback at
    // the bottom of `resolveActiveNav` keeps `activeGroup:'workflows'` so
    // sidebar headers stay highlighted on detail-page deep links, but
    // `activeItemTo` is null because there is no visible sub-item to mark.
    expect(resolveActiveNav('/reviews')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'workflows',
      activeItemTo: null,
    })
    expect(resolveActiveNav('/reviews/abc')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'workflows',
      activeItemTo: null,
    })
    expect(resolveActiveNav('/clarify')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'workflows',
      activeItemTo: null,
    })
    expect(resolveActiveNav('/clarify/xyz')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'workflows',
      activeItemTo: null,
    })
  })

  test('/tasks + /repos both belong to the tasks group', () => {
    expect(resolveActiveNav('/tasks').activeGroup).toBe('tasks')
    expect(resolveActiveNav('/tasks/abc').activeGroup).toBe('tasks')
    expect(resolveActiveNav('/repos').activeGroup).toBe('tasks')
  })

  test('/settings and any settings sub-path activates the gear, nothing else', () => {
    expect(resolveActiveNav('/settings')).toEqual({
      onHome: false,
      onSettings: true,
      activeGroup: null,
      activeItemTo: null,
    })
    expect(resolveActiveNav('/settings/runtime')).toEqual({
      onHome: false,
      onSettings: true,
      activeGroup: null,
      activeItemTo: null,
    })
  })

  test('unknown paths produce all-inactive state (defensive default)', () => {
    expect(resolveActiveNav('/random-unknown')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: null,
      activeItemTo: null,
    })
  })
})
