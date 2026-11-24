# RFC-558 integration 的 webhook 入站只认自己声明的事件中心窄端口（RFC-294 S9 第十三步）

- **状态**：In Progress（2026-11-23）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」
  （2026-11-09、2026-11-17 再次下达），2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」，2026-11-19「你加速推
  进RFC294」：本会话按 2026-11-09 刷新后的 RFC-294 总纲调研、设计、实施与集中验证，按授权记为已批准（取舍见 design §4，可推翻）；不派
  Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S9 第 5 项（跨 context 内部文件对）与 design §14
  “跨 context 内部文件对 → 0”；做法同 [RFC-553](../RFC-553-knowledge-evolution-task-initiator-port/proposal.md)（consumer 自有端口，bootstrap 用
  provider 交出的同一个对象绑定）。

## 1. 背景

integration 的 `composition/webhookIngress.ts` 装配 webhook 入站与投递重放时，从事件中心只用三件事：记一条观察（`commands.observe`）、跑一条
通知（`worker.runOneNotification`）、提示代码平台活动源（`observerControl.nudgeSource`）。参数类型却取的是 event-center `composition` 交出的整个
`EventCenterModule`——跨 context 内部文件对精确清单 7 条中的一条。integration → event-center 是目标 DAG 的 offered 边，`observe` 的合同与
`EventExactRef` 已在 event-center 的 public。

## 2. 目标

- **G1**：integration 在 `application/ports/webhookIngressEventCenter.ts` 声明 `WebhookIngressEventCenter`：只含这三个操作，类型取 event-center 的
  `public/participants` 与 `public/types`。
- **G2**：`webhookIngress.ts` 的两个装配函数改用它，不再取 event-center 的 composition；bootstrap 照旧交事件中心模块本身（结构上满足这个端口）。
- **G3**：跨 context 内部文件对 7 → 6；精确清单与减速带随之降低，其余计数不升。
- **G4 结局不变**：同一个对象、同三次调用，入站与重放的行为不变。

## 3. 非目标

- 其余 6 条跨 context 内部文件对（code-capability → resource-catalog 两条、integration → task-execution 的源终止能力两条、intent → resource-catalog
  两条）。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：integration 的生产文件取 event-center 非 public 文件的只剩指定 adapter（按类型取 required-ports）；webhook 入站的装配用
  `WebhookIngressEventCenter`。
- **AC-2**：行为不变；事件中心模块满足这个端口由编译器检查（新用例里的编译期断言与 bootstrap 的交接处）。
- **AC-3**：跨 context 内部文件对 7 → 6，精确清单与 `counts.json` 随之更新；新增 RFC-558 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
