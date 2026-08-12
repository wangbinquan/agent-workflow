# RFC-283 · Webhook 触发规则下放 manager 与 owner 写权限

- 状态：Done（2026-08-12；用户批准后实现）
- 作者：Codex
- 关联：RFC-257（Webhook 触发器）、RFC-260（全员只读）、RFC-222（manager 角色）

## 1. 需求

Webhook 触发规则已经持久化 `owner_user_id`，但当前写操作只对 admin 开放，
界面也没有显示规则归属。本次只做三件事：

1. manager 可新增触发规则；
2. manager 可编辑、启停、删除、重置自己的规则，但不能操作别人的规则；
3. 每张规则卡片显示归属，本人规则额外标记“我的规则”。

Webhook 接收端点、Secret/URL token 轮换和投递重放不下放，仍仅 admin 可操作。

## 2. 权限矩阵

| 动作                  | admin    | manager      | user     |
| --------------------- | -------- | ------------ | -------- |
| 列表、详情、fires     | 查看全部 | 查看全部     | 查看全部 |
| 新增规则              | 可以     | 可以         | 不可以   |
| 编辑、启停、重置      | 任意规则 | 仅自己的规则 | 不可以   |
| 删除规则              | 任意规则 | 仅自己的规则 | 不可以   |
| 管理接收端点/重放投递 | 可以     | 不可以       | 不可以   |

触发规则的行级写判定为：

```text
row.ownerUserId === actor.user.id || actor.user.role === 'admin'
```

manager 对他人规则的直接写请求继续返回 `404 webhook-trigger-not-found`，避免向写方
额外暴露行存在性。

## 3. 范围

- 复用既有 `webhook-triggers:create/update/delete` 权限点，不增新角色或平行开关。
- 创建时仍由后端把当前用户写入 `ownerUserId`，且仍要求 `tasks:execute`。
- 不改触发匹配、任务启动、熊断或删除 API 契约。
- 不扩展 Webhook 端点权限，不改敏感值脱敏规则。
- 不在本次扩展 PAT 矩阵或 MCP resource surface。

## 4. 验收

- manager session 拥有 trigger create/update/delete，仍没有 endpoint manage。
- manager 创建的规则 owner 是自己；对自己的 update/reset/delete 成功。
- manager 对他人规则的 update/reset/delete 全部 404；user 写操作全部 403。
- admin 保留跨 owner 管理能力。
- manager/user 仍能查看全部规则。
- 卡片显示 owner 公开身份，查询失败时回退 owner id；本人显示“我的规则”。
- manager 只在自己的卡片上看到开关、编辑、删除和 reset；他人卡片只读。
