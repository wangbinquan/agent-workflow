# RFC-260 · 技术设计

状态：Draft。读法：proposal 的 D1–D6 定语义，本篇是接线点。改动小而横切：1 个新权限点 + 2 条基线收编 + 端点 wire 脱敏分层 + 触发器读路径去行级过滤 + 前端 role 分支。

## 1. 权限层（`packages/shared/src/schemas/permission.ts`）

```
PERMISSIONS（65→66）：matrix read 段新增 'webhook-endpoints:read'
  （注意与 system 域的 'webhook-endpoints:manage' 并存：read 管「看元数据/投递」，
   manage 管「secret/URL 明文之外的写与轮换」——manage 不动，仍在 SYSTEM_DOMAIN_POINTS）
USER_BASELINE 收编：'webhook-triggers:read' + 'webhook-endpoints:read'
  （写动词 webhook-triggers:{create,update,delete} 不回基线——admin-only 维持）
派生自动变化：ADMIN_ONLY_PERMISSIONS（= PERMISSIONS − USER_BASELINE）自动排除这两点；
  token 面：矩阵 read 域「always granted to a token」⇒ PAT 恒带两读点（D3 靠响应分层兜）
```

`permission.ts:73-75` 的「五点全部 admin-only」注释改写为本 RFC 的读/写分层说明。

## 2. 端点读面脱敏（D3）

### 2.1 wire schema（`packages/shared/src/schemas/webhook.ts`）

```
WebhookEndpointSchema:
  urlToken: z.string().nullable()        // null = 对该 viewer 脱敏
  urlTokenHint: z.string().nullable()    // 新增：尾 4 位（secretHint 同款）；明文可见时也带（前端统一渲染）
（其余字段不动；CreateWebhookEndpoint/Update 不动）
```

### 2.2 路由（`packages/backend/src/routes/webhookEndpoints.ts`）

- GET list / GET :id：`permissions: ['webhook-endpoints:read']`（原 manage）。
- `toWire(row, unsealHint, viewer)` 增 viewer 分层：`revealUrl = viewer.role==='admin' && viewer.source==='session'`（白名单——`auth/actor.ts:23` ActorSource = 'session'|'pat'|'daemon'，无 'token' 值；黑名单式 `!=='token'` 恒真 fail-open，评审门 F-1）。`revealUrl===false ⇒ urlToken:null, ingressUrl:null`；`urlTokenHint = urlToken.slice(-4)` 恒给。
- 写路由（POST / PUT / DELETE / rotate-secret / rotate-url-token）：`webhook-endpoints:manage` 不动；**响应同样走 `ingressUrlFor` 分层**（评审门 F-3：daemon 凭据可过 manage 门——tokenAccess:'never' 只挡 PAT——直调 `ingressUrlOf` 会产出「urlToken 脱敏 + ingressUrl 明文」的自相矛盾响应）。admin session 的写响应仍明文。
- 一次性 secret 响应（创建/轮换）不受影响（本就 admin session 才可达）。

### 2.3 投递（`packages/backend/src/routes/webhookDeliveries.ts`）

- GET list / GET :id：`manage` → `webhook-endpoints:read`（D4；详情含 body，D2 拍板全员可见）。
- POST :id/replay：`manage` 不动。

## 3. 触发器读路径（D5，`packages/backend/src/routes/webhookTriggers.ts`）

- GET list：删 `rows.filter((r) => canView(actor, r))`（`:155`）——全量返回。
- GET :id / GET :id/fires：删读路径的 canView→404 分支——200。
- `requireWrite`（`:39-44`，owner∨resource-admin）**保留**：PUT/DELETE/streams-reset 的行级门不动（矩阵写点不在非 admin 基线，方法门先挡；行级门是纵深）。
- `canView` 若只剩写路径消费，收敛进 `requireWrite` 内联并删导出面（避免「读语义已死的函数」留存误导）。

## 4. 前端

- `lib/nav.ts:70`：去 `adminOnly`。
- `routes/webhooks.tsx`：删拒绝态分支（`:57-67`）；`isAdmin = actor.data?.user.role === 'admin'` 下传三面板（或各面板自取 `useActor`——以现有面板内是否已用 useActor 定，避免双源）。
- `WebhookEndpointCard.tsx`：
  - 非 admin：隐藏 新建/轮换/删除/启用 Switch（Switch 改只读 StatusChip 呈现）；URL 行显示 `••••{urlTokenHint}` 形态与「仅管理员可见完整 URL」hint，无复制按钮；`noPublicBaseUrl` 分支的 `{{path}}` 拼接改用掩码（urlToken 为 null 时显示 hint 形态）。
  - admin：与现状逐像素一致（AC-5 的对照断言）。
- `TriggersPanel.tsx`：非 admin 隐藏 新建/编辑/删除/重置；列表行与 FiresDialog（查看性质）保留。
- `DeliveriesPanel.tsx`：非 admin 隐藏 replay 按钮；列表/详情照常。
- 空态：非 admin 文案「尚未配置，请联系管理员」（新 i18n 键，zh 双段 + en，dev-gotchas i18n 纪律）。

## 5. 测试策略

- **权限矩阵集成**（新 `rfc260-webhook-read-visibility.test.ts`）：AC-1..4 逐格——user/manager/admin-session/admin-PAT × 端点读（脱敏形态逐字段）/端点写/触发器全量读（含他人 owner 行）/触发器写/投递读（含 body）/replay。
- **穷尽表棘轮**：`permission.test.ts`（PERMISSIONS.length 66、USER_BASELINE/manager/admin 快照、ADMIN_ONLY 负向集）。
- **既有断言更新（记档，AC-7）**：`rfc257-webhook-management.test.ts` 的 owner-404 同形断言 → 200 只读（D5）；deliveries/endpoints 读权限断言 manage → read。逐条列在 PR 描述。
- **前端**：`rfc260-webhook-readonly-view.test.tsx`——两 role 渲染分支（按钮存在性 role/testid 断言、URL 掩码文本、空态文案）；既有 rfc257/259 前端测试以 admin actor 跑（mock useActor）不改断言。
- **wire 契约**：形状锁在 shared `WebhookEndpointSchema`（评审门 F-7：`tests/contracts/registry.ts` 只登记 method/path，不含响应形状——初稿「契约注册表同步」系虚指，已改判）。

## 6. 耦合点

| 模块 | 改动 |
|---|---|
| shared permission.ts | +1 点、基线收编、注释改写 |
| shared schemas/webhook.ts | WebhookEndpointSchema 两字段 |
| routes/webhookEndpoints.ts | 读路由权限 + toWire viewer 分层 |
| routes/webhookDeliveries.ts | 读路由权限 |
| routes/webhookTriggers.ts | 读路径去行级过滤 |
| frontend nav/webhooks/三面板 + i18n | role 分支 |
| tests | 新 2 文件 + 穷尽表/契约/既有断言按 D5 更新 |

入站面 / dispatch / adapter / 迁移：**零改动**。
