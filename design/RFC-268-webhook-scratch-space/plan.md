# RFC-268 · 实施计划

> 状态：In Progress（2026-08-07 用户已批准；明确跳过外部设计门）

## 1. 依赖与边界

- 复用 RFC-165 的 scratch schema、物化、diff、保留与 GC。
- 复用 RFC-257 的 trigger schema、保存期彩排、dispatcher、匹配/熔断/supersede 与 UI 四步向导。
- 复用 RFC-243 的 `assertScheduledTargetUsable` + `startExecution` 唯一启动收口。
- 不新增 migration、fire outcome、权限点、路由或外部依赖。
- 不改 Webhook 事件归一化、模板变量集或 provider adapter。

## 2. 任务分解

| 任务   | 内容                                                                                                               | 验收                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **T1** | RFC 三件套、`design/plan.md` 索引、`STATE.md` In Progress 条目；记录用户批准与设计门豁免                            | 文档自洽、链接可解析；实施授权可追溯                     |
| **T2** | shared Webhook 三模板增加 canonical `scratch:true` 与 remote-only cross-field guard；更新注释与 schema 测试        | AC-1、AC-2、AC-4；旧 fixtures 深等值不变                |
| **T3** | 保存门接入 effective `autoRegisterRepos`；create/update 完整候选验证；launch-config 条件 CAS 防并发 partial update | AC-3；并发 barrier 测试最终行永远是联合校验过的一代配置 |
| **T4** | `WebhookLaunchSpace` + 三形态共同渲染；scratch 在 repo resolver 前分流；matched snapshot 同源                      | AC-5、AC-6、AC-8、AC-9                                  |
| **T5** | backend 真实启动矩阵与生命周期回归：三 kind scratch、空 root/no remote、supersede/circuit、非法行 defense in depth | AC-7、AC-10；事件仓旧套件零改判                         |
| **T6** | `TriggersPanel` Draft/序列化、目标步骤 ChoiceCards、复核/只读 chip、auto-register 条件显示、zh-CN/en-US            | AC-11…13；请求 body 精确锁                              |
| **T7** | Webhook E2E、1536/390 light/dark 真浏览器验收；更新 `docs/webhook-triggers.md` 与 RFC-257 历史注记                 | AC-14；截图与文档不提前于实现                           |
| **T8** | 定向门禁、完整 `bun run gate:local`、Codex 实现门、findings 闭环、RFC/STATE 状态收口                               | 全 AC 可复跑；零未登记红项；不擅自 commit/push          |

## 3. 预计文件范围

### Shared

- `packages/shared/src/schemas/webhook.ts`
- 既有 Webhook schema 测试或 `packages/shared/tests/rfc268-webhook-scratch-space.test.ts`（新）

### Backend

- `packages/backend/src/services/webhook/triggerValidation.ts`
- `packages/backend/src/services/webhook/webhookDispatch.ts`
- `packages/backend/src/routes/webhookTriggers.ts`
- Webhook route/dispatch 测试与 `packages/backend/tests/rfc268-webhook-scratch-space.test.ts`（新）

### Frontend

- `packages/frontend/src/components/webhooks/TriggersPanel.tsx`
- `packages/frontend/src/i18n/zh-CN.ts`
- `packages/frontend/src/i18n/en-US.ts`
- `packages/frontend/tests/rfc268-webhook-scratch-space.test.tsx`（新）
- 只有真实 390px 验收证明公共布局不足时才改 `packages/frontend/src/styles.css`

### E2E / docs

- Webhook 既有 e2e spec 或独立 RFC-268 spec
- `docs/webhook-triggers.md`
- `design/RFC-257-code-host-webhook-triggers/proposal.md`
- `design/RFC-257-code-host-webhook-triggers/design.md`
- 本 RFC 三件套、`design/plan.md`、`STATE.md`

明确不改：DB migrations/journal、provider adapter、事件变量 schema、任务 scratch 物化实现（除非测试证出既有 RFC-165 契约缺陷；届时先回报并重新定界）。

## 4. 实施顺序与提交边界

1. **契约批**：T2–T3，先让所有写入形状可验证且并发安全。
2. **运行批**：T4–T5，证明 resolver 真绕过、三种目标真落 scratch。
3. **产品批**：T6–T7，UI、i18n、E2E、运维文档与视觉证据。
4. **收口批**：T8，完整门禁与对抗复核后再将 RFC 标 Done。

共享 `main` 上只按上述精确路径 stage；不卷入 RFC-267 或其他会话的未提交改动。是否 commit / push 由用户另行授权，本计划不把本地实现等同于上库。

## 5. 完成定义

- proposal AC-1…14 全部有独立 oracle 的自动化或真浏览器证据；
- scratch fire 对 repo resolver 的调用数为 0，不以“最后 payload 没 repo 字段”替代此证明；
- 三种 launch kind 都创建真实 `spaceKind='scratch'` 任务；
- 旧事件仓触发器默认、clone/cache、ref 与 skipped outcome 回归全绿；
- create/update/并发 PUT 无法持久化混代或非法 launch config；
- 只读用户也能识别空间模式，390px 与桌面无交互/布局退化；
- 文档明确空仓、分支元数据、无 remote/auto-push、外部副作用不回滚与旧版本 fail-closed；
- `bun run gate:local` 全绿，Codex 实现门 findings 全部核实并闭环；
- 工作树保留他人 WIP，不擅自提交或推送。

## 6. 2026-08-07 实施与验证记录

- T2–T7 已落地：shared 双空间契约、create/update 完整候选与 CAS、dispatcher
  resolver 前分流、三种目标真实 scratch 物化、UI/i18n/运维文档均已完成。
- 定向自动化全绿：shared `19/19`；backend management `11/11`、dispatch
  `19/19`、真实 scratch launch `1/1`；frontend 三文件 `17/17`。管理 API 另锁
  `scratch + workingBranch/autoCommitPush(true|false)` 的 PUT 必须返回 422，不能
  让服务层裸 `ZodError` 漏成 500。
- 应用内浏览器真测：1536×960 与 390×844、light/dark；执行空间 ChoiceCards、
  复核 notice、列表 chip、保存 round-trip 与移动端内部滚动均符合预期，document
  `scrollWidth === clientWidth`。
- 为隔离共享树 RFC-269 WIP，从 HEAD 建立仅含 RFC-268 精确文件集的临时副本：
  三包 typecheck、lint、format、depcheck、shared `1787/1787` 均通过；非沙箱 backend
  四分片 `9147 pass / 43 skip / 0 fail`。frontend 首轮全量 `6085/6085` 通过；第二
  轮在 backend 并发高负载时，未改动的 `prose-code-mermaid-theme.test.tsx` 有一条
  5 秒观察器超时（`6084/6085`），单文件复核 `3/3` 通过。按仓规不把“重跑就过”
  当作完整门禁全绿。
- 共享 `main` 的当前 typecheck 仍被并行 RFC-269 未完成的 `code-host-call` 穷尽分支
  挡住；外部实现门也未在私有源码不可安全披露的边界下运行。故 T8 与 Done 状态
  暂不关闭；以上限制不改写为 RFC-268 功能失败，也不擅自修补/提交 RFC-269。
