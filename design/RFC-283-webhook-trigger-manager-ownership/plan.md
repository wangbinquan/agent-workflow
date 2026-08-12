# RFC-283 · 任务分解

状态：Done（2026-08-12）。

## A — 权限与后端

- [x] A1 将 trigger create/update/delete 加入 manager 角色基线。
- [x] A2 将 trigger 写围栏收窄为 owner ∨ admin。
- [x] A3 保留 manager/user 全量只读和 admin 全局管理。
- [x] A4 确认 endpoint manage 与 delivery replay 仍 admin-only。

## B — 前端

- [x] B1 触发规则动作改为 permission × owner 显隐。
- [x] B2 manager 可新建，自己的卡片可编辑/启停/删除/reset，他人卡片只读。
- [x] B3 卡片新增 owner 归属与“我的规则”标记。
- [x] B4 owner 公开身份查询失败时回退 owner id。

## C — 验证

- [x] C1 shared permission 定向测试：28/28。
- [x] C2 backend Webhook 权限/owner 定向测试：5/5。
- [x] C3 frontend Webhook 角色视图定向测试：13/13。
- [x] C4 shared/backend/frontend typecheck 通过。
- [x] C5 相关文件 ESLint 与 Prettier 通过。
