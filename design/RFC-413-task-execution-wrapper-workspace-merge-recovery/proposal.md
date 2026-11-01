# RFC-413 task-execution wrapper 工作区、wrapper 运行账本与续跑前合并恢复迁入 engine（RFC-294 S6）

- **状态**：Done（2026-11-01；exact SHA `7f8abe5a0` 的 CI 全绿，见 plan「CI（AC-6）」）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「task-execution `composition/` 只剩装配」
- **前序**：[RFC-412](../RFC-412-task-execution-scheduler-residue/proposal.md)（`TaskMechanicsState` 只在 composition）
- **落位**：task-execution `engine/kernel/`（续跑前合并恢复、wrapper 隔离工作区的建立 / 重建与合回）、`engine/wrapper/`（wrapper 工作区端口
  实现、wrapper 运行账本）、`application/ports/`（端口）、`composition/`（只剩端口绑定）

## 1. 背景

RFC-402～412 之后，S6 退出门里只剩「task-execution `composition/` 只剩装配」与「协调器只在 bootstrap 构造」未核。后者在生产已成立
（RFC-386 / 387 的守卫：只有 bootstrap 与 `services/task.ts` 的测试专用装配构造协调器工厂）。前者仍有三块执行机制直接写在 composition 里、
直接读 `TaskMechanicsState`：

- `composition/executionMergeRecovery.ts`（390 行）：续跑前合并恢复——重放 `pending-merge` 行、补完被中断的合回、完成人工解决的冲突、
  收掉被同帧新一代取代的旧代，以及 wrapper 体内与 fanout 子行的同类补完（RFC-130 / 144 / 210 / 369 / 370）。
- `composition/wrapperMechanics.ts`（730 行）里的 wrapper 隔离工作区：`createOrRebuildWrapperIso`（建立 / 续跑重建 / 同行再入）、
  `mergeBackWrapperIso`（整体合回）、git wrapper 的基线与 preDirty 采集（RFC-098 B3 上限）和改动文件扣减；端口实现与场景表也在这里。
- `composition/wrapperRunLifecycle.ts`（248 行）：wrapper 运行账本——可续跑代的查找与再入、闭包捕获（RFC-354）、容器行铸造、park /
  终态结算与外部终态取代（RFC-230）。

它们是 ExecutionKernel 与 WrapperRuntime 两层的实现，不是装配。

## 2. 目标

- **G1 合并恢复迁入 kernel**：`executionMergeRecovery.ts` 的主体迁入 `engine/kernel/mergeRecovery.ts`，经 task-execution 自有端口执行。
- **G2 wrapper 隔离迁入 kernel**：`createOrRebuildWrapperIso` / `mergeBackWrapperIso` 迁入 `engine/kernel/wrapperIsolation.ts`，与 G1 共用同一组
  隔离机制端口。
- **G3 wrapper 工作区端口实现迁入 engine**：`WrapperWorkspacePort` 的实现（场景表、可 diff 仓、git 入口快照、改动文件扣减、合回）与 git
  基线 / preDirty 采集迁入 `engine/wrapper/wrapperWorkspace.ts`。
- **G4 wrapper 运行账本迁入 engine**：`createWrapperRunLedger` 迁入 `engine/wrapper/wrapperRunLedger.ts`，经持久化端口执行。
- **G5 composition 只剩绑定**：wrapper 端口工厂、恢复与账本的 composition 只构造端口、组装 nested 执行状态与转发；`executionMergeRecovery.ts`
  与 `wrapperRunLifecycle.ts` 删除。
- **G6 纯结构**：恢复的顺序与跳过条件、物理隔离键的推导与读取时机、写锁窗口、合并状态转移与日志文本、preDirty 上限与降级、闭包捕获与
  铸造字段、结算与取代语义全部不变。

## 3. 非目标

- composition 其余文件的「只剩装配」收口（数字员工执行核心、托管代理调用准备、动作执行运行器、provider 后台循环等，逐个核对后另立 RFC）。
- `services/task.ts` 测试专用协调器装配的退役（随 RFC-294 W4 E1）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：四块主体在 engine（kernel 两个、wrapper 两个），composition 的两个文件删除、`wrapperMechanics.ts` 只剩绑定（结构锁锁定，含负例）。
- **AC-2 端口**：kernel 新文件只 import 本模块 `domain/`、`application/ports/`、`engine/kernel/`、`platform/contracts/` 与 shared（RFC-402 规则）；
  wrapper 新文件不 import composition / infrastructure / `@/services`。
- **AC-3 行为不变**：wrapper（git / loop / fanout）、合并恢复、人工冲突、同行再入、续跑与 P0 变异 lane 的既有用例全部通过，断言意图不变。
- **AC-4 守卫**：按旧路径取语料的锁随 owner 改指；新结构锁带负例。
- **AC-5 账本**：counts / commons-debt / guard-manifest / Windows paths 按实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **恢复与 wrapper 隔离进 kernel**：两者只编排 kernel 已有的隔离 / 合回 / 清理原语（`createIsoUnderLock`、`mergeBackAndSettle`、
   `discardNodeIso` …），与 RFC-402 的 kernel 同层。
2. **场景表归 engine**：`WrapperWorkspaceScene` 的解析从 composition 移到 engine 的 wrapper 工作区；composition 的 scope driver 经它返回的
   解析函数取隔离句柄来组装 nested 执行状态（`TaskMechanicsState` 仍只在 composition）。
3. **infrastructure 能力经绑定进入**：子模块拓扑还原、人工冲突完成、句柄所在 scope、冲突解决、清理绑定等由 composition 绑定为端口。
4. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
