// RFC-312 —— 建号默认授权策略。
//
// 这条策略是"权限点可按账号收回"的全部根据：点不进静态 preset、靠建号时写一条显式 grant 发放。
// 因此策略本身必须与权限模型严丝合缝——给 admin 插 grant 会被读路径判冗余丢弃，
// 给 user/manager 漏插则功能直接失效（他们连不上 /ws/presence）。

import { describe, expect, test } from 'bun:test'
import {
  ROLE_PERMISSIONS,
  grantableAdditionalPermissions,
  type Permission,
} from '@agent-workflow/shared'

import { initialGrantsForRole } from '../src/modules/identity-access/domain/initialGrants'

const POINT = 'users:presence' as Permission

describe('rfc312 initial grants', () => {
  test('user / manager 默认拿到 users:presence', () => {
    expect(initialGrantsForRole('user')).toEqual([POINT])
    expect(initialGrantsForRole('manager')).toEqual([POINT])
  })

  test('guest 默认不给（public-read-only 预设不含"谁在线"）', () => {
    expect(initialGrantsForRole('guest')).toEqual([])
  })

  test('admin 默认不给——动态全量 baseline 已含，插了会被判冗余丢弃', () => {
    expect(initialGrantsForRole('admin')).toEqual([])
    expect(ROLE_PERMISSIONS.admin).toContain(POINT)
  })

  test('策略与权限模型自洽：默认发放的点必须是该角色可授予的', () => {
    for (const role of ['user', 'manager', 'guest', 'admin'] as const) {
      const grantable = new Set(grantableAdditionalPermissions(role))
      for (const p of initialGrantsForRole(role)) {
        // 否则写入侧会抛 user-permission-redundant / not-grantable，建号直接失败
        expect(grantable.has(p)).toBe(true)
      }
    }
  })
})
