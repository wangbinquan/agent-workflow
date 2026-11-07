# RFC-461 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`TE/` = `S/modules/task-execution/`，`ME/` = `S/modules/memory/`，
`RM/` = `S/modules/runtime-management/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：application 层不取 `services/` 与传输层（`ws/`）。本 RFC 把三处 WS 推送收进各自模块已有形状的端口（推送的
  实现留在 infrastructure），三处类型借道改取 owner 的出口。
- 不新增模块之间的边：task-execution 与 memory 各自只动自己的端口与 infrastructure；memory 的类型改取它已经在用的 task-execution 合同。

## 1. 端口

### 1.1 task-execution：agent 运行的节点状态 ping

- `TE/application/ports/taskAgentMaterial.ts` 的 `TaskAgentRunPurpose` 加 `readonly status: NodeStatusEvents`（取自同目录
  `nodeExecutionSupport.ts`，签名 `broadcastNodeStatus(taskId, nodeRunId, nodeId, status)`）。
- `TE/application/taskAgentRun.ts` 的三处 `taskBroadcaster.broadcast(TASK_CHANNEL(opts.taskId), { id: -1, type: 'node.status', … status:
'running' })` 改为 `purpose.status.broadcastNodeStatus(opts.taskId, opts.nodeRunId, opts.nodeId, 'running')`；
  `TE/infrastructure/nodeStatusEvents.ts` 的实现发出的正是同一条消息（同频道、同字段、`id: -1`）。三处的时机原样：行确已 running 之后、
  父行节流广播、活子会话轮询的回调。删去 `@/ws/broadcaster` 的 import。
- 端口包的构造处接 `{ broadcastNodeStatus }`：`TE/infrastructure/local/nativeTaskAgentRun.ts`、`TE/infrastructure/local/taskAgentRunFamily.ts`、
  `TE/infrastructure/crewstation/taskAgentRunScope.ts`；用例里手工构造端口包的 rfc370 各组同样接上（行为与生产一致）。

### 1.2 memory：蒸馏工作的 WS 通知

- `ME/application/ports/distillWorkStore.ts` 新增

  ```ts
  export interface MemoryDistillEvents {
    memory(message: MemoryWsMessage): void
    distillJob(message: MemoryDistillJobWsMessage): void
  }
  ```

  （两个消息类型都在 shared），`MemoryDistillWorkStore` 加 `readonly events: MemoryDistillEvents`。

- `ME/application/distill/memoryDistiller.ts` 的候选创建推送改为 `store.events.memory({ type: 'memory.candidate.created', … })`（载荷原样，
  仍紧跟 `store.insertCandidate`）；`ME/application/distill/schedule.ts` 的私有 `publish(msg)` 改为 `publish(store, msg)`，五处调用传入手边的
  工作存储（`enqueueDistillJob` / `retryFailedJob` 的 `store`、`distillTick` 的 `options.store`）。两个文件删去 `@/ws/broadcaster` 的 import。
- `ME/infrastructure/memoryDistillWorkStore.ts` 的 `DrizzleMemoryDistillWorkStore` 实现 `events`：`memoryBroadcaster.broadcast(MEMORY_CHANNEL, …)`
  与 `memoryDistillJobBroadcaster.broadcast(MEMORY_DISTILL_JOB_CHANNEL, …)`——就是原来 application 里的两行。

## 2. 类型取 owner 的出口

| 文件                                         | 原取处                                                                 | 改取                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RM/application/ports/agentSessionEvents.ts` | `services/runtime/types` 的 `NormalizedEventKind`                      | 同目录 `agentObservations.ts`（定义处；`services/runtime/types` 原是再导出它）                                                                       |
| `ME/application/ports/distillWorkStore.ts`   | `services/sessionEventSink` 的 `SystemAgentEventSinkV1`                | runtime-management `public/participants`（该文件已取 runtime-management 的 public，不新增文件对）                                                    |
| `ME/application/distill/memoryDistiller.ts`  | `services/runtime/types` 的 `RuntimeKind`、`SystemAgentOutputEvidence` | 本地类型别名：`SystemAgentRunFamily['run']` 请求的 `protocol`、`PreparedSystemAgentRunResult['outputEvidence']`（memory 已取的 task-execution 合同） |

## 3. 用例与锁

- **新用例** `T/rfc461-application-ws-push-through-ports.test.ts`：`taskAgentRun`、memory 蒸馏与调度不再取 `@/ws/broadcaster`，三个类型
  文件不再取 `services/runtime/types` / `services/sessionEventSink`（census AST）；memory 的 application 层零取 `@/services/` 与 `@/ws/`；
  `taskAgentRun` 的三处 ping 都经 `purpose.status`；infrastructure 的工作存储 `events` 发到原频道、载荷原样（订阅两个 broadcaster 断言）；
  task-execution `nodeStatusEvents` 发出的消息与原来的字面量相同。
- `commons-debt.json` 的 `R2` 6 条按实测销账；guard-manifest 按需刷新行数。

## 4. 留下的债

- 余下 11 条 `R2` 与 memory infrastructure 取 `services/sessionEventSink` 的两处，随运行时驱动一族（proposal §3）。

## 5. 失败模式

- 构造端口包漏接 `status` / 工作存储漏实现 `events`：tsc 兜底（两者都是必填成员）。
- 消息漂移：新用例订阅 broadcaster 断言频道与载荷；既有的 WS 频道 / 帧门用例（`rfc152-*`）与 S-7 / S-28 的「广播瞬间 DB 已是 running」照跑。

## 6. 测试策略

受影响用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
