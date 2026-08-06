# RFC-260 · Webhook 页面全员只读可见（admin 独占配置 + hook URL 对非 admin 脱敏）

- 状态：Draft（2026-08-06；两处可见性边界已经用户拍板，待实现批准）
- 作者：Claude
- 关联：RFC-257（webhook 基座 + UI 修订把整面收紧为 admin-only——本 RFC 把「读」重新放开）、RFC-259（GitHub adapter，端点卡现状）、RFC-247（权限点体系）

## 1. 背景

RFC-257 UI 修订将 webhook 配置整面收紧为 **admin-only**：侧栏项 `adminOnly` 过滤（`lib/nav.ts:70`）、页面级拒绝态（`routes/webhooks.tsx:57`）、五个权限点全部退出 user/manager 基线（`shared/schemas/permission.ts:73-75` 注释明言）。后果是非 admin 完全看不到 webhook 状态——「我的 push 为什么没触发」「事件到了没有」这类排障问题都得找管理员。

用户指示：**页面让所有人可见，只有 admin 可以配置；hook URL 对非 admin 加密（脱敏）**。

两处可见性边界已用户拍板（2026-08-06）：

| # | 决策 | 拍板 |
|---|---|---|
| D1 | 触发器可见范围 | **全部触发器只读**（推翻 owner 制读边界——规则本身不敏感，全量可见最利排障；写仍 owner∨resource-admin 且入口 admin-only） |
| D2 | 投递审计可见范围 | **列表 + 详情（含原始 payload body）全员可见**；replay 按钮仍 admin-only |

## 2. 目标

1. **读面全员开放**：/webhooks 三个 tab（端点 / 触发器 / 投递审计）对所有登录角色只读可见。
2. **写面 admin 独占（维持现状）**：端点 CRUD / 轮换、触发器 CRUD / 熔断重置、投递 replay——非 admin 前端不渲染按钮、后端方法门照旧拒绝。
3. **hook URL 对非 admin 做 API 级脱敏**：`urlToken` / `ingressUrl` 明文只出现在 **admin 的 session 请求**响应里；非 admin 与**一切 PAT/令牌请求**（含 admin 的 PAT）只拿到掩码提示（尾 4 位 hint，`secretHint` 同款姿势）。前端遮挡不算数——响应体里就不含明文。
4. 权限点新增 **1 个**：`webhook-endpoints:read`（矩阵 read 域，进 USER_BASELINE）；`webhook-triggers:read` 回归 USER_BASELINE。穷尽表 66。

## 3. 非目标

- 不恢复非 admin 的触发器**创建**（RFC-257 D19 的 owner 制写面继续存在于行级门，但矩阵写点不回基线——「只有 admin 可以配置」按用户原话执行）。
- 不改 secret 语义（已是一次性明文 + 掩码 hint）。
- 不改 `/webhooks/*` 入站面、分发语义、任何 RFC-257/259 的运行时行为。
- 不做「按仓库/按触发器的细粒度可见性」——D1 拍板全量只读。

## 4. 决策记录（推导）

| # | 决策 | 内容与理由 |
|---|---|---|
| D3 | 脱敏判定 = `role==='admin' ∧ source==='session'`（白名单） | URL token 是「寻址 + 弱凭据」（RFC-257 威胁模型）。RFC-257 D19 的立场是 ingress 面不上 token——读点开放后用**响应分层**继续兑现它：PAT 无论 owner 角色一律掩码，明文只走 admin 的交互 session（评审门 F-1：判定必须是 **source==='session' 白名单**——ActorSource 三值 'session'|'pat'|'daemon'（`auth/actor.ts:23`）没有 'token'，黑名单式恒真 fail-open；daemon 内部调用同样掩码）。掩码形态 = `urlToken: null` + 新字段 `urlTokenHint`（尾 4），`ingressUrl: null`（secretHint 先例，`schemas/webhook.ts:310-311`） |
| D4 | 端点/投递读面共用 `webhook-endpoints:read` | 投递是端点级审计（RFC-257 F-13），不另立 `webhook-deliveries` 资源域行；replay/写仍 `webhook-endpoints:manage`（system 域不动） |
| D5 | 触发器读面 = 方法门放行后**不再行级过滤** | `canView`（owner∨resource-admin，`routes/webhookTriggers.ts:35-37`）从**读路径**移除（列表全量、详情/fires 200）；**写路径的行级门保留原样**。原 AC-17「非 owner 详情 404 同形」被 D1 显式推翻——相关既有断言按新语义改并记档 |
| D6 | 前端按钮以 role 渲染，后端是真正边界 | 非 admin 隐藏全部配置动作（新建/编辑/删除/开关/轮换/replay/重置/复制 URL）；页面拒绝态删除、nav `adminOnly` 移除；空态文案分角色（非 admin 版不引导「新建」而是提示联系管理员） |

## 5. 能力影响清单

纯放开读面 + 响应分层，无既有能力收缩（不触发 CLAUDE.md 第 7 条门槛）。逐项如实呈报：

1. **非 admin/PAT 新增可读面**（评审门 F-4 逐项点名）：端点元数据（名称/provider/启停/掩码 hint/最近投递时间）；**全量触发器 wire 全字段**——除规则外含 `launchPayload`（owner 的启动模板全文）、`lastError`（启动失败原因，可能引用对该 viewer 不可见的 private workflow/agent 名）、`lastTaskId`、`ownerUserId`；**fires 行含逐条 `error` 列**；全量投递（含原始 payload body——push 的 commit 信息/评论原文）。事件与配置源于成员共同的代码平台，对内不构成秘密（D1/D2 拍板覆盖）。
2. **PAT 面变化**：现状 PAT 读端点/投递被 system 域挡死（`webhook-endpoints:manage` 永不上 token）；改后 PAT 经 `webhook-endpoints:read`（矩阵 read 域恒授）可读**掩码后的**端点与投递——ingress secret/URL 明文仍然拿不到（D3），与 D19 精神一致。
3. admin 的**交互 session** 行为不变（明文 URL、全部按钮）。

## 6. 验收标准（可证伪）

- AC-1 权限矩阵：user/manager GET 端点列表/详情 200 且响应 `urlToken===null`、`ingressUrl===null`、`urlTokenHint` 为尾 4、无任何 secret 明文；admin session GET 200 明文；**admin 的 PAT** GET 200 但掩码（D3 的 token 分支）。
- AC-2 写面不动：user/manager 对端点 POST/PUT/DELETE/rotate、投递 replay、触发器 create/update/delete/reset → 403（方法门），admin 全通。
- AC-3 触发器全量只读：user 能列出**他人 owner** 的触发器、GET 其详情与 fires 200（原 404 同形断言按 D5 改判并记档）；user 对他人触发器 PUT/DELETE 仍 403。
- AC-4 投递：user GET 列表与详情（含 body）200；replay 403。
- AC-5 前端：非 admin 渲染三 tab 只读（无新建/编辑/删除/轮换/开关/replay/重置/复制按钮）、URL 显示掩码（`••••` + hint）；admin 渲染与现状逐像素一致；nav 项对全员可见；role 分支 role/testid 断言双语。
- AC-6 权限穷尽表 65→66 与角色快照（USER_BASELINE 收编两读点、ADMIN_ONLY 负向集同步）棘轮全绿。
- AC-7 RFC-257/259 既有测试：除 D5 记档的 owner-404 断言与管理面读权限断言按新语义更新外，其余不改断言全绿。
