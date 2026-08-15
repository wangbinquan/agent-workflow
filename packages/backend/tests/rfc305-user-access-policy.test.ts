import { describe, expect, test } from 'bun:test'
import {
  accessInvariantFailure,
  canonicalStoredAccess,
  planExactAccessTransition,
  planLegacyRoleTransition,
} from '../src/modules/identity-access/domain/userAccessPolicy'

describe('RFC-305 user access policy', () => {
  test('exact transition produces a canonical ordered diff', () => {
    const transition = planExactAccessTransition({
      currentRole: 'user',
      currentStoredPermissions: ['scripts:author', 'repos:update'],
      nextRole: 'user',
      nextAdditionalPermissions: ['repos:create', 'scripts:author'],
    })
    expect(transition.additionalPermissions).toEqual(['repos:create', 'scripts:author'])
    expect(transition.addedPermissions).toEqual(['repos:create'])
    expect(transition.removedPermissions).toEqual(['repos:update'])
    expect(transition.changed).toBe(true)
  })

  test('promotion removes redundant grants and downgrade never invents a missing grant', () => {
    const promoted = planLegacyRoleTransition({
      currentRole: 'user',
      currentStoredPermissions: ['scripts:author', 'repos:update'],
      nextRole: 'manager',
    })
    expect(promoted.additionalPermissions).toEqual([])
    expect(promoted.removedPermissions).toEqual(['repos:update', 'scripts:author'])

    const downgraded = planLegacyRoleTransition({
      currentRole: 'manager',
      currentStoredPermissions: [],
      nextRole: 'user',
    })
    expect(downgraded.additionalPermissions).toEqual([])
  })

  test('corrupt stored values are ignored with diagnostics', () => {
    const stored = canonicalStoredAccess({
      role: 'user',
      storedPermissions: ['scripts:author', 'settings:write', 'agents:read', 'retired'],
    })
    expect(stored.additionalPermissions).toEqual(['settings:write', 'scripts:author'])
    expect(stored.diagnostics).toHaveLength(2)
  })

  test('system, self and last access-administrator invariants are permission based', () => {
    const base = {
      targetUserId: 'target',
      actorUserId: 'admin',
      currentStatus: 'active' as const,
      nextStatus: 'active' as const,
      accessChanged: false,
      currentCanManageUserAccess: true,
      nextCanManageUserAccess: true,
      otherActiveAccessAdministratorCount: 1,
      systemUserId: '__system__',
    }
    expect(accessInvariantFailure({ ...base, targetUserId: '__system__' })).toBe(
      'system-user-immutable',
    )
    expect(
      accessInvariantFailure({
        ...base,
        actorUserId: 'target',
        accessChanged: true,
      }),
    ).toBe('self-access-change-forbidden')
    expect(
      accessInvariantFailure({
        ...base,
        nextCanManageUserAccess: false,
        otherActiveAccessAdministratorCount: 0,
        accessChanged: true,
      }),
    ).toBe('last-access-administrator-protection')
    expect(
      accessInvariantFailure({
        ...base,
        nextCanManageUserAccess: false,
        otherActiveAccessAdministratorCount: 1,
        accessChanged: true,
      }),
    ).toBeNull()
  })
})
