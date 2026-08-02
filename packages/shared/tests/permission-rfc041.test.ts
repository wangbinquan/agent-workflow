// RFC-041 — locks the memory permission surface and the admin / user split.
//
// RFC-247 retired the five RFC-041 point names (`memory:approve` / `:archive` /
// `:edit` / `:delete` / `:write_feedback`) and folded them into the four-verb
// matrix shape shared by every resource type. This file keeps RFC-041's and
// RFC-099's INTENT under lock — "the memory write surface exists and is open to
// the plain `user` role at the route gate, with the real check being per-row
// canManageMemory" — while asserting it against the new point names. The old
// names must NOT come back: reintroducing `memory:approve` would re-split a
// verb that no route actually distinguishes.
//
// Mapping (design/RFC-247-mcp-remote-access/design.md §2.3):
//   memory:read            → memory:read      (unchanged)
//   memory:approve         → memory:create    (POST /api/memories)
//                          + memory:update    (POST /:id/promote)
//   memory:write_feedback  → memory:create    (POST /api/tasks/:id/feedback)
//   memory:archive         → memory:update    (POST /:id/archive|unarchive)
//   memory:edit            → memory:update    (PATCH /:id)
//   memory:delete          → memory:delete    (unchanged)

import { describe, expect, test } from 'bun:test'
import {
  ADMIN_ONLY_PERMISSIONS,
  hasPermission,
  PERMISSIONS,
  ROLE_PERMISSIONS,
} from '../src/schemas/permission'

const MEMORY_PERMS = ['memory:read', 'memory:create', 'memory:update', 'memory:delete'] as const

/** The RFC-041 names RFC-247 retired. Reintroducing any of them is a regression. */
const RETIRED_RFC041_NAMES = [
  'memory:approve',
  'memory:archive',
  'memory:edit',
  'memory:write_feedback',
] as const

describe('PERMISSIONS literal — memory surface', () => {
  test('all 4 memory verbs exist', () => {
    for (const p of MEMORY_PERMS) {
      expect(PERMISSIONS.includes(p)).toBe(true)
    }
  })

  test('the retired RFC-041 point names are gone and stay gone (RFC-247)', () => {
    for (const name of RETIRED_RFC041_NAMES) {
      expect((PERMISSIONS as readonly string[]).includes(name)).toBe(false)
    }
  })
})

describe('ROLE_PERMISSIONS — memory surface', () => {
  test('admin has all 4 memory verbs', () => {
    for (const p of MEMORY_PERMS) {
      expect(hasPermission('admin', p)).toBe(true)
    }
  })

  // RFC-099 (D12): the memory write surface moved from admin-only to
  // route-gate-open — the real gate is per-row canManageMemory (scope-resource
  // owner or resource-admin; repo/global rows stay resource-admin at the check).
  // RFC-247 D15 carried that reach over unchanged.
  test('user passes the route gate for all 4 memory verbs (RFC-099)', () => {
    for (const p of MEMORY_PERMS) {
      expect(hasPermission('user', p)).toBe(true)
    }
  })

  test('manager inherits the same memory reach as user (RFC-222)', () => {
    for (const p of MEMORY_PERMS) {
      expect(hasPermission('manager', p)).toBe(true)
    }
  })

  test('no memory verb sits in ADMIN_ONLY_PERMISSIONS (RFC-099)', () => {
    for (const p of MEMORY_PERMS) {
      expect(ADMIN_ONLY_PERMISSIONS.includes(p)).toBe(false)
    }
  })

  test('ROLE_PERMISSIONS has no stale memory entry under any role', () => {
    for (const role of ['admin', 'user', 'manager'] as const) {
      const stale = ROLE_PERMISSIONS[role].filter(
        (p) => p.startsWith('memory:') && !(MEMORY_PERMS as readonly string[]).includes(p),
      )
      expect(stale).toEqual([])
    }
  })
})
