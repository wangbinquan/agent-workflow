// RFC-036 — permission catalog snapshot + role mapping invariants. These
// guard against the most common multi-user regression: silently adding a
// write permission to the `user` role (privilege escalation) or removing a
// read permission (UI breakage). Both directions are pinned.
//
// RFC-247 reshaped the catalog: `资源:write` → `:create` / `:update` / `:delete`
// (+ `:execute` where a route exists), and added the token-grant resolver. The
// role REACH is unchanged (D15 "等价照搬"); only the point shapes moved. The
// snapshots below are therefore the post-RFC-247 equivalents of the pre-RFC-247
// ones — if one of them reds, ask "did a role's reach change?", not "did a name
// change?".

import { describe, expect, test } from 'bun:test'
import {
  ADMIN_ONLY_PERMISSIONS,
  DELETE_POINTS,
  grantableMatrixPoints,
  hasPermission,
  isResourceAdminRole,
  MANAGER_DENIED_PERMISSIONS,
  MATRIX_DOMAIN_POINTS,
  PERMISSIONS,
  RANGE_POINTS,
  READ_POINTS,
  resolveTokenPermissions,
  ROLE_PERMISSIONS,
  RoleSchema,
  ROUTE_BACKED_POINTS,
  SYSTEM_DOMAIN_POINTS,
  type Permission,
} from '../src/schemas/permission'

describe('PERMISSIONS catalog', () => {
  test('contains the documented 58 entries', () => {
    // RFC-222 added tasks:delete (33 → 34); RFC-234 added intent:read/write (→ 36).
    // RFC-247 split the five `:write` points into create/update/delete, gave the
    // previously-ungated domains (workgroups / scheduled-tasks) real points,
    // folded the five RFC-041 memory points into four verbs, retired
    // `tasks:launch` → `tasks:execute`, and DELETED the two dead cancel range
    // points, and did NOT mint agents:execute / workgroups:execute because
    // RFC-165 F15/N1 gates every launch endpoint uniformly on tasks:execute
    // (36 → 58).
    expect(PERMISSIONS.length).toBe(58)
  })

  test('admin role is the full PERMISSIONS set', () => {
    const adminSet = new Set<Permission>(ROLE_PERMISSIONS.admin)
    for (const p of PERMISSIONS) {
      expect(adminSet.has(p)).toBe(true)
    }
    expect(ROLE_PERMISSIONS.admin.length).toBe(PERMISSIONS.length)
  })

  test('user role contains exactly the documented baseline (46 entries)', () => {
    const expected: Permission[] = [
      // reads
      'agents:read',
      'skills:read',
      'mcps:read',
      'plugins:read',
      'workflows:read',
      'workgroups:read',
      'scheduled-tasks:read',
      'repos:read',
      'memory:read',
      'tasks:read',
      'runtime:read',
      // RFC-099 — resource writes are route-gate-open for all users; the
      // per-row owner/grant check lives in services/resourceAcl.ts.
      // RFC-247 — each former `:write` is now three points.
      'agents:create',
      'agents:update',
      'agents:delete',
      'skills:create',
      'skills:update',
      'skills:delete',
      'mcps:create',
      'mcps:update',
      'mcps:delete',
      'plugins:create',
      'plugins:update',
      'plugins:delete',
      'workflows:create',
      'workflows:update',
      'workflows:delete',
      // RFC-247 — workgroups had NO permission point at all before, i.e. every
      // logged-in user could use them. Same reach, now expressible.
      'workgroups:create',
      'workgroups:update',
      'workgroups:delete',
      // RFC-247 — schedule create/edit sat behind `tasks:launch` (RFC-165 N1-r3);
      // PUT/DELETE were ungated entirely.
      'scheduled-tasks:create',
      'scheduled-tasks:update',
      'scheduled-tasks:delete',
      // execute — formerly reached via `tasks:launch` or the resource's `:write`
      'mcps:execute',
      'plugins:execute',
      'workflows:execute',
      'scheduled-tasks:execute',
      'tasks:execute',
      'users:search',
      'tasks:read:own',
      'tasks:update',
      'account:self',
      // RFC-041 / RFC-099 (D12) — route gate open; per-row canManageMemory is
      // the real gate. RFC-247 folded the five old points into four verbs.
      'memory:create',
      'memory:update',
      'memory:delete',
      // RFC-234 — intent builder is open to every logged-in user (D22)
      'intent:read',
      'intent:write',
    ]
    expect([...ROLE_PERMISSIONS.user].sort()).toEqual(expected.sort())
    expect(ROLE_PERMISSIONS.user.length).toBe(46)
  })

  test('user role does NOT include any admin-only point (snapshot guard)', () => {
    const adminOnly: Permission[] = [
      // RFC-099: repos stay OUT of the ownership ACL model — the repos write
      // verbs remain admin/manager while the five resource writes are baseline.
      'repos:create',
      'repos:delete',
      'repos:execute',
      'users:read',
      'users:write',
      'settings:read',
      'settings:write',
      'oidc:read',
      'oidc:configure',
      'backup:run',
      'tasks:read:all',
      // RFC-222 — task deletion is admin-only (NOT manager, NOT user).
      'tasks:delete',
    ]
    for (const p of adminOnly) {
      expect(ROLE_PERMISSIONS.user.includes(p)).toBe(false)
    }
    // ADMIN_ONLY_PERMISSIONS is still "PERMISSIONS − user baseline" — it stays
    // admin-vs-user by design even though some members (repos:*) are now ALSO
    // manager's. Manager's negative set is MANAGER_DENIED below.
    expect([...ADMIN_ONLY_PERMISSIONS].sort()).toEqual(adminOnly.sort())
  })

  test('hasPermission truth matrix', () => {
    expect(hasPermission('admin', 'agents:update')).toBe(true)
    expect(hasPermission('admin', 'oidc:configure')).toBe(true)
    expect(hasPermission('admin', 'users:read')).toBe(true)
    expect(hasPermission('user', 'agents:read')).toBe(true)
    // RFC-099: route-gate write open to users (row-level ACL is the real gate)
    expect(hasPermission('user', 'agents:create')).toBe(true)
    expect(hasPermission('user', 'agents:update')).toBe(true)
    expect(hasPermission('user', 'agents:delete')).toBe(true)
    expect(hasPermission('user', 'repos:create')).toBe(false)
    expect(hasPermission('user', 'settings:read')).toBe(false)
    expect(hasPermission('user', 'users:read')).toBe(false)
    expect(hasPermission('user', 'users:search')).toBe(true)
    expect(hasPermission('user', 'tasks:read:all')).toBe(false)
    expect(hasPermission('user', 'tasks:read:own')).toBe(true)
  })
})

