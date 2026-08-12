# RFC-283 · 技术设计

状态：Done。语义以 `proposal.md` 的权限矩阵为准。

## 1. 角色权限

在 `MANAGER_EXTRA` 增加既有三个权限点：

```text
webhook-triggers:create
webhook-triggers:update
webhook-triggers:delete
```

`user` 基线不变，`admin` 仍包含完整权限集，
`webhook-endpoints:manage` 仍不进 manager 基线。

## 2. 后端 owner 边界

`packages/backend/src/routes/webhookTriggers.ts` 的 PUT、DELETE 和 streams/reset 继续共用
`requireWrite`，但判定从通用 resource-admin 改为 trigger 专用规则：

```text
owner ∨ admin
```

因此：

- admin 可管理任意规则；
- manager 只能管理 `ownerUserId === actor.user.id` 的规则；
- manager 对他人规则返回既有 404 同形错误；
- user 在路由 permission gate 返回 403。

POST 保留既有 `webhook-triggers:create + tasks:execute` 双权限门，并继续由服务端
强制 `ownerUserId = actor.user.id`。列表、详情与 fires 不增行过滤，保留全量只读语义。

## 3. 前端

`TriggersPanel` 从单一 `isAdmin` 开关改为当前 actor 权限与 row owner 判定：

- 新建：当前 actor 有 `webhook-triggers:create`（admin 保留全权兜底）；
- 开关、编辑、reset：admin，或本人 owner 且有 update；
- 删除：admin，或本人 owner 且有 delete；
- fires 查看：所有角色保留。

操作发出前仍从当前 `/api/auth/me` query 的 settled snapshot 重验 actor、permission 和
owner，防止降权后的旧 handler 继续发写请求。后端 owner 门是最终安全边界。

卡片使用 `useUserLookup` 批量解析 owner，复用 `OwnerLabel` 显示公开身份；未解析时
回退 owner id。当前用户是 owner 时再显示“我的规则”标记。

## 4. 回归保护

- shared：锁定 manager 三个 trigger 写权限和 endpoint 权限不变。
- backend：锁定 manager create/own update/reset/delete 正向，他人 404，user 403，admin 全局。
- frontend：锁定 manager 的“自己可操作、他人只读”，普通 user 只读，owner 标签和 fallback。
- 回归：端点 CRUD/Secret/URL token 轮换和 delivery replay 对 manager 仍为 403。
