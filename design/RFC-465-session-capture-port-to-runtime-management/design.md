# RFC-465 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`L/` = `S/services/`，`RM/` = `S/modules/runtime-management/`，
`TE/` = `S/modules/task-execution/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 实现文件按 owner 归位；运行时驱动一族归 runtime-management 之前，先把驱动接缝上的合同收回
  runtime-management。本 RFC 收最后一条 `R2`：runtime-management 材料证据端口取 `services/runtime/types` 的会话捕获 / 清扫形状。
- 依赖倒置：会话捕获的持久化端口由它的调用方（运行时驱动，runtime-management 一族）拥有，task-execution 实现它；捕获请求与清扫合同由
  runtime-management 的材料证据端口定义，`services/runtime/` 的驱动侧形状在其上加本机位置字段。不新增 context 边：task-execution →
  runtime-management 是目标 DAG 给的边，经 `public/participants`。

## 1. 持久化端口迁入 runtime-management

`RM/application/ports/runtimeSessionCapturePersistence.ts`（自 `TE/application/ports/` 迁入，旧文件删除）：

```ts
import type { PersistedEventKind } from './agentObservations'

export interface RuntimeSessionCaptureEvent {
  readonly ts: number
  readonly kind: PersistedEventKind | 'stderr' | 'subagent_capture_failed'
  readonly payload: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
}

export interface RuntimeSessionCapturePersistence {
  …三个方法与注释逐字不变…
}
```

原来的 kind 是 `NodeExecutionEventSnapshot['kind']`（task-execution 落库的 9 个 kind）；`PersistedEventKind` 是 runtime-management 观测词汇
去掉不落库的 `startup_inventory` 后的 7 个，加 `stderr` 与 `subagent_capture_failed` 正好 9 个。RFC-465 用例编译期锁两者双向相等。

- `RM/public/participants.ts` 导出这两个类型（只有字面量联合、只读集合与 Promise，不带开放类型）。
- `RM/application/ports/agentLiveCapture.ts` 改取同目录的端口：runtime-management → task-execution 的跨 context 内部文件对随之消失。
- task-execution 改取 `@/modules/runtime-management/public/participants`：`application/ports/taskExecutionPersistence.ts`（聚合端口的
  `runtimeSessionCapture` 成员）与 `infrastructure/runtimeSessionCapturePersistence.ts`（实现，写自己的 `node_run_events`，不变）。
- 驱动的两个会话捕获实现（`L/runtime/opencode/sessionCapture.ts`、`L/runtime/claudeCode/sessionCapture.ts`）改取同一处：三条 G-01 `R1`
  销账（连同 `L/runtime/types.ts` 的那条）。

## 2. 捕获请求与清扫合同归 runtime-management

`RM/application/ports/agentMaterialEvidence.ts` 删去取 `@/services/runtime/types` 的 import，直接定义（字段、可选性与可写性与原来的
`Omit<SessionCaptureContext, …>`、`SystemAgentSessionSweepContext`、`SystemAgentSessionSweepOutcome` 逐一相同）：

```ts
export interface AgentSessionCaptureRequest {
  rootSessionId: string
  logicalRootSessionId?: string
  nodeRunId: string
  taskId: string
  persistence: RuntimeSessionCapturePersistence
  log: Logger
  alreadyInsertedPartIds?: ReadonlyMap<string, ReadonlySet<string>>
}

export interface SystemAgentSessionSweepRequest {
  rootSessionId: string
  sink: SystemAgentEventSinkV1
  log: Logger
}

export interface SystemAgentSessionSweepOutcome {
  failed: boolean
  failureReason?: unknown
}
```

`RM/public/participants.ts` 把这三个与 `AgentMaterialEvidence` 放在同一条导出里按名导出。

清扫 sink 由结构副本改为直接取 `SystemAgentEventSinkV1`：原副本的 `markTerminal` 未完成原因少一个 `stream-frame-limit-exceeded`（驱动从不传
它）；调用方传进来的本来就是完整的 `SystemAgentEventSinkV1`（`systemAgentRun` 的 `opts.eventSink`），opencode 的清扫实现
（`captureOpencodeSessionsToSink`）收的也是它，现在驱动侧看到的是同一份合同。

`L/runtime/types.ts`：

```ts
import type {
  AgentSessionCaptureRequest,
  SystemAgentSessionSweepOutcome,
  SystemAgentSessionSweepRequest,
} from '@/modules/runtime-management/public/participants'
export type { SystemAgentSessionSweepOutcome }

export interface SessionCaptureContext extends AgentSessionCaptureRequest {
  worktreePath: string
  configDirEnv?: string
  configDirName?: string
  opencodeDbPath?: string // 四个位置字段与注释原样保留
}

export type SystemAgentSessionSweepContext = SystemAgentSessionSweepRequest
```

删去取 task-execution 端口的 import 与只被结构副本用到的 `NormalizedEventKind` 本地 import（它的再导出不变）。`RuntimeDriver`、
runtime-management 本地材料证据与两个驱动材料实现的 import 都不动。

## 3. 用例与锁

- **新用例** `T/rfc465-session-capture-port-to-runtime-management.test.ts`：旧端口文件不在、src / 用例 / 脚本零引用旧路径；两个端口类型只在
  runtime-management 定义一次、`public/participants` 导出的就是它；runtime-management 的 application / domain / engine / public 零取
  `@/services/` 与 task-execution（census AST，带负对照）；`services/runtime/types` 不取 task-execution、捕获上下文扩展捕获请求、清扫上下文与
  结果取 runtime-management 的合同（源码锚点）；编译期：事件 kind 与 task-execution 落库的 kind 双向相等，`SessionCaptureContext` 去掉四个位置
  字段后与捕获请求双向相等，清扫上下文与清扫请求、清扫 sink 与 `SystemAgentEventSinkV1`、两份清扫结果各自双向相等。
- 改指：`rfc370-agent-invocation-preparation`、`rfc370-agent-material-evidence` 的端口 import；`rfc462` 的「`agentMaterialEvidence` 只剩会话
  捕获 / 清扫上下文取 `services/runtime/types`」精确清单改为零；RFC-294 preflight 与 RFC-376 结构守卫的跨 context 内部文件对精确清单删去
  `agentLiveCapture` 那一对；public surface 偏差精确清单按实测改（删去 `AgentMaterialEvidence` 取 `services/runtime/types` 的 3 条，新增清扫
  结果 `unknown` 失败原因的 1 条）。
- 账本：`commons-debt.json` 的 `R2` 1 条、`R1` 3 条按实测销账（baseline 99 / 1 → 96 / 0）；guard-manifest 按实测刷新（新用例不是登记的守卫
  文件）。

## 4. 留下的债

- 驱动一族（`L/runtime/**`）仍在 `services/`：下一步归 runtime-management infrastructure，届时驱动直接取 application 端口。
- `L/runtime/opencode/subagentLiveCapture.ts` 取 runtime-management 的 `application/ports/agentLiveCapture`（一条 `R1`）随驱动一族归位。

## 5. 失败模式

- kind 漂移：task-execution 的事件 kind 与 runtime-management 的观测词汇任一侧增减，RFC-465 用例的双向相等在编译期红。
- 清扫 sink 合同：驱动看到完整的 `SystemAgentEventSinkV1`，行为不变（传入的对象本就是它）。

## 6. 测试策略

受影响用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §3；P0 变异 lane 两引擎各 17 阶段。