// RFC-247 — the retired point names. Reintroducing any of them means someone
// re-split a verb the routes do not distinguish, or resurrected a dead point.
describe('RFC-247 retired names stay retired', () => {
  const RETIRED = [
    'agents:write',
    'skills:write',
    'mcps:write',
    'plugins:write',
    'workflows:write',
    'repos:write',
    'tasks:launch',
    'tasks:cancel:own',
    'tasks:cancel:all',
    'memory:approve',
    'memory:archive',
    'memory:edit',
    'memory:write_feedback',
  ]

  test('no MATRIX-domain `:write` point survives — the split is complete', () => {
    // System-domain points keep their own vocabulary (`users:write`,
    // `settings:write`, `intent:write`); RFC-247 only reshaped the matrix domain.
    expect(MATRIX_DOMAIN_POINTS.filter((p) => p.endsWith(':write'))).toEqual([])
    // …and the surviving `:write` names are exactly the three system-domain ones.
    expect(PERMISSIONS.filter((p) => p.endsWith(':write')).sort()).toEqual([
      'intent:write',
      'settings:write',
      'users:write',
    ])
  })

  test('every retired name is absent', () => {
    for (const name of RETIRED) {
      expect((PERMISSIONS as readonly string[]).includes(name)).toBe(false)
    }
  })

  test('no `schedules:` variant — the resource key is `scheduled-tasks` (AC-47)', () => {
    expect(PERMISSIONS.filter((p) => p.startsWith('schedules:'))).toEqual([])
    expect(PERMISSIONS.filter((p) => p.startsWith('scheduled-tasks:')).length).toBe(5)
  })

  test('no point exists that no route could reference', () => {
    // Four points a mechanical "every resource gets every verb" pass would have
    // minted, each of which would then sit on the account page's token matrix
    // advertising a capability that maps to no endpoint:
    //   repos:update       — repos.ts + cached-repos.ts have zero PUT/PATCH
    //   skills:execute     — skills.ts has no execute-semantics route
    //   agents:execute     — RFC-165 F15/N1 gates agent launch on tasks:execute
    //   workgroups:execute — …and workgroup launch likewise
    for (const dead of ['repos:update', 'skills:execute', 'agents:execute', 'workgroups:execute']) {
      expect((PERMISSIONS as readonly string[]).includes(dead)).toBe(false)
    }
  })
})

