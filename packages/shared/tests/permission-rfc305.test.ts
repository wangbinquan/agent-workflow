import { describe, expect, test } from 'bun:test'
import {
  AdditionalPermissionValidationError,
  INTRINSIC_PERMISSIONS,
  PERMISSION_CATALOG,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  additionalPermissionsForRole,
  grantableAdditionalPermissions,
  grantableMatrixPoints,
  normalizeAdditionalPermissionsForWrite,
  normalizeStoredAdditionalPermissions,
  resolveEffectiveAccountPermissions,
  resolveTokenPermissions,
  type Permission,
} from '../src/schemas/permission'

describe('RFC-305 exhaustive permission catalog', () => {
  test('is a frozen exact map over every Permission', () => {
    expect(Object.keys(PERMISSION_CATALOG).sort()).toEqual([...PERMISSIONS].sort())
    expect(Object.isFrozen(PERMISSION_CATALOG)).toBe(true)
    for (const permission of PERMISSIONS) {
      const entry = PERMISSION_CATALOG[permission]
      expect(entry.permission).toBe(permission)
      expect(entry.labelKey).toBe(`permissions.catalog.${permission.replaceAll(':', '_')}.label`)
      expect(entry.descriptionKey).toBe(
        `permissions.catalog.${permission.replaceAll(':', '_')}.description`,
      )
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.constraints)).toBe(true)
    }
  })

  test('pins one intrinsic point and makes every preset difference grantable', () => {
    expect(INTRINSIC_PERMISSIONS).toEqual(['account:self'])
    expect(grantableAdditionalPermissions('user')).toEqual([
      'tasks:read:all',
      // RFC-304 — the three DEPARTMENT-layer writes. Individually grantable to
      // a user account like every other preset difference; the point is that
      // they are not in the user PRESET, not that they are unreachable.
      'capability-frameworks:create',
      'webhook-triggers:create',
      'repos:create',
      'capability-frameworks:update',
      'webhook-triggers:update',
      'repos:update',
      'capability-frameworks:delete',
      'webhook-triggers:delete',
      'repos:delete',
      'tasks:delete',
      'repos:execute',
      'users:read',
      'users:write',
      'settings:read',
      'settings:write',
      'oidc:read',
      'oidc:configure',
      'backup:run',
      'scripts:author',
      'code-host-calls:author',
      'webhook-endpoints:manage',
      'resource-acl:bypass',
      'memory-distill-jobs:manage',
      'intent:audit',
      'mcp-runtime-tests:audit',
      'webhook-triggers:override-owner',
    ])
    expect(grantableAdditionalPermissions('admin')).toEqual([])
    // RFC-304 +8: a guest holds neither template layer, so all eight points
    // are differences it can be granted individually.
    expect(grantableAdditionalPermissions('guest')).toHaveLength(74)
    expect(grantableAdditionalPermissions('guest')).toContain('resource-acl:private')
    expect(grantableAdditionalPermissions('guest')).toContain('tasks:execute')
  })

  test('historical identity bypasses are ordinary catalog permissions', () => {
    for (const permission of [
      'resource-acl:bypass',
      'memory-distill-jobs:manage',
      'intent:audit',
      'mcp-runtime-tests:audit',
      'webhook-triggers:override-owner',
    ] as const) {
      expect(PERMISSIONS).toContain(permission)
      expect(PERMISSION_CATALOG[permission].delegation).toBe('account-additive')
      expect(PERMISSION_CATALOG[permission].token).toBe('never')
    }
  })
})

