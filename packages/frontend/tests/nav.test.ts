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
import { ROLE_PERMISSIONS } from '@agent-workflow/shared'
import { NAV_GROUPS, navPermissionForPath, resolveActiveNav } from '@/lib/nav'

describe('RFC-032 resolveActiveNav — pathname → group / item / chrome flags', () => {
  test('guest keeps the complete navigation catalog while permissions shape page content', () => {
    // RFC-305 guest follow-up: navigation is product discovery, not an
    // authorization boundary. The guest preset deliberately lacks task and
    // repository reads, but those destinations must remain visible; backend
    // permissions and each page's read projection still own the data surface.
    expect(ROLE_PERMISSIONS.guest).not.toContain('tasks:read')
    expect(ROLE_PERMISSIONS.guest).not.toContain('repos:read')
    expect(NAV_GROUPS.flatMap((group) => group.subnav.map((item) => item.to))).toEqual([
      '/agents',
      '/skills',
      '/mcps',
      '/plugins',
      '/workflows',
      '/workgroups',
      '/intent',
      '/code',
      '/code/executors',
      '/code/assignments',
      '/tasks',
      '/outcomes',
      '/scheduled',
      '/repos',
      '/webhooks',
      '/memory',
    ])
  })

  test('destination permissions come from the same navigation catalog', () => {
    expect(navPermissionForPath('/tasks')).toBe('tasks:read')
    expect(navPermissionForPath('/tasks/task_1')).toBe('tasks:read')
    expect(navPermissionForPath('/tasks/new')).toBe('tasks:execute')
    expect(navPermissionForPath('/tasks/new/confirm')).toBe('tasks:execute')
    expect(navPermissionForPath('/repos')).toBe('repos:read')
    expect(navPermissionForPath('/agents/agent_1')).toBe('agents:read')
    expect(navPermissionForPath('/code')).toBe('digital-employees:read')
    expect(navPermissionForPath('/code/executors')).toBe('action-templates:read')
    expect(navPermissionForPath('/code/assignments')).toBe('repository-employee-assignments:read')
    expect(navPermissionForPath('/outcomes')).toBe('development-missions:read')
    expect(navPermissionForPath('/')).toBeNull()
    expect(navPermissionForPath('/account')).toBeNull()
  })

  test('every visible route has one explicit resource icon', () => {
    expect(NAV_GROUPS.flatMap((group) => group.subnav).map(({ to, icon }) => [to, icon])).toEqual([
      ['/agents', 'agent'],
      ['/skills', 'skill'],
      ['/mcps', 'mcp'],
      ['/plugins', 'plugin'],
      ['/workflows', 'workflow'],
      ['/workgroups', 'workgroup'],
      // RFC-234 — intent builder rides the workflow icon (it authors
      // workflows/workgroups; no dedicated glyph yet).
      ['/intent', 'workflow'],
      ['/code', 'agent'],
      ['/code/executors', 'workgroup'],
      ['/code/assignments', 'repo'],
      ['/tasks', 'task'],
      ['/outcomes', 'task'],
      ['/scheduled', 'schedule'],
      ['/repos', 'repo'],
      // RFC-257 UI 修订：webhook 配置单页（adminOnly 项，ShellNavigation 过滤）。
      ['/webhooks', 'webhook'],
      ['/memory', 'memory'],
    ])
  })

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

  test('/fusions/:id maps to the memory group (RFC-121 — fusions live on the Memory page)', () => {
    // RFC-121 moved fusions onto the /memory page (its "fusion" tab); the
    // detail route keeps the Memory group header highlighted on deep links,
    // mirroring the /reviews + /clarify → workflows fallback above.
    expect(resolveActiveNav('/fusions')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'memory',
      activeItemTo: null,
    })
    expect(resolveActiveNav('/fusions/abc')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'memory',
      activeItemTo: null,
    })
  })

  test('/tasks + /repos both belong to the tasks group', () => {
    expect(resolveActiveNav('/tasks').activeGroup).toBe('tasks')
    expect(resolveActiveNav('/tasks/abc').activeGroup).toBe('tasks')
    expect(resolveActiveNav('/repos').activeGroup).toBe('tasks')
  })

  test('digital employee construction stays separate from runtime and outcomes', () => {
    expect(resolveActiveNav('/code')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'digitalEmployees',
      activeItemTo: '/code',
    })
    expect(resolveActiveNav('/code/config/employees/employee-1')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'digitalEmployees',
      activeItemTo: '/code',
    })
    expect(resolveActiveNav('/code/executors')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'digitalEmployees',
      activeItemTo: '/code/executors',
    })
    expect(resolveActiveNav('/code/assignments')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'digitalEmployees',
      activeItemTo: '/code/assignments',
    })
    expect(resolveActiveNav('/outcomes')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'tasks',
      activeItemTo: '/outcomes',
    })
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
