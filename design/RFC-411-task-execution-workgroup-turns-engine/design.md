# RFC-411 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`RC` = `S/modules/resource-catalog`，`T` = `packages/backend/tests`，
`WG` = `RC/application/workgroups`，`DRV` = `WG/workgroupTurnsDriver.ts`，`ADP` = `RC/infrastructure/workgroupTurnsOperations.ts`。行号以 RFC-410
落库后的源码为准，实施时按源码定位。形状沿用 RFC-405～410：主体原样迁移，只做落位与端口替换；装配在 composition。

## 1. 文件

| 来源 | 去向 | 说明 |
| --- | --- | --- |
| `DRV` 的类型与端口（`WorkgroupTurnTaskState` … `WorkgroupTurnsPersistencePort`、`WorkgroupClarifyAllowed*`，约 L88–L425） | `TE/application/ports/workgroupTurns.ts` | 适配器（infrastructure）与驱动（engine）共用；只依赖 shared 与本模块 public / ports 类型 |
| `DRV` 的两张转移表 `WORKGROUP_TURN_ASSIGNMENT_TRANSITIONS` / `WORKGROUP_TURN_GATE_TRANSITIONS` | `TE/domain/workgroup/turnTransitions.ts` | 纯数据，适配器的 CAS 校验与驱动共用 |
| `DRV` 其余（纯判定 `deriveWakeSet` / `decideWorkgroupOutcome` 等、提交与重试 helper、驱动循环 `createWorkgroupTurnsOperations`） | `TE/engine/task/workgroup/workgroupTurns.ts` | 原样迁入；import 改为本模块 ports / domain / shared |
| `WG/workgroupTurnPrompts.ts` | `TE/engine/task/workgroup/turnPrompts.ts` | 依赖快照类型，只被驱动使用 |
| `WG/workgroupProtocol.ts`、`WG/workgroupSystemMessages.ts`、`WG/workgroupTurnContext.ts` | `TE/domain/workgroup/{protocol,systemMessages,turnContext}.ts` | 只依赖 shared 的纯函数 |
| `WG/workgroupTurnContext.ts` 的 `resolveMessageTurnTriggerId` | `WG/workgroupRoomProjection.ts` | 唯一调用方是任务房投影（实施时核实，见 plan 实施记录） |
| `ADP` + `RC/infrastructure/workgroupCommitQueue.ts` | `TE/infrastructure/workgroupTurnsPersistence.ts`、`TE/infrastructure/workgroupCommitQueue.ts` | 写本模块的表；宿主账本参与者在本模块内直接构造；代理经 `AgentExecutionQueries.readMany` |
| `RC/composition/workgroupTurns.ts` | `TE/composition/workgroupTurns.ts` 的 `composeWorkgroupTurnsOperations(db, clarifyAskGate, collaboration)` | 组合 engine 与 infrastructure；bootstrap、测试拓扑改接 |
| `RC/application/ports/executionResourceQueries.ts` 的 `AgentExecutionQueries` | 增加 `readMany(agentIds)` | 与 `ADP` 现有的「一次 IN 查询 + `loadAgentPersistenceRows` 解码」相同；`createAgentExecutionQueries` 实现 |

`WG/workgroupRoomProjection.ts` 改从 shared 取节点常量；`WG` 下五个轮次文件、`ADP`、提交队列与
`RC/composition/workgroupTurns.ts` 删除。

## 2. 依赖规则

- `TE/engine/task/workgroup/` 只 import 本模块 `domain/`、`application/`、`engine/`、shared 与 node 内建模块（同 RFC-408 对 `engine/task/`）。
- `TE/domain/workgroup/` 只 import 本模块 `domain/` 与 shared。
- `TE/infrastructure/workgroupTurnsPersistence.ts` 只经 resource-catalog public 读代理；不 import resource-catalog 的 infrastructure。
- resource-catalog 不再 import task-execution 的轮次 / 宿主账本 SPI。

## 3. 必须保持

| 不变量 | 现有锁 / 用例 |
| --- | --- |
| 轮次推进、wake 集合、结局判定、零增量告警、fc / 批量分片、assignment 与 gate 的转移表 | RFC-164 / 215 / 229 等 workgroup 用例 |
| 提交在同一写事务内、冲突返回 `conflictOperationKey`、提交队列串行化、宿主账本铸造 / 盖章 / 失败与轮次写同一事务 | RFC-359 W4-D19c、RFC-369 用例 |
| 快照在同一读事务内取任务状态、消息、游标与成员代理 | 轮次持久化用例 |
| 提示词、协议块、系统消息的字节 | RFC-200 source lock、提示词用例 |
| 任务房投影的历史 / 当前 run / 预算语法 | 任务房用例 |

## 4. 守卫与账本

| 守卫 / 账本 | 处理 |
| --- | --- |
| `rfc294Gates.ts` 的 exact required SPI binding（`workgroup-turns-provider` 与 `workgroup-host-ledger-provider` 角色的 RC 条目） | 随文件删除销账 |
| 跨 context 内部文件对、RC 访问 TE 表的账本、commons-debt | 按实测销账，只降不升 |
| 按旧路径取语料的锁（RFC-200、RFC-359 W4-D19c、workgroup 相关源码锁等） | 改读新 owner；守卫文件在文件内读 owner |
| 读 `WG` / `ADP` 的用例（约 40 个） | 改 import 与构造，不改断言意图 |
| guard-manifest、Windows paths、`architectureReport.ts` | 按实测更新 |

## 5. 测试

- 新增结构锁 `T/architecture/rfc411-workgroup-turns-engine.test.ts`：驱动 / 端口 / 纯函数 / 适配器 / 装配 owner 唯一；RC 下被删文件不复活、
  不被引用；engine / domain / infrastructure 的 import 层级；RC 不再 import 轮次 SPI；每项带纯伪造输入的负例。
- 端口绑定用例 `T/rfc411-port-bindings.test.ts`：`composeWorkgroupTurnsOperations` 组合本模块适配器与驱动；`readMany` 与逐条 `read`
  解码一致（两 provider）。
- 搬迁涉及的既有用例只改 import、构造与源码锚点。
