# RFC-386 任务驱动协调器工厂：子任务启动与续跑共用会话的驱动设施（RFC-294 S2b）

- **状态**：In Progress（2026-10-21 落档并派发。用户 2026-10-20「按你推荐继续推进」：由本会话设计、交 Codex 实施并审核，免设计门与
  实现门；规则取舍由本会话按推荐决定，见 §6。RFC-385 提交（`f495e8e76`）且主 CI 全绿后派发）
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S2（S2b）；前置
  [RFC-382](../RFC-382-daemon-task-execution-bundle/proposal.md)（会话协调器与实时运行配置）、
  [RFC-385](../RFC-385-daemon-execution-generation/proposal.md)
- **基线**：HEAD `9382675a0` 的 task-execution 模块（研究基线；行号仅作定位提示，以实施时源码为准）
- **落位**：task-execution 的 `application/drive`（工厂与驱动画像）与 `domain`（按意图类型的工作区排除配置重建规则）；
  守护进程装配层（`cli/daemonModules/taskExecution.ts`）构造一次工厂

## 1. 背景

RFC-382 让每个会话只有一个任务驱动协调器与一个实时运行配置。但还有两类协调器在**每次调用时现建**，配置与会话协调器不同
（2026-10-21 只读研究）：

- **子任务启动**（`TE/infrastructure/childExecutionLaunchOperations.ts:380-425`，两个 provider，每个调用节点一次）：运行配置是父任务
  可继承键的快照（`pickInheritableRunConfig`，`services/scheduler.ts`），不重读设置。于是**子任务的内建提交 / 合并 Agent 用缺省的模型、
  运行时、语言、修复重试与 diff 上限，子任务的 Agent 运行也不做执行结束的记忆提炼**。RFC-284 T20 与 RFC-366 的说明都写明「子任务
  launch 路径从设置重新解析、照样提炼」（`tests/rfc284-t20-child-inheritance.test.ts:21-25`、`:112-117`），实际没有做到。失败原因名
  `postgresql-child-launch` 两个 provider 都在用。
- **续跑**（`TE/infrastructure/childTaskLifecycleParticipant.ts:1129-1191`，两个 provider，每次根续跑与子任务续跑）：根续跑取会话的实时
  配置，子任务续跑取父快照（同上缺口）；带一个续跑回滚的前置步骤（真正按次不同的部分）；强制重建工作区排除配置。

另有一处 provider 差异：

- **门控续跑不重建工作区排除配置（PostgreSQL）**：SQLite 的人工门续跑强制重建（`services/task.ts:3139`），PostgreSQL 的门控续跑走会话
  协调器，从不设置该标志。RFC-308 要求续跑与续写都重新确认排除配置（`design/RFC-308-unified-task-git-commit-exclusions/design.md:240`、
  `:725`）。**后果（PostgreSQL）**：评审打回 / 拒绝、澄清回答、房间确认之后，若上一轮 Agent 改动了排除配置，平台路径可能出现在
  `git status` 与 diff 端口里。

## 2. 目标

- **G1 协调器工厂**：task-execution 应用层提供一个工厂，给出会话协调器 `session` 与按「驱动画像」派生的协调器 `coordinatorFor(profile)`；
  所有派生协调器共用会话的生命周期端口、门控续跑前置步骤、延后仓库准备、失败上报与实时运行配置。会话组合只构造一次工厂。
- **G2 子任务启动与续跑改经工厂**：子任务启动、根续跑、子任务续跑不再自建协调器。
- **G3 子任务沿用会话运行配置**：派生协调器的运行配置 = 实时会话配置，再叠加父任务的可继承键；子任务因此遵守设置并做记忆提炼。
- **G4 工作区排除配置按意图类型重建**：由协调器按认领到的执行意图类型决定是否重建，去掉各调用点的标志；补上 PostgreSQL 门控续跑。
- **G5 失败上报统一**：一个上报器，按画像给出失败摘要与原因名，**总是按认领世代终结意图**；原因名去掉 provider 字样。

## 3. 非目标

- 人工门唤醒、房间续跑、仓库准备重试、融合适配器（含其不按世代终结意图的上报）、驱动释放收尾、删除 `createTaskDriveCoordinator`：RFC-387。
- 两个 provider 运行时函数合一：RFC-388。SQLite HTTP 装配并入中立挂载表、删除测试回退：RFC-389。
- 不改 API、事件、schema；不做任何安全相关改动。

## 4. 用户可见变化

两个 provider：

1. **子任务遵守设置**：调用节点 / 动态工作流产生的子任务，其内建提交与合并 Agent 使用设置页的模型、运行时、语言、修复重试与 diff 上限
   （此前用缺省值）；子任务的 Agent 运行按现行提炼策略做执行结束的记忆提炼（策略关闭则无变化）。子任务是否提交、推送仍由工作流
   决定，本 RFC 不改。
2. **子任务启动 / 续跑失败只终结自己的意图**：按认领世代终结，不波及同一任务的其他意图。

PostgreSQL：

3. **门控续跑后重建工作区排除配置**：评审打回 / 拒绝、澄清回答、房间确认之后，平台路径不再出现在 `git status` 与 diff 端口里（同 SQLite）。

## 5. 验收标准

- **AC-1 工厂唯一**：除 RFC-387 将删除的 `createTaskDriveCoordinator` 外，后端只有工厂内一处 `new DefaultTaskDriveCoordinator(`（结构锁）；
  会话组合只构造一次工厂。
- **AC-2 行为**：§4 每一条都有双引擎回归与「旧接线」对照用例（design §5）。
- **AC-3 旧锁与账本**：受影响的旧锁改指新位置，不放宽断言意图；RFC-284 T20 的处置表与说明随实现更新；`architecture/counts.json` 不升。
- **AC-4 CI 全绿**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **画像而不是多个工厂函数**：`coordinatorFor({ runConfig?, admittedContinuation?, failure?, engine? })`；不给画像即会话协调器。
2. **子任务配置 = 实时会话配置 + 父任务可继承键**：与 RFC-284 T20、RFC-366 写明的意图一致；父任务的可继承键（例如执行世代、
   排除模式等登记在 `INHERITABLE_RUN_CONFIG_KEYS` 的键）仍覆盖会话值。
3. **重建规则放在 domain**：续跑、重试节点、同步工作流、门控续跑、恢复类意图重建；启动与仓库准备重试不重建（它们的工作区总是新建）。
4. **一个上报器、总按世代**：原因名改为中立（例如 `child-launch`、`task-resume`）。
5. **融合与旧的每次调用协调器留给 RFC-387**：本 RFC 只把子任务启动与续跑改经工厂。
6. **偏离项**：无。工厂落在 task-execution `application/drive`，装配在 `cli/daemonModules/taskExecution.ts`（同 RFC-382，S2c 迁入 `bootstrap/`）。