// RFC-247 — point classification. A bug in any of these silently changes what
// every token in the system can do, so each derivation is pinned.
describe('RFC-247 point classification', () => {
  test('READ_POINTS never overlaps SYSTEM_DOMAIN_POINTS', () => {
    // Regression lock: an earlier draft hand-listed the system `:read` points to
    // exclude and missed `intent:read`, which then rode into "reads a token
    // always gets" — i.e. every token silently gained a system-domain read.
    const leak = READ_POINTS.filter((p) => SYSTEM_DOMAIN_POINTS.includes(p))
    expect(leak).toEqual([])
  })

  test('DELETE_POINTS is exactly the `:delete` suffix set', () => {
    expect([...DELETE_POINTS].sort()).toEqual(
      PERMISSIONS.filter((p) => p.endsWith(':delete')).sort(),
    )
    expect(DELETE_POINTS.length).toBe(10)
  })

  test('MATRIX_DOMAIN_POINTS = PERMISSIONS − SYSTEM_DOMAIN_POINTS', () => {
    expect(MATRIX_DOMAIN_POINTS.length).toBe(PERMISSIONS.length - SYSTEM_DOMAIN_POINTS.length)
    for (const p of MATRIX_DOMAIN_POINTS) expect(SYSTEM_DOMAIN_POINTS.includes(p)).toBe(false)
  })

  test('ROUTE_BACKED_POINTS excludes range points (they are handler-consumed)', () => {
    for (const p of RANGE_POINTS) expect(ROUTE_BACKED_POINTS.includes(p)).toBe(false)
    expect(ROUTE_BACKED_POINTS.length).toBe(MATRIX_DOMAIN_POINTS.length - RANGE_POINTS.length)
  })
})

// RFC-247 — the token grant formula. This is THE security-critical function:
// every API token in the system gets its capabilities from it.
describe('RFC-247 resolveTokenPermissions', () => {
  test('an empty matrix yields a READ-ONLY token, not the full role baseline', () => {
    // Pre-RFC-247 this was the docs/audit-backlog.md:61 hole: buildActor only
    // narrowed when `patScopes.length > 0`, so a scope-less PAT silently held
    // everything its owner's role held.
    for (const role of ['user', 'manager', 'admin'] as const) {
      const granted = [...resolveTokenPermissions({ role, matrix: [] })]
      expect(granted.length).toBeGreaterThan(0)
      for (const p of granted) expect(READ_POINTS.includes(p)).toBe(true)
    }
  })

  test('a token never exceeds its owner role', () => {
    const granted = resolveTokenPermissions({
      role: 'user',
      matrix: ['repos:create', 'agents:create', 'settings:write'],
    })
    expect(granted.has('agents:create')).toBe(true)
    expect(granted.has('repos:create')).toBe(false) // not in the user baseline
    expect(granted.has('settings:write')).toBe(false) // system domain
  })

  test('system-domain points are stripped even for an admin owner', () => {
    const granted = resolveTokenPermissions({
      role: 'admin',
      matrix: [...SYSTEM_DOMAIN_POINTS],
    })
    for (const p of SYSTEM_DOMAIN_POINTS) expect(granted.has(p)).toBe(false)
  })

  test('delete is opt-in per point, even for admin', () => {
    const withoutDelete = resolveTokenPermissions({ role: 'admin', matrix: ['agents:update'] })
    expect(withoutDelete.has('agents:update')).toBe(true)
    expect(withoutDelete.has('agents:delete')).toBe(false)

    const withDelete = resolveTokenPermissions({
      role: 'admin',
      matrix: ['agents:update', 'agents:delete'],
    })
    expect(withDelete.has('agents:delete')).toBe(true)
    // ticking one delete point must not grant any other
    expect(withDelete.has('workflows:delete')).toBe(false)
    expect(withDelete.has('tasks:delete')).toBe(false)
  })

  test('no matrix can grant a token a delete point its role lacks', () => {
    const granted = resolveTokenPermissions({ role: 'user', matrix: ['tasks:delete'] })
    expect(granted.has('tasks:delete')).toBe(false)
  })
})

