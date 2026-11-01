# RFC-412 task-execution 提交推送尾链与只读巡检迁入 engine，删除 services/scheduler.ts（RFC-294 S6）

- **状态**：In Progress（2026-11-01 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31
  「后面的工作你可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。
  纯结构重构，无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6 退出门「`TaskMechanicsState` 只出现在装配」
- **前序**：[RFC-411](../RFC-411-task-execution-workgroup-turns-engine/proposal.md)（三类任务引擎全部在 `engine/task/`）
- **落位**：task-execution `engine/node/commit-push/`（自动提交推送）、`engine/task/`（只读成员巡检）、`application/ports/`（两者的端口）、
  `composition/`（端口绑定；`TaskMechanicsState` 迁入）；删除 `services/scheduler.ts`

## 1. 背景

`services/scheduler.ts`（403 行）是 task-execution 留在 legacy 层的最后一块执行机制：

- `maybeRunCommitPush(state, node, iteration, log)`：顶层节点完成后的自动提交推送（RFC-075 / W5）——为每个有改动的可写仓铸造提交节点 run、
  经任务 agent 运行族驱动提交信息 / 修复会话、调用 source-control legacy 的 `runCommitPush`；scope 解释器经 `ports.commitPush` 调用它。
- `inspectReadonlyRepos(state, log)`：任务终态收尾时检查只读成员是否被改动并记录（RFC-248）；任务控制面经端口调用它。
- `buildContainerMap`（shared `buildWorkflowScopeParentMap` 的别名）、`readCommitExcludePatterns`，以及给测试的兼容再导出。

两个主体都直接读 `TaskMechanicsState`（`services/execution/taskMechanicsState.ts`），这是 S6 退出门「`TaskMechanicsState` 只出现在装配」
唯一的 legacy 违例。

## 2. 目标

- **G1 提交推送迁入 engine**：`maybeRunCommitPush` 迁入 `engine/node/commit-push/`，经 task-execution 自有端口执行（任务事实、仓库、
  运行时绑定、node-run 铸造与运行族、提交推送效应、仓库工作区、取消信号、写锁、配置）。
- **G2 只读巡检迁入 engine**：`inspectReadonlyRepos` 迁入 `engine/task/`，经端口读仓库状态、写巡检记录。
- **G3 删除 scheduler**：`buildContainerMap` 调用方改用 shared 的 `buildWorkflowScopeParentMap`；`readCommitExcludePatterns` 进绑定；
  兼容再导出删除，测试改从 owner 取；`services/scheduler.ts` 删除。
- **G4 `TaskMechanicsState` 只在装配**：类型文件迁入 `composition/`，legacy 层不再出现。
- **G5 端口不新增跨层依赖**：source-control 的 legacy `commitPush` / `commitPushRunner` 经绑定交给端口，engine 不 import `@/services`；
  不新增 R2 边或 off-DAG 文件边。
- **G6 纯结构**：提交推送的逐仓顺序、只读跳过、取消边界、提交 run 的铸造与父子关系、提示词 / 修复次数 / diff 上限与排除配置、
  巡检记录与告警文本不变。

## 3. 非目标

- source-control 的 `services/commitPush.ts` / `commitPushRunner.ts` 归位（属 source-control 的波次）。
- `composition/` 其余文件的「只剩装配」收口（后续 RFC）。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：两个主体在 engine，`services/scheduler.ts` 删除，`TaskMechanicsState` 只在 `composition/`（结构锁锁定，含负例）。
- **AC-2 端口**：两个 engine 文件只 import 本模块各层与 shared；source-control legacy 只经绑定进入。
- **AC-3 行为不变**：自动提交推送 / 只读巡检 / 取消 / 恢复的既有用例与 P0 变异 lane 全部通过，断言意图不变。
- **AC-4 守卫**：按旧路径取语料的锁随 owner 改指；新结构锁带负例。
- **AC-5 账本**：counts / commons-debt / guard-manifest / Windows paths 按实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **提交推送落 `engine/node/commit-push/`**：它为每个仓铸造一个合成提交节点 run 并运行 agent，是节点执行器的形状；scope 解释器只经端口
   调用它。
2. **source-control legacy 经绑定进入**：`runCommitPush` 与提交 agent / 提示词构造器由 composition 绑定为端口能力，其归位留给 source-control
   的波次。
3. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
