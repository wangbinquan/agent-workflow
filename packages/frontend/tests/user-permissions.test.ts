import { RoleSchema } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import { enUS } from '@/i18n/en-US'
import { zhCN } from '@/i18n/zh-CN'
import {
  derivePermissionRows,
  diffUserAccess,
  rebaseUserAdditionalPermissions,
  summarizeAccessChange,
  toggleAdditionalPermission,
} from '@/lib/user-permissions'

function translate(key: string): string {
  let value: unknown = enUS
  for (const part of key.split('.')) {
    if (typeof value !== 'object' || value === null) return key
    value = (value as Record<string, unknown>)[part]
  }
  return typeof value === 'string' ? value : key
}

describe('RFC-305 user permission view model', () => {
  test('every account role preset has a user-menu label in both locales', () => {
    for (const role of RoleSchema.options) {
      expect(enUS.account.roles[role]).toBeTruthy()
      expect(zhCN.account.roles[role]).toBeTruthy()
    }
  })

  test('derives all rows from the shared catalog with no dialog-owned permission list', () => {
    const model = derivePermissionRows({
      role: 'user',
      additionalPermissions: ['scripts:author'],
      locale: 'en-US',
      translate,
    })
    // RFC-304 +8: two capability template layers × four verbs. The user
    // baseline gains 5 of them (both reads + the three GROUP-layer writes);
    // the three DEPARTMENT-layer writes are system-domain, so they show as
    // grantable rows rather than baseline ones.
    expect(model.permissions).toHaveLength(81)
    expect(model.effectiveCount).toBe(55)
    expect(model.additionalCount).toBe(1)
    expect(model.permissions.find((row) => row.permission === 'agents:read')).toMatchObject({
      source: 'baseline',
      effective: true,
      mutable: false,
    })
    expect(model.permissions.find((row) => row.permission === 'scripts:author')).toMatchObject({
      source: 'additional',
      effective: true,
      mutable: true,
    })
    expect(model.permissions.find((row) => row.permission === 'settings:write')).toMatchObject({
      source: 'available',
      effective: false,
      mutable: true,
    })
    expect(model.permissions.find((row) => row.permission === 'account:self')).toMatchObject({
      source: 'intrinsic',
      effective: true,
      mutable: false,
    })
  })

  test('search matches localized copy and raw id without changing selection', () => {
    const model = derivePermissionRows({
      role: 'user',
      additionalPermissions: ['scripts:author'],
      search: 'scripts:author',
      locale: 'en-US',
      translate,
    })
    expect(model.permissions.map((row) => row.permission)).toEqual(['scripts:author'])
    expect(model.additionalCount).toBe(1)
  })

  test('toggles every non-intrinsic, non-baseline point', () => {
    expect(
      toggleAdditionalPermission({
        role: 'user',
        additionalPermissions: [],
        permission: 'scripts:author',
        checked: true,
      }),
    ).toEqual(['scripts:author'])
    expect(
      toggleAdditionalPermission({
        role: 'user',
        additionalPermissions: [],
        permission: 'settings:write',
        checked: true,
      }),
    ).toEqual(['settings:write'])
  })

  test('role change, exact diff and critical summary preserve OCC revision', () => {
    const rebased = rebaseUserAdditionalPermissions({
      previousRole: 'user',
      nextRole: 'manager',
      additionalPermissions: ['scripts:author'],
    })
    expect(rebased).toEqual([])
    expect(
      rebaseUserAdditionalPermissions({
        previousRole: 'manager',
        nextRole: 'user',
        additionalPermissions: [],
      }),
    ).toEqual([])
    expect(
      diffUserAccess(
        { role: 'user', additionalPermissions: [], accessRevision: 7 },
        { role: 'user', additionalPermissions: ['scripts:author'] },
      ),
    ).toEqual({
      role: 'user',
      additionalPermissions: ['scripts:author'],
      expectedRevision: 7,
    })
    const summary = summarizeAccessChange(
      { role: 'user', additionalPermissions: [] },
      { role: 'user', additionalPermissions: ['scripts:author'] },
    )
    expect(summary.added).toEqual(['scripts:author'])
    expect(summary.addedCritical).toEqual(['scripts:author'])
  })
})
