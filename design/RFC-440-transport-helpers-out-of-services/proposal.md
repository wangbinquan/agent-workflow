# RFC-440 删除确认、删除快照与 token 读视图离开 services/（RFC-294 W4 B / D 第六步）

- **状态**：Done（2026-11-04；`452673a11`，exact SHA 主 CI run 41822844875 attempt 1 70/70 全绿）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、
  设计、实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D
- **前序**：[RFC-439](../RFC-439-code-capability-inbound-bindings/proposal.md)（代码能力的两个 HTTP 绑定归入 code-capability 模块）
- **落位**：platform 的 `platform/http`（删除确认、删除快照）；identity-access 的 `src/auth/`（token 读视图，与它依赖的
  `auth/application/tokenSnapshotRedaction.ts` 同处）。

## 1. 背景

RFC-439 之后入站适配器不再深引模块内部，B / D 退出门余下「不 import `services/`」：`routes/` 23 个文件与 `mcp/server.ts`。
其中最常见的三个依赖是 RFC-222 / RFC-247 留下的 HTTP 助手：

- `services/tokenAudit.ts`：
  - 删除前抓取行快照，响应后由 token 审计钩子取走（`captureDeleteSnapshot` / `takeDeleteSnapshot`）。
    引用方是 9 个路由、`server.ts`、`platform/operations/boundOperationInvoker.ts` 与 integration 的定时任务绑定；
  - 另有一层 token 调用审计的兼容转出（`recordTokenCall`、`pruneTokenAudit`、`pruneTokenAuditSlice` 与若干类型）。生产里已无调用方，
    只剩用例；它背后的 `auth/composition.ts` 里的 `legacyTokenCallAudit` 桥也只服务于它。
- `services/deleteConfirm.ts`：读取删除请求体，校验「输入名称确认删除」（RFC-222；token 通道的版本来自 RFC-247 T20）。
  引用方是 6 个路由、integration 的定时任务绑定与 resource-catalog 的技能操作。
- `services/tokenRedaction.ts`：token 通道的读视图（RFC-247 D9、RFC-270）。引用方是 4 个路由、`mcp/server.ts` 与 bootstrap。

RFC-294 的 legacy 归属表（`tests/architecture/architectureReport.ts`）已登记归宿：`deleteConfirm` 归 platform，`tokenAudit`、
`tokenRedaction` 归 identity-access。

这三个文件挡住两件事：

- skills、memories、workgroups、workflows、plugins 五个路由只因它们才 import `services/`；
- 模块与 platform 因它们反向依赖 legacy：integration 的入站绑定、resource-catalog 的 composition、platform 的 bound operation invoker。
  以后把 resource-catalog 的路由迁入模块时，这些依赖还会被带进去（RFC-438 的定时任务绑定就是这样把它们带进 integration 的）。

## 2. 目标

- **G1 删除确认与删除快照归 platform**：`platform/http/deleteConfirm.ts`（原样搬迁）、`platform/http/deleteSnapshot.ts`
  （`captureDeleteSnapshot` / `takeDeleteSnapshot`）。
- **G2 token 读视图归 identity-access**：`services/tokenRedaction.ts` 迁为 `src/auth/tokenRedaction.ts`，与
  `auth/application/tokenSnapshotRedaction.ts` 同处。
- **G3 删除无人用的兼容层**：`services/tokenAudit.ts` 的审计转出与 `legacyTokenCallAudit` 桥一起删除。生产早已改由 provider
  装配的 participant 调用，用例改用 `createTokenCallAudit(db)`。
- **G4 行为不变**：删除确认的顺序与错误码、PAT 删除快照的抓取与审计、token 通道的脱敏结果全部不变。
- **G5 不留 facade**：原 3 个文件删除，所有引用改到新位置。

## 3. 非目标

- 其余 18 个路由的 `services/` 依赖（按 context 随各子波收口）。
- `services/mcpSurface`、`services/apiDocs`：`routes/auth`、`routes/docs` 与 `mcp/server.ts` 的另一半依赖，归属待下一步一起定。
- `src/auth/` 整体并入 `modules/identity-access`。
- `routes/registry`、`routes/resourceAcl` 归位 platform。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：`services/tokenAudit.ts`、`services/deleteConfirm.ts`、`services/tokenRedaction.ts` 与 `legacyTokenCallAudit` 不再存在，
  源码里没有对这三个路径的 import。
  - `platform/http/deleteConfirm.ts`、`platform/http/deleteSnapshot.ts` 不 import 模块与 legacy 横向层；
  - `auth/tokenRedaction.ts` 不 import `services/`。
- **AC-2**：计数按实测更新，其余结构门不回退：
  - import `services/` 的路由 23 → 18；
  - platform 里 import `services/` 的文件 9 → 8，模块里 import `services/` 的文件 153 → 151；
  - `services/` 文件 232 → 229。
- **AC-3**：删除确认、PAT 删除的审计快照（REST 与 bound operation 两条路）、token 读视图与 token 调用审计的用例全部通过。
- **AC-4**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **删除快照归 platform，不归 identity-access**：
   - 它是挂在一次 HTTP 请求上的状态：删除句柄写入，响应后的审计钩子与 bound operation invoker 读出；
   - invoker 在 platform。快照若放进 identity-access，platform 就要反向依赖 identity-access；
   - PAT 判定（`actor.source !== 'pat'`）只是「只有 token 调用方付分配」的优化，留在函数里。
2. **token 读视图归 identity-access 的 `src/auth/`，不进 platform，也暂不进模块**：
   - 它决定「token 能看到什么」，属于 RFC-247 的 token 策略，归属表也是这样登记的；
   - 调用方是 legacy 路由、`mcp/server.ts` 与 bootstrap。放进 `modules/identity-access` 内部会新增 R1 边；签名带 `Actor` 与 `unknown`，
     也进不了 public。随 `src/auth/` 整体并入模块时一起处理。
3. **兼容层删除，不迁移**：`legacyTokenCallAudit` 的注释写明「root composition 可以逐个替换调用点」，生产已经替换完。
   留着它只会给后来者一条绕过装配的路。
4. **顺带修正夜跑 workflow 的路径过滤**（`.github/workflows/maintenance-soak-nightly.yml`）：
   - `services/tokenAudit.ts` 改为 token 审计的实际实现；
   - `services/webhook/**` 自 RFC-437 起已不存在（带通配符，不受「workflow 字面路径必须存在」守卫检查），改为 integration 的投递持久化。
