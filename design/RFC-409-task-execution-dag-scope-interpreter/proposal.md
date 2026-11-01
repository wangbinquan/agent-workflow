# RFC-409 task-execution DAG scope 解释器迁入 engine/scope（RFC-294 S6）

- **状态**：Done（2026-11-01；AC-6 以后继 CI 证据关闭，见 plan「CI（AC-6）」）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你
  可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，
  无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6；design §5.2（scope 解释器层）
- **前序**：[RFC-408](../RFC-408-task-execution-task-control-plane/proposal.md)（任务控制面迁入 `engine/task/`，DAG 结构图迁入 `engine/scope/`）
- **落位**：task-execution `engine/scope/`（scope 解释器与 frontier 判定）、`domain/`（wrapper 定义图的纯函数）、`application/ports`（scope 端口）、
  `composition/`（端口绑定）；删除 `services/dispatchFrontier.ts`

## 1. 背景

design §5.2 把「DAG scope、frontier、loop / git / fanout 策略；wrapper 回到 scope 的递归」放在 `engine/scope/` 与 `engine/wrapper/`。现状：

- `runScope`（`composition/taskDagScope.ts`，405 行）是 completion-driven 的 scope 循环：每拍重读 node_runs、派生 frontier、派发、等完成、
  判定 scope 结局；读 `TaskMechanicsState`，并直接调 `composition/nodeExecution.ts` 的 `executeNode` 与 `services/scheduler.ts` 的
  `maybeRunCommitPush`。
- `deriveFrontier`（`composition/dagFrontier.ts`，516 行）已是纯函数（只收选择端口与数据），但放在 composition。
- 两者依赖的 frontier 判定在 `services/dispatchFrontier.ts`（460 行）：`isDispatchable`、`wrapperRevivalEvidence`、`decideScopeOutcome` 等，
  只 import task-execution 的 public/queries 与 shared，是放错层的 task-execution 逻辑；其中 `wrapperInnerDescendants` 还被
  `services/runLiveness.ts` 使用，`wrapperExternalUpstreamSources` 被 `composition/wrapperRunLifecycle.ts` 使用。

## 2. 目标

- **G1 scope 解释器迁入 engine**：`runScope` 迁入 `engine/scope/runScope.ts`，经 task-execution 自有端口执行（节点执行、提交推送、
  persistence 读写、协作读取）；`deriveFrontier` 迁入 `engine/scope/dagFrontier.ts`。
- **G2 frontier 判定归位**：`services/dispatchFrontier.ts` 删除——依赖读取的判定（`isDispatchable`、`wrapperRevivalEvidence`、
  `wrapperHasFreshInnerWork`、`decideScopeOutcome` 等）迁入 `engine/scope/`；只读定义的纯函数（`wrapperInnerDescendants`、
  `wrapperExternalUpstreamSources`）迁入 `domain/`，`services/runLiveness.ts` 经 task-execution `public/queries` 取用（只读集合）。
- **G3 递归保持**：wrapper 回到 scope 的递归（`state.driveScope`）仍是正式语义，绑定为嵌套状态构造端口后调 `runScope`。
- **G4 端口不新增跨层依赖**：不新增 R2 边或 off-DAG 文件边；legacy → 模块内部的文件边只减不增。
- **G5 纯结构**：frontier 派生、派发顺序、提交推送尾链、park / handoff / 结局判定的顺序与文本不变。

## 3. 非目标

- loop / git / fanout 策略本身（已在 `engine/wrapper/`）；wrapper composition 的 data / workspace 绑定。
- workgroup 轮次、动态工作流引擎迁入 task-execution（后续 RFC）。
- `TaskMechanicsState` 的拆分；协调器构造点。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：`runScope` / `deriveFrontier` 与 frontier 判定在 `engine/scope/`，wrapper 定义图纯函数在 `domain/`，只 import 允许的层；
  `services/dispatchFrontier.ts` 删除（结构锁锁定，含负例）。
- **AC-2 端口**：scope 端口不 import `services/`、infrastructure 或其他 context。
- **AC-3 行为不变**：frontier / scope / wrapper / 恢复 / 人工门的既有用例与 P0 变异 lane 全部通过，断言意图不变。
- **AC-4 守卫**：按旧路径取语料的锁随 owner 改指；新结构锁带负例。
- **AC-5 账本**：counts / commons-debt / guard-manifest / Windows paths 按实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **frontier 判定进 `engine/scope/`、定义图纯函数进 `domain/`**：前者读运行历史、属于 scope 解释器；后者只读工作流定义，legacy 调用方经
   public/queries 取用。
2. **递归经绑定**：`state.driveScope` 在 composition 为嵌套状态构造 scope 端口，engine 不接触 `TaskMechanicsState`。
3. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
