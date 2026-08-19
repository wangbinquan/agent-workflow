// RFC-312 —— 新建账号时的默认附加授权（唯一策略源）。
//
// 为什么 `users:presence` 不能直接放进角色 preset：RFC-305 的有效权限是 `role ∪ additional`
// 且**没有 deny 集**，写入侧对 baseline 里的点直接抛 `user-permission-redundant`
// （`shared/src/schemas/permission.ts` 的 normalizeAdditionalPermissionsForWrite）。
// 一旦进了静态 preset，管理员就**永远无法按账号收回**它。所以它走"默认授予的显式 grant"。
//
// admin 是例外且不需要处理：`ROLE_PERMISSIONS.admin = [...PERMISSIONS]` 是**动态全量** baseline，
// 天然吸收每一个新点。给 admin 插 grant 行只会被读路径判冗余丢弃，徒留噪声——所以这里返回空。

import type { Permission, Role } from '@agent-workflow/shared'

/**
 * 建号时默认写入的附加授权。**所有**建号入口共用它：
 * HTTP/CLI 的 createManagedUser、OIDC 自助建号、bootstrap 首管理员。
 *
 * 返回的数组同时驱动三件事：写入的 grant 行、审计的 addedPermissions、返回给调用方的视图——
 * 否则会出现"权限生效了但审计里查不到是谁给的"。
 */
export function initialGrantsForRole(role: Role): ReadonlyArray<Permission> {
  switch (role) {
    case 'user':
    case 'manager':
      // 默认能看到同事的在线状态；管理员可在权限面板逐账号收回。
      return ['users:presence']
    case 'guest':
      // guest 是 public-read-only 预设，"谁在线"不属于公开只读面。需要时显式授予。
      return []
    case 'admin':
      // 动态全量 baseline 已包含，插了也会被判冗余。
      return []
  }
}
