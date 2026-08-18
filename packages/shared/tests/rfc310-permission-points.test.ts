// RFC-310 PR-1B —— 22 个新 permission 点的存在性与归属快照。
// （与 apply-permission-points.py 同批落进 packages/shared/tests/。）
//
// 锁三件事：①22 点全部存在于闭集 PERMISSIONS 且各有 catalog 条目；②角色
// 归属快照——五资源 read/create/update/archive 在 user 预设（guest 均无），
// assignments:update 在 manager 档；③:archive 点不落入 DELETE_POINTS 的
// explicit-tick 派生（它们没有 delete 语义）。

import { describe, expect, test } from 'bun:test'

import {
  DELETE_POINTS,
  PERMISSION_CATALOG,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type Permission,
} from '../src/schemas/permission'

const RESOURCES = [
  'action-templates',
  'verification-profiles',
  'digital-employees',
  'automation-policies',
  'adapter-definitions',
] as const

const RFC310_POINTS: Permission[] = [
  ...RESOURCES.flatMap((r) =>
    (['read', 'create', 'update', 'archive'] as const).map((v) => `${r}:${v}` as Permission),
  ),
  'repository-employee-assignments:read' as Permission,
  'repository-employee-assignments:update' as Permission,
]

describe('rfc310 permission points', () => {
  test('all 22 points exist in the closed catalog with entries', () => {
    expect(RFC310_POINTS).toHaveLength(22)
    for (const point of RFC310_POINTS) {
      expect(PERMISSIONS).toContain(point)
      expect(PERMISSION_CATALOG[point]).toBeDefined()
    }
  })

  test('role snapshot: user holds resource points, guest holds none, manager adds assignments:update', () => {
    const user = new Set(ROLE_PERMISSIONS.user)
    const manager = new Set(ROLE_PERMISSIONS.manager)
    const guest = new Set(ROLE_PERMISSIONS.guest)
    const admin = new Set(ROLE_PERMISSIONS.admin)
    for (const r of RESOURCES) {
      for (const v of ['read', 'create', 'update', 'archive'] as const) {
        const p = `${r}:${v}` as Permission
        expect(user.has(p)).toBe(true)
        expect(manager.has(p)).toBe(true)
        expect(admin.has(p)).toBe(true)
        expect(guest.has(p)).toBe(false)
      }
    }
    expect(user.has('repository-employee-assignments:read' as Permission)).toBe(true)
    expect(user.has('repository-employee-assignments:update' as Permission)).toBe(false)
    expect(manager.has('repository-employee-assignments:update' as Permission)).toBe(true)
    expect(guest.has('repository-employee-assignments:read' as Permission)).toBe(false)
  })

  test(':archive verbs stay out of DELETE_POINTS explicit-tick derivation', () => {
    for (const r of RESOURCES) {
      expect(DELETE_POINTS).not.toContain(`${r}:archive` as Permission)
    }
  })
})
