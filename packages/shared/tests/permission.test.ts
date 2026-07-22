// RFC-036 — permission catalog snapshot + role mapping invariants. These
// guard against the most common multi-user regression: silently adding a
// write permission to the `user` role (privilege escalation) or removing a
// read permission (UI breakage). Both directions are pinned.

import { describe, expect, test } from 'bun:test'
import {
  ADMIN_ONLY_PERMISSIONS,
  hasPermission,
  isResourceAdminRole,
  MANAGER_DENIED_PERMISSIONS,
  PAT_EXPLICIT_ONLY_PERMISSIONS,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  RoleSchema,
  type Permission,
} from '../src/schemas/permission'

describe('PERMISSIONS catalog', () => {
  test('contains the documented 34 entries', () => {
    // RFC-222 added tasks:delete (33 → 34).
    expect(PERMISSIONS.length).toBe(34)
  })

  test('admin role is the full PERMISSIONS set', () => {
    const adminSet = new Set<Permission>(ROLE_PERMISSIONS.admin)
    for (const p of PERMISSIONS) {
      expect(adminSet.has(p)).toBe(true)
    }
    expect(ROLE_PERMISSIONS.admin.length).toBe(PERMISSIONS.length)
  })

  test('user role contains exactly the documented baseline (23 entries)', () => {
    const expected: Permission[] = [
      'agents:read',
      'skills:read',
      'mcps:read',
      'plugins:read',
      'workflows:read',
      'repos:read',
      'runtime:read',
      // RFC-099 — resource writes are route-gate-open for all users; the
      // per-row owner/grant check lives in services/resourceAcl.ts.
      'agents:write',
      'skills:write',
      'mcps:write',
      'plugins:write',
      'workflows:write',
      'users:search',
      'tasks:launch',
      'tasks:read:own',
      'tasks:cancel:own',
      'account:self',
      // RFC-041 — read approved memories + write task feedback
      'memory:read',
      'memory:write_feedback',
      // RFC-099 (D12) — route gate open; per-row canManageMemory is the gate
      'memory:approve',
      'memory:archive',
      'memory:delete',
      'memory:edit',
    ]
    expect([...ROLE_PERMISSIONS.user].sort()).toEqual(expected.sort())
  })

  test('user role does NOT include any admin-only point (snapshot guard)', () => {
    const adminOnly: Permission[] = [
      // RFC-099: repos stay OUT of the ownership ACL model — repos:write
      // remains admin-only while the five resource writes moved to baseline.
      'repos:write',
      'users:read',
      'users:write',
      'settings:read',
      'settings:write',
      'oidc:read',
      'oidc:configure',
      'backup:run',
      'tasks:read:all',
      'tasks:cancel:all',
      // RFC-222 — task deletion is admin-only (NOT manager, NOT user).
      'tasks:delete',
    ]
    for (const p of adminOnly) {
      expect(ROLE_PERMISSIONS.user.includes(p)).toBe(false)
    }
    // ADMIN_ONLY_PERMISSIONS is still "PERMISSIONS − user baseline" — it stays
    // admin-vs-user by design even though some members (repos:write etc.) are
    // now ALSO manager's. Manager's negative set is MANAGER_DENIED below.
    expect([...ADMIN_ONLY_PERMISSIONS].sort()).toEqual(adminOnly.sort())
  })

  test('hasPermission truth matrix', () => {
    expect(hasPermission('admin', 'agents:write')).toBe(true)
    expect(hasPermission('admin', 'oidc:configure')).toBe(true)
    expect(hasPermission('admin', 'users:read')).toBe(true)
    expect(hasPermission('user', 'agents:read')).toBe(true)
    // RFC-099: route-gate write open to users (row-level ACL is the real gate)
    expect(hasPermission('user', 'agents:write')).toBe(true)
    expect(hasPermission('user', 'repos:write')).toBe(false)
    expect(hasPermission('user', 'settings:read')).toBe(false)
    expect(hasPermission('user', 'users:read')).toBe(false)
    expect(hasPermission('user', 'users:search')).toBe(true)
    expect(hasPermission('user', 'tasks:read:all')).toBe(false)
    expect(hasPermission('user', 'tasks:read:own')).toBe(true)
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

  test('manager = user baseline + repos:write + tasks:read:all + tasks:cancel:all', () => {
    const expected: Permission[] = [
      ...ROLE_PERMISSIONS.user,
      'repos:write',
      'tasks:read:all',
      'tasks:cancel:all',
    ]
    expect([...ROLE_PERMISSIONS.manager].sort()).toEqual([...new Set(expected)].sort())
  })

  test('manager positive resource-domain points', () => {
    for (const p of [
      'agents:write',
      'skills:write',
      'mcps:write',
      'plugins:write',
      'workflows:write',
      'repos:write',
      'tasks:read:all',
      'tasks:cancel:all',
      'memory:approve',
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

  test('PAT_EXPLICIT_ONLY holds tasks:delete', () => {
    expect([...PAT_EXPLICIT_ONLY_PERMISSIONS]).toEqual(['tasks:delete'])
  })
})
