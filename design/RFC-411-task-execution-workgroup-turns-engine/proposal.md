# RFC-411 workgroup 轮次引擎迁入 task-execution（RFC-294 S6）

- **状态**：In Progress（2026-11-01 落档并开始实施）。用户 2026-10-30「你继续推进RFC294，……过程中按你的判断来推进，不用询问我」；2026-10-31「后面的工作你
  可以不用启动codex来做，你自己完成」：本会话调研、设计、实施与集中验证，不派 Codex；取舍由本会话按推荐决定（见 §6，可推翻）。纯结构重构，
  无用户可见变化。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §3 S6；design §5.2（「workgroup 引擎迁出 resource-catalog，归 task-execution」）
- **前序**：[RFC-410](../RFC-410-task-execution-dynamic-workflow-engine/proposal.md)（动态工作流生成引擎迁入 `engine/task/`）
- **落位**：task-execution `engine/task/workgroup/`（轮次驱动）、`domain/workgroup/`（协议块、系统消息、轮次上下文与提示词的纯函数）、
  `application/ports/`（轮次持久化端口与快照 / 账本操作类型）、`infrastructure/`（轮次持久化适配器与提交队列）、`composition/`（装配）；
  删除 resource-catalog 下的轮次驱动、适配器与装配文件

## 1. 背景

S6 的最后一个引擎仍在 resource-catalog：

- `modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts`（3,299 行）：轮次 / assignment 状态机与驱动循环
  （`createWorkgroupTurnsOperations`），连同 `workgroupTurnPrompts.ts`（264）、`workgroupProtocol.ts`（265）、`workgroupSystemMessages.ts`（92）、
  `workgroupTurnContext.ts`（343）。
- `modules/resource-catalog/infrastructure/workgroupTurnsOperations.ts`（593 行）+ `workgroupCommitQueue.ts`（23）：轮次持久化适配器，读写的
  `workgroup_task_state` / `workgroup_assignments` / `workgroup_messages` / `workgroup_member_cursors` 等表**由 task-execution 定义**
  （`modules/task-execution/infrastructure/persistence/schema.ts`），并在同一事务里调用 task-execution 的宿主账本参与者；成员代理直接读
  resource-catalog 的 `agents` 表。
- `modules/resource-catalog/composition/workgroupTurns.ts` 由 bootstrap 装配后交给 task-execution 的 `WorkgroupTaskEngine`；
  resource-catalog → task-execution public 的这些边登记为 exact required SPI binding（`workgroup-turns-provider` /
  `workgroup-host-ledger-provider` 角色，`tests/architecture/rfc294Gates.ts`）。
- resource-catalog 的工作组任务房（`workgroupRoomProjection.ts`）只从轮次文件取两个节点常量（本就来自 shared）与
  `resolveMessageTurnTriggerId`（纯函数）。

## 2. 目标

- **G1 驱动迁入 engine**：轮次驱动循环迁入 `engine/task/workgroup/`；轮次持久化端口与快照 / 账本操作类型进 `application/ports/`；
  纯判定与提示词 / 协议 / 系统消息 / 轮次上下文进 `domain/workgroup/`。
- **G2 适配器回到表的 owner**：轮次持久化适配器与提交队列迁入 task-execution `infrastructure/`，在 task-execution 自己的事务里写自己的表、
  调自己的宿主账本参与者；成员代理经 resource-catalog public 的 `AgentExecutionQueries` 在同一读事务内批量读取（最小扩展 `readMany`）。
- **G3 装配归位**：`composeWorkgroupTurnsOperations` 由 task-execution composition 提供，bootstrap 与测试拓扑改接；resource-catalog 的
  轮次装配、适配器与驱动文件删除，`workgroup-turns-provider` / `workgroup-host-ledger-provider` 两类 SPI binding 随之退役。
- **G4 任务房只取 shared 与自身**：`resolveMessageTurnTriggerId` 随唯一调用方并入任务房投影；节点常量直接从 shared 取。
- **G5 端口不新增跨层依赖**：不新增 R2 边或 off-DAG 文件边；跨 context 内部文件对、legacy → 模块内部的文件边只减不增。
- **G6 纯结构**：轮次推进、assignment 转移、提示词字节、提交 / 冲突 / 重试语义与事务边界不变。

## 3. 非目标

- 工作组任务房（确认 / 拒绝 / 另存为 / 房间查询与命令）的位置与行为；它对 task-execution 表的既有访问方式。
- 工作组模板与配置（resource-catalog 的 workgroup 资源）本身。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1 迁移**：轮次驱动、端口、纯函数与适配器全部在 task-execution，resource-catalog 下对应文件删除（结构锁锁定，含负例）。
- **AC-2 边界**：engine / domain 只 import 允许的层；resource-catalog 不再 import task-execution 的轮次 SPI；task-execution 读代理只经
  resource-catalog public。
- **AC-3 行为不变**：workgroup 轮次 / 批量 / fc / 房间 / 澄清 / 恢复的既有用例与 P0 变异 lane 全部通过，断言意图不变。
- **AC-4 守卫**：按旧路径取语料的锁随 owner 改指；SPI binding 与跨 context 账本按实测销账；新结构锁带负例。
- **AC-5 账本**：counts / commons-debt / guard-manifest / Windows paths 按实测更新，只降不升。
- **AC-6 CI**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **适配器随表归 task-execution**：表、宿主账本都属 task-execution，适配器留在 resource-catalog 才需要 SPI 绑定与跨 context 事务；迁过来
   后两类 SPI 角色退役。
2. **代理读取走 resource-catalog public，同一事务内**：`PersistenceTx` 与 `PersistenceDb` 同型，public 查询可直接以读事务句柄构造；新增的
   `readMany` 与现有逐条 `read` 同一套行解码，保持「一次 IN 查询 + 同事务快照」的现状。
3. **`resolveMessageTurnTriggerId` 随任务房投影留在 resource-catalog**：它只被任务房投影调用，避免 resource-catalog → task-execution 的反向边。
4. **偏离项**：落档时无；实施中接受的偏差记在 plan「实施记录」。
