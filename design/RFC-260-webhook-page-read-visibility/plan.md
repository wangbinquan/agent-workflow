# RFC-260 · 任务分解

单 RFC 单 PR（主干直推）。T1 → T2 →（T3 ∥ T4）→ T5。

## T1 — 权限层
- permission.ts：+`webhook-endpoints:read`（matrix read 段）、USER_BASELINE 收编两读点、`:73-75` 注释改写；穷尽表/角色快照棘轮同步（65→66）。

## T2 — 后端读面
- webhook.ts wire：`urlToken` nullable + `urlTokenHint`。
- webhookEndpoints.ts：读路由 manage→read；`toWire` viewer 分层（`role==='admin' ∧ source==='session'` 白名单，`auth/actor.ts:23`；写路由响应同走 `ingressUrlFor`——评审门 F-1/F-3）。
- webhookDeliveries.ts：list/detail manage→read（replay 不动）。
- webhookTriggers.ts：读路径删 canView 过滤（写路径 requireWrite 保留）。
- 新 `rfc260-webhook-read-visibility.test.ts`（AC-1..4 矩阵，含 admin-PAT 掩码格）；rfc257-webhook-management.test.ts 按 D5 更新断言并逐条记档。

## T3 — 前端
- nav 去 adminOnly；webhooks.tsx 删拒绝态；三面板 role 分支（按钮隐藏 / URL 掩码 / Switch→StatusChip / 空态文案）；i18n zh 双段+en。
- 新 `rfc260-webhook-readonly-view.test.tsx`（AC-5）。

## T4 — 契约与守卫
- wire 形状锁在 shared `WebhookEndpointSchema`（契约注册表只登记 method/path，评审门 F-7 改判）；route/overlay inventory 如涉及；i18n key-resolution 自查。

## T5 — 门禁与收口
- 四门禁（按路径归属）；STATE.md / design/plan.md 登记；对抗评审门；提交推送按 SHA 查 CI。

## 验收清单
- [ ] AC-1 脱敏矩阵（T2）
- [ ] AC-2 写面 403（T2）
- [ ] AC-3 触发器全量只读 + D5 记档（T2）
- [ ] AC-4 投递读/replay（T2）
- [ ] AC-5 前端 role 分支（T3）
- [ ] AC-6 穷尽表 66（T1）
- [ ] AC-7 既有套件（T5）
