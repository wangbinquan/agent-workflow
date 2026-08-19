// RFC-312 —— `users:presence` 权限点的契约锁。
//
// 这条点的发放模型是设计门第二轮 finding N1/F2 的直接产物，措辞很容易写错，故逐条锁死：
//
//   RFC-305 的有效权限是 `role ∪ additional` 且**没有 deny 集**，写入侧对 baseline 里的点直接抛
//   `user-permission-redundant`。所以一旦把这个点放进任何**静态** preset，它就**永远无法按账号收回**。
//   本 RFC 因此让它不进 user/manager/guest 的静态 preset，走「新建默认授予的显式 grant + 存量 backfill」；
//   而 admin 是 `[...PERMISSIONS]` 的**动态**全量 baseline，天然包含它——那一档不需要也无法单独收回。
//
// 措辞陷阱（六轮 V6-1 实证）：写成"不在任何预设里"是**错的**，admin 那一格当场推翻它。

import { describe, expect, test } from 'bun:test'

import {
  PERMISSIONS,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  SYSTEM_DOMAIN_POINTS,
  grantableAdditionalPermissions,
  resolveTokenPermissions,
  type Permission,
} from '../src/schemas/permission'

const POINT = 'users:presence' as Permission

describe('rfc312 users:presence permission point', () => {
  test('在闭集里且有 catalog 条目', () => {
    expect(PERMISSIONS).toContain(POINT)
    expect(PERMISSION_CATALOG[POINT]).toBeDefined()
    expect(PERMISSION_CATALOG[POINT].group).toBe('platform')
  })

  test('系统域点：PAT 永不持有', () => {
    expect(PERMISSION_CATALOG[POINT].token).toBe('never')
    expect(SYSTEM_DOMAIN_POINTS).toContain(POINT)
    // 即便账号持有、且用户把它勾进 matrix，token 解析也必须把它剔掉
    const tokenPerms = resolveTokenPermissions({
      accountPermissions: new Set<Permission>([POINT]),
      matrix: [POINT],
    })
    expect(tokenPerms.has(POINT)).toBe(false)
  })

  test('静态 preset：user / manager / guest 都不含它', () => {
    expect(ROLE_PERMISSIONS.user).not.toContain(POINT)
    expect(ROLE_PERMISSIONS.manager).not.toContain(POINT)
    expect(ROLE_PERMISSIONS.guest).not.toContain(POINT)
  })

  test('admin 由动态全量 baseline 自动包含（不是被单独加进去的）', () => {
    expect(ROLE_PERMISSIONS.admin).toContain(POINT)
    // 判据：admin 的 baseline 就是整个闭集——所以任何新点都会被它吸收
    expect(new Set(ROLE_PERMISSIONS.admin).size).toBe(new Set(PERMISSIONS).size)
  })

  test('可授予性：user / manager / guest 可授予（因而可收回）；admin 不可（已在 baseline）', () => {
    expect(grantableAdditionalPermissions('user')).toContain(POINT)
    expect(grantableAdditionalPermissions('manager')).toContain(POINT)
    expect(grantableAdditionalPermissions('guest')).toContain(POINT)
    expect(grantableAdditionalPermissions('admin')).not.toContain(POINT)
  })
})
