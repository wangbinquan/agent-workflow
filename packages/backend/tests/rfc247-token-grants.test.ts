// RFC-247 — locks how a PAT's capability set is derived (`auth/actor.ts`
// buildActor → shared resolveTokenPermissions).
//
// The regression this exists to prevent is docs/audit-backlog.md:61: before
// RFC-247, `buildActor` only narrowed when `patScopes.length > 0`, so a
// scope-less PAT silently carried its owner's ENTIRE role baseline. A token the
// account page describes as "read-only" could delete every resource its owner
// could delete. Two more invariants ride along:
//   - a token never exceeds its owner's role (RFC-036, unchanged);
//   - delete is opt-in PER POINT (RFC-247 D4), generalised from RFC-222's
//     hand-listed PAT_EXPLICIT_ONLY_PERMISSIONS.
//
// Session and daemon actors are deliberately untouched by all of this — they
// are the interactive/bootstrap paths, not the token path.

import { describe, expect, test } from 'bun:test'
import { ROLE_PERMISSIONS, type Permission, type Role } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'

function user(role: Role) {
  return {
    id: 'u1',
    username: 'u1',
    displayName: 'U1',
    role,
    status: 'active' as const,
  }
}

function patPerms(role: Role, patScopes: Permission[]): Set<Permission> {
  return new Set(buildActor({ user: user(role), source: 'pat', patScopes }).permissions)
}

describe('RFC-247 — an empty matrix yields a read-only token', () => {
  for (const role of ['user', 'manager', 'admin'] as const) {
    test(`${role}: empty scopes grant reads but no write/execute/delete`, () => {
      const perms = patPerms(role, [])
      expect(perms.size).toBeGreaterThan(0)
      for (const p of perms) {
        // every granted point must be a read of some kind
        expect(p.includes(':read')).toBe(true)
      }
      expect(perms.has('agents:create')).toBe(false)
      expect(perms.has('agents:update')).toBe(false)
      expect(perms.has('agents:delete')).toBe(false)
      expect(perms.has('tasks:execute')).toBe(false)
    })
  }

  test('the pre-RFC-247 hole is closed: empty scopes ≠ full role baseline', () => {
    const perms = patPerms('admin', [])
    expect(perms.size).toBeLessThan(ROLE_PERMISSIONS.admin.length)
  })
})

describe('RFC-247 — reads are always on', () => {
  test('a token that ticked only one write verb can still read', () => {
    const perms = patPerms('user', ['workflows:create'])
    expect(perms.has('workflows:create')).toBe(true)
    expect(perms.has('agents:read')).toBe(true)
    expect(perms.has('workflows:read')).toBe(true)
    expect(perms.has('tasks:read')).toBe(true)
  })
})

describe('RFC-247 — a token never exceeds its owner role', () => {
  test('a plain user cannot tick a repos verb', () => {
    const perms = patPerms('user', ['repos:create', 'repos:delete'])
    expect(perms.has('repos:create')).toBe(false)
    expect(perms.has('repos:delete')).toBe(false)
    // …but the manager who legitimately has them does get them
    expect(patPerms('manager', ['repos:create']).has('repos:create')).toBe(true)
  })

  test('nobody gets a system-domain point through a token — not even admin', () => {
    const perms = patPerms('admin', [
      'settings:write',
      'users:write',
      'backup:run',
      'oidc:configure',
      'account:self',
      'intent:write',
    ])
    for (const p of [
      'settings:write',
      'users:write',
      'backup:run',
      'oidc:configure',
      'account:self',
      'intent:write',
    ] as const) {
      expect(perms.has(p)).toBe(false)
    }
  })
})

describe('RFC-247 — delete is opt-in per point', () => {
  test('ticking update does not grant delete', () => {
    const perms = patPerms('admin', ['agents:update'])
    expect(perms.has('agents:update')).toBe(true)
    expect(perms.has('agents:delete')).toBe(false)
  })

  test('ticking one delete does not grant any other delete', () => {
    const perms = patPerms('admin', ['agents:delete'])
    expect(perms.has('agents:delete')).toBe(true)
    expect(perms.has('workflows:delete')).toBe(false)
    expect(perms.has('skills:delete')).toBe(false)
    expect(perms.has('tasks:delete')).toBe(false)
  })

  test('a user cannot obtain tasks:delete (admin-only) by ticking it', () => {
    expect(patPerms('user', ['tasks:delete']).has('tasks:delete')).toBe(false)
  })
})

describe('RFC-247 — session and daemon actors are unaffected', () => {
  for (const source of ['session', 'daemon'] as const) {
    test(`${source} actor keeps the full role baseline`, () => {
      const actor = buildActor({ user: user('admin'), source })
      expect(actor.permissions.size).toBe(ROLE_PERMISSIONS.admin.length)
      // notably including the points a token can never hold
      expect(actor.permissions.has('settings:write')).toBe(true)
      expect(actor.permissions.has('tasks:delete')).toBe(true)
    })
  }
})