describe('RFC-247 grantableMatrixPoints', () => {
  test('never offers read points (reads are always on, not tickable)', () => {
    for (const role of ['user', 'manager', 'admin'] as const) {
      for (const p of grantableMatrixPoints(role)) {
        expect(READ_POINTS.includes(p)).toBe(false)
      }
    }
  })

  test('never offers a point the role lacks — a plain user sees no repos verb', () => {
    const userGrantable = grantableMatrixPoints('user')
    expect(userGrantable.filter((p) => p.startsWith('repos:'))).toEqual([])
    expect(grantableMatrixPoints('manager').filter((p) => p.startsWith('repos:')).length).toBe(3)
  })

  test('never offers a system-domain point to anyone', () => {
    for (const role of ['user', 'manager', 'admin'] as const) {
      for (const p of grantableMatrixPoints(role)) {
        expect(SYSTEM_DOMAIN_POINTS.includes(p)).toBe(false)
      }
    }
  })

  test('everything offered is actually resolvable for that role', () => {
    for (const role of ['user', 'manager', 'admin'] as const) {
      const offered = grantableMatrixPoints(role)
      const granted = resolveTokenPermissions({ role, matrix: offered })
      for (const p of offered) expect(granted.has(p)).toBe(true)
    }
  })
})

// RFC-222 — the `manager` (资源管理员) role. manager = admin minus user
// management, system settings/ops, and task deletion; plus every resource-
// domain capability. Both the positive and negative sets are pinned so a future
// edit that hands manager a system-domain point (or drops a resource one) reds.
describe('RFC-222 manager role', () => {
  test('RoleSchema accepts exactly the three roles', () => {
    expect(RoleSchema.options).toEqual(['admin', 'user', 'manager'])
    expect(RoleSchema.safeParse('manager').success).toBe(true)
    expect(RoleSchema.safeParse('auditor').success).toBe(false)
  })

  test('manager = user baseline + repos verbs + tasks:read:all', () => {
    const expected: Permission[] = [
      ...ROLE_PERMISSIONS.user,
      'repos:create',
      'repos:delete',
      'repos:execute',
      'tasks:read:all',
    ]
    expect([...ROLE_PERMISSIONS.manager].sort()).toEqual([...new Set(expected)].sort())
  })

  test('manager positive resource-domain points', () => {
    for (const p of [
      'agents:create',
      'agents:update',
      'agents:delete',
      'skills:update',
      'mcps:update',
      'plugins:update',
      'workflows:update',
      'workgroups:update',
      'repos:create',
      'repos:delete',
      'tasks:read:all',
      'memory:create',
      'memory:delete',
    ] as const) {
      expect(hasPermission('manager', p)).toBe(true)
    }
  })

  test('MANAGER_DENIED points are ∈ admin and ∉ manager (and ∉ user)', () => {
    expect([...MANAGER_DENIED_PERMISSIONS].sort()).toEqual(
      [
        'users:read',
        'users:write',
        'settings:read',
        'settings:write',
        'oidc:read',
        'oidc:configure',
        'backup:run',
        'tasks:delete',
      ].sort(),
    )
    for (const p of MANAGER_DENIED_PERMISSIONS) {
      expect(hasPermission('admin', p)).toBe(true)
      expect(hasPermission('manager', p)).toBe(false)
      expect(hasPermission('user', p)).toBe(false)
    }
  })

  test('tasks:delete belongs to admin only', () => {
    expect(hasPermission('admin', 'tasks:delete')).toBe(true)
    expect(hasPermission('manager', 'tasks:delete')).toBe(false)
    expect(hasPermission('user', 'tasks:delete')).toBe(false)
  })

  test('isResourceAdminRole: admin ∪ manager, not user', () => {
    expect(isResourceAdminRole('admin')).toBe(true)
    expect(isResourceAdminRole('manager')).toBe(true)
    expect(isResourceAdminRole('user')).toBe(false)
  })
})
