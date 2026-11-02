# RFC-424 退役 `services/task.ts` 的测试专用驱动入口：协调器只在 bootstrap 装配（RFC-294 S6）

- **状态**：In Progress（2026-11-02 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  只删测试专用代码、迁移测试，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「协调器只在 bootstrap 构造」
- **前序**：[RFC-386](../RFC-386-task-drive-coordinator-factory/proposal.md) /
  [RFC-387](../RFC-387-task-continuation-semantics/proposal.md) 把协调器构造收为 application 工厂、生产装配只在 bootstrap，并把
  `services/task.ts` 留下的几个入口登记为测试专用（源码注释「removed in W4」）；它们等的 W4-E1（[RFC-362](../RFC-362-task-source-control-launch-contracts/proposal.md)
  / [RFC-363](../RFC-363-task-source-control-launch-cutover/proposal.md)）已 Done。
- **落位**：`services/task.ts`（删除）、`tests/helpers/`（测试侧装配）、守卫（RFC-386 盘点锁与两条源码文本锁）。

## 1. 背景

`services/task.ts`（2,640 行）里仍有一组只给测试用的入口：

| 入口                                                                       | 作用                                                                | 使用方                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `composeTestTaskDriveFactory`                                              | 协调器工厂的第二个装配点（另一个在 bootstrap）                      | 下面三个入口；`legacyTaskDrive`、`productionTaskLaunch` 两个 helper |
| `wakeHumanGateContinuation`                                                | 用上面的工厂把人工门续跑意图交给协调器                              | 8 个用例                                                            |
| `resumeDynamicWorkflowExecution`，以及它背后 245 行的准入核心 `resumeKick` | 动态工作流确认后的「换 DAG + 续跑」，是生产确认命令之外的第二份实现 | 2 个用例                                                            |
| `retryRepositoryPreparation`                                               | 用测试工厂加持久化准备步骤，调生产的仓库准备重试命令                | `retryEngine` helper                                                |
| `selectResumeRollbackTargets`（单参数便利包装）                            | 包一层 application 的唯一实现                                       | 4 个用例                                                            |

于是：

- src 里协调器工厂有两个装配点，S6 退出门「协调器只在 bootstrap 构造」不成立；
- 两个动态工作流用例测的是 `resumeKick` 这份测试专用的准入实现，而不是生产的确认命令（resource-catalog 的
  `confirmDynamicWorkflow`）；
- 三条源码文本锁（RFC-386 盘点、RFC-103、RFC-332）按 `services/task.ts` 的形状计数，钉住的是测试装配而不是生产装配。

## 2. 目标

- **G1 删除**：`services/task.ts` 删去上表入口和只为它们存在的私有函数（约 650 行）。src 中协调器工厂只在 bootstrap 装配。随之失去最后
  一个生产消费者的代码一并离开生产树：resource-catalog 的 legacy 工作组状态模块（`infrastructure/legacy/workgroup/state.ts`，只经测试专用的
  动态工作流续跑准入可达）及其 `services/workgroup/state.ts` 再导出 facade；`composition/taskDriveLegacy.ts` 里只有这些入口用的再导出。
- **G2 测试侧装配**：
  - 测试用的协调器工厂装配与 `wakeHumanGateContinuation` 迁入 `tests/helpers/`；装配的仍是生产组件（application 工厂、task-execution
    与 collaboration 的 composition 入口），测试侧只负责接线；
  - 仓库准备重试由 `retryEngine` 直接用生产的重试命令与生产的延后仓库准备组合入口装配；
  - 单参数的回滚目标便利包装迁入测试 helper；
  - legacy 工作组状态模块原样迁入 `tests/helpers/legacyWorkgroupState.ts`，作为 10 个用例的夹具库。
- **G3 动态工作流用例走生产路径**：两个用例改用生产的 `confirmDynamicWorkflow`（经 `composeTestWorkgroupTaskRoom`），确认后的续跑由注入的
  `driveAfterCommit` 交给测试工厂；手工关 holder、手工换 DAG 的步骤删除，断言不变。
- **G4 锁**：
  - RFC-386 盘点锁的装配点只剩 bootstrap；退役入口在 src 中不得再声明（含负例）；
  - RFC-103 / RFC-332 两条源码文本锁把「配置单源 → 协调器」漏斗改钉在 bootstrap 装配上。
- **G5 行为不变**：生产代码只删除，不改任何保留函数的行为。

## 3. 非目标

- `services/task.ts` 中仍被生产使用的部分（延后仓库准备、工作流同步预览、内置快照排版、`getTask` 等）：属 W4-E1 余项与 `services/` 收缩，另立。
- `TaskContinuationDependencies` 中只剩测试在用的字段的收窄：随上一项另立。
- 入站适配器去 `services/` 化（W4 B / D）。
- `rfc217-workgroup-task-state` 等用例里专测 legacy 工作组状态副本（门状态机、CAS）的断言：生产那份在 task-execution 的
  `workgroupTurnsPersistence`。这些断言改测生产实现或删除，作为后继债务另立；本 RFC 只把夹具搬到测试侧、不改断言。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 删除**：`services/task.ts` 不再声明上表入口与 `resumeKick` 链；src 中 `createTaskDriveCoordinatorFactory` 的调用点只有 bootstrap
  （RFC-386 锁锁定，含负例）。
- **AC-2 测试迁移**：上述用例与 helper 全部改用 `tests/helpers/` 的装配或生产命令，断言意图不变；两个动态工作流用例经生产确认命令执行确认后的 DAG。
- **AC-3 行为不变**：人工门续跑、动态工作流确认与执行、仓库准备重试、resume 回滚目标、子任务启动等既有用例，以及 P0 变异 lane 全部通过。
- **AC-4 账本**：RFC-386 / RFC-103 / RFC-332 锁按新形状改写；其余按 `services/task.ts` 形状写的锁改钉生产实现；路径键账本只减不增
  （RFC-376 不可达文件与 export-star 基线不增）；guard-manifest 行数按实测刷新。
- **AC-5 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **测试装配迁入 `tests/helpers/`，不改用整套 bootstrap 应用**：这些用例要注入调度驱动、运行配置覆盖与等待模式，bootstrap 应用不提供这些注入面；
   `tests/helpers/taskDriveCoordinatorFactory.ts` 已有测试侧直接调用 application 工厂的先例。被装配的组件全部是生产实现。
2. **`resumeKick` 不搬进测试**：它是准入逻辑的第二份实现，搬过去仍是测试在验证一份非生产实现；两个用例改走生产确认命令。
3. **便利包装随入口一起走**：`selectResumeRollbackTargets` 的单参数包装在 src 中只剩 `resumeDynamicWorkflowExecution` 一个调用方，生产只用
   application 的唯一实现，包装迁入测试 helper。
