-- RFC-312 —— 给存量 user / manager 补一条 `users:presence` 显式 grant。
--
-- 为什么是 grant 而不是把点加进角色 preset：RFC-305 的有效权限是 `role ∪ additional`
-- 且**没有 deny 集**，写入侧对 baseline 里的点直接抛 `user-permission-redundant`
-- （shared/src/schemas/permission.ts 的 normalizeAdditionalPermissionsForWrite）。
-- 一旦进了静态 preset，管理员就**永远无法按账号收回**它——而"可收回"正是这条权限的产品要求。
--
-- 为什么跳过 admin：`ROLE_PERMISSIONS.admin = [...PERMISSIONS]` 是**动态全量** baseline，
-- 天然吸收每一个新点。给 admin 插 grant 只会被读路径 normalizeStoredAdditionalPermissions
-- 判为冗余并丢弃，徒留噪声行。
--
-- 为什么跳过 guest：guest 是 public-read-only 预设，"谁在线"不属于公开只读面；
-- 需要时由管理员显式授予（它对 guest 仍是可授予的）。
--
-- granted_by_user_id = NULL 表示**系统默认授予**，与"某个管理员点的"在归属上可区分——
-- 这是审计能回答"这权限是谁给的"的依据。
--
-- 幂等：INSERT OR IGNORE + (user_id, permission) 主键，重复应用不产生第二行。
-- 新建用户不依赖本迁移：三条建号路径（createManagedUser / OIDC 自助建号 / bootstrap）
-- 共用 initialGrantsForRole 策略，在建号那一刻就写入。
INSERT OR IGNORE INTO `user_permission_grants` (`user_id`, `permission`, `granted_by_user_id`, `granted_at`)
SELECT `id`, 'users:presence', NULL, CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `users`
WHERE `role` IN ('user', 'manager')
  AND `id` <> '__system__';