describe('RFC-305 canonical additional grants', () => {
  test('strict writes reject unknown, duplicate, intrinsic and redundant input', () => {
    const cases: Array<{
      values: unknown[]
      code: AdditionalPermissionValidationError['code']
    }> = [
      { values: ['future:permission'], code: 'user-permission-invalid' },
      { values: ['scripts:author', 'scripts:author'], code: 'user-permission-duplicate' },
      { values: ['account:self'], code: 'user-permission-not-grantable' },
      { values: ['agents:read'], code: 'user-permission-redundant' },
    ]

    for (const item of cases) {
      try {
        normalizeAdditionalPermissionsForWrite({ role: 'user', additionalPermissions: item.values })
        throw new Error('expected strict normalization to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(AdditionalPermissionValidationError)
        expect((error as AdditionalPermissionValidationError).code).toBe(item.code)
      }
    }
    expect(
      normalizeAdditionalPermissionsForWrite({
        role: 'user',
        additionalPermissions: ['settings:write', 'resource-acl:bypass'],
      }),
    ).toEqual(['settings:write', 'resource-acl:bypass'])
  })

  test('stored corruption fails closed and produces diagnostics', () => {
    const result = normalizeStoredAdditionalPermissions({
      role: 'user',
      additionalPermissions: [
        'scripts:author',
        'scripts:author',
        'settings:write',
        'account:self',
        'agents:read',
        'retired:point',
      ],
    })
    expect(result.additionalPermissions).toEqual(['settings:write', 'scripts:author'])
    expect(result.diagnostics.map((diagnostic) => diagnostic.code).sort()).toEqual(
      [
        'user-permission-duplicate',
        'user-permission-not-grantable',
        'user-permission-redundant',
        'user-permission-invalid',
      ].sort(),
    )
  })

  test('effective authority is exactly role baseline union canonical grants', () => {
    const effective = resolveEffectiveAccountPermissions({
      role: 'user',
      additionalPermissions: ['scripts:author', 'repos:update'],
    })
    expect(effective.size).toBe(ROLE_PERMISSIONS.user.length + 2)
    expect(effective.has('scripts:author')).toBe(true)
    expect(effective.has('repos:update')).toBe(true)
    expect(effective.has('settings:write')).toBe(false)
  })

  test('a user preset plus every selectable grant equals the admin preset exactly', () => {
    const effective = resolveEffectiveAccountPermissions({
      role: 'user',
      additionalPermissions: grantableAdditionalPermissions('user'),
    })
    expect(effective).toEqual(new Set(ROLE_PERMISSIONS.admin))
  })

  test('a guest remains a preset and can be upgraded permission-by-permission without a role branch', () => {
    const effective = resolveEffectiveAccountPermissions({
      role: 'guest',
      additionalPermissions: grantableAdditionalPermissions('guest'),
    })
    expect(effective).toEqual(new Set(ROLE_PERMISSIONS.admin))
    expect(
      normalizeAdditionalPermissionsForWrite({
        role: 'guest',
        additionalPermissions: ['resource-acl:private'],
      }),
    ).toEqual(['resource-acl:private'])
  })

  test('role rebasing removes redundancy and never resurrects an unselected point', () => {
    const userEffective = resolveEffectiveAccountPermissions({
      role: 'user',
      additionalPermissions: ['scripts:author', 'repos:update'],
    })
    expect(additionalPermissionsForRole('manager', userEffective)).toEqual([])

    const managerWithoutScript = new Set<Permission>(
      ROLE_PERMISSIONS.manager.filter((permission) => permission !== 'scripts:author'),
    )
    expect(additionalPermissionsForRole('user', managerWithoutScript)).not.toContain(
      'scripts:author',
    )
  })
})

describe('RFC-305 PAT account cap', () => {
  test('a matrix grant becomes available only while the account grant exists', () => {
    const before = resolveEffectiveAccountPermissions({ role: 'user', additionalPermissions: [] })
    const after = resolveEffectiveAccountPermissions({
      role: 'user',
      additionalPermissions: ['repos:update'],
    })
    expect(grantableMatrixPoints(before)).not.toContain('repos:update')
    expect(grantableMatrixPoints(after)).toContain('repos:update')
    expect(
      resolveTokenPermissions({ accountPermissions: after, matrix: ['repos:update'] }).has(
        'repos:update',
      ),
    ).toBe(true)
    expect(
      resolveTokenPermissions({ accountPermissions: before, matrix: ['repos:update'] }).has(
        'repos:update',
      ),
    ).toBe(false)
  })

  test('account-range follows the account immediately and system points remain stripped', () => {
    const formerIdentityCapabilities = [
      'resource-acl:bypass',
      'memory-distill-jobs:manage',
      'intent:audit',
      'mcp-runtime-tests:audit',
      'webhook-triggers:override-owner',
    ] as const
    const effective = resolveEffectiveAccountPermissions({
      role: 'user',
      additionalPermissions: ['tasks:read:all', 'scripts:author', ...formerIdentityCapabilities],
    })
    const token = resolveTokenPermissions({
      accountPermissions: effective,
      matrix: [...PERMISSIONS],
    })
    expect(token.has('tasks:read:all')).toBe(true)
    expect(token.has('scripts:author')).toBe(false)
    for (const permission of formerIdentityCapabilities) {
      expect(token.has(permission)).toBe(false)
    }
  })

  test('private-resource range follows a guest account but is never selectable in the PAT matrix', () => {
    const publicOnly = resolveEffectiveAccountPermissions({
      role: 'guest',
      additionalPermissions: [],
    })
    const privateGranted = resolveEffectiveAccountPermissions({
      role: 'guest',
      additionalPermissions: ['resource-acl:private'],
    })
    expect(
      resolveTokenPermissions({ accountPermissions: publicOnly, matrix: [...PERMISSIONS] }).has(
        'resource-acl:private',
      ),
    ).toBe(false)
    expect(
      resolveTokenPermissions({
        accountPermissions: privateGranted,
        matrix: [],
      }).has('resource-acl:private'),
    ).toBe(true)
    expect(grantableMatrixPoints(privateGranted)).not.toContain('resource-acl:private')
  })
})
