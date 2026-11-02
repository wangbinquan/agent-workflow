# RFC-418 task-execution provider 后台循环迁入 application（RFC-294 S6）

- **状态**：Done（2026-11-01 落档并实施；exact SHA `c91c711ac` 主 CI 70/70 与 windows-platform 全绿）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」
- **前序**：[RFC-417](../RFC-417-task-execution-hosted-run-execution-infrastructure/proposal.md)。对 RFC-416 proposal §7 的后继顺序作一处调整：
  原第 3 项（本 RFC）提前到第 2 项之前。理由是本地 agent 调用适配器需要先补 runtime-management 的 public 合同，而本 RFC 只在 task-execution 内部
  完成。
- **落位**：task-execution `application/`（循环与 provider 会话控制）、`application/ports/`（端口）、`composition/`（只剩把 legacy 清扫与配置源绑进端口）

## 1. 背景

`composition/providerBackground.ts`（399 行）是 provider 会话的后台控制，属于应用流程，不是装配。它包含：

- 可重启循环 `createRestartableLoop`：定时器、运行中去重、pause / resume / stop、空闲等待；
- 五条 provider 循环：
  - 自动修复；
  - 心跳超时击杀；
  - 孤儿对账：固定监督拍醒来，再按热生效的配置判定是否到期；
  - 定时任务；
  - 托管恢复；
- 启动时的配置选择与开机自动续跑（自动续跑 detached，但纳入排空边界）；
- 会话控制：串行化的 pause / resume / stop / close 与 `awaitIdle`。

这些流程只经端口与 legacy 清扫函数交互：`services/autoKill`、`orphanReconcile`、`scheduledTaskScheduler`、`daemonCadence`，以及
`util/process` 的进程树击杀。

## 2. 目标

- **G1 循环与会话控制迁入 application**：`isPeriodicReconcileDue`、可重启循环、五条循环与会话控制迁入 `application/providerBackground.ts`，经
  `application/ports/providerBackground.ts` 的端口执行：
  - 执行模块（pause / resume / dispose / awaitIdle / 停止票据）；
  - 节奏（四个 getter，按原文在每次布置定时器时读取）；
  - 文件配置源工厂；
  - 两个清扫：心跳击杀与孤儿对账；
  - 启动时交入的定时任务执行。
- **G2 composition 只剩绑定**：`composeTaskExecutionProviderBackground` 把 legacy 清扫、`DAEMON_CADENCE` / `SCHEDULE_TICK_MS`、文件配置源与
  `runDueSchedulesOnce` 绑进端口。对外名字与类型不变（`TaskExecutionProviderBackgroundControl` /
  `TaskExecutionProviderBackgroundStartDependencies`），`providerRuntime.ts` 与 bootstrap 不动。
- **G3 纯结构**：以下全部不变——循环名、节奏与读取时机、各循环的判定与清扫参数、自动续跑的 detached 语义与排空、pause / stop 的顺序、
  错误文本、串行化。

## 3. 非目标

- 把这些循环接入唯一生命周期程序（RFC-294 design §14「后台作业无私设 timer」）：本 RFC 只换落位，循环形状不变。
- 迁走 legacy 清扫函数本身（`services/autoKill` 等随各自 owner 归位）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：循环与会话控制位于 application，composition 不再声明它们（结构锁锁定，含负例）；application 新文件不 import infrastructure /
  composition，也不 import legacy `@/services`（RFC-317 R2 账本不变）。
- **AC-2 行为不变**：后台配置、孤儿对账热生效、provider 会话、可暂停写入者、告警解除的既有用例与 P0 变异 lane 全部通过，断言意图不变。
- **AC-3 守卫**：读 `providerBackground.ts` 源码的锁改读 application 文件，判据不变（孤儿对账的睡眠节奏改为断言 `cadence` 端口的监督拍 getter）；
  新结构锁带负例。
- **AC-4 账本**：guard-manifest 与 Windows paths 按实测更新。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **节奏以 getter 交入**：原文每次布置定时器时读 `DAEMON_CADENCE.x` / `SCHEDULE_TICK_MS`。端口用无参 getter 保持读取时机，不在构造时取值。
2. **定时任务执行在启动时绑定**：`runDueSchedulesOnce` 的参数（operations、identityAccess、onAutoDisable）只在 `start(dependencies)` 才到。
   composition 的 `start` 把它们与 `buildScheduleLaunch` / `SCHEDULE_MAX_IN_FLIGHT` 绑成 `scheduled.runDue({ maxFailures, defaultRuntime })`，
   再交给 application 的 `start`。配置源的选择顺序、`loadConfig` 兼容覆盖、「已启动 / 已停止」守卫的先后，原样留在 application。
3. **停止票据用泛型**：执行模块的票据类型定义在 infrastructure，application 端口以泛型 `TTicket extends { token: { taskId } }` 接收，不引入
   infrastructure 类型。
4. **清扫参数留在绑定**：心跳击杀的 `runHeartbeatKillOnce` 调用（含 `findStalledRunningChildren` 与进程树击杀的参数映射）与孤儿对账的
   `graceMs: 60_000` 原样写在绑定里。判定「是否开启 / 是否到期」以及 `occurredAt` 的取值留在 application。
