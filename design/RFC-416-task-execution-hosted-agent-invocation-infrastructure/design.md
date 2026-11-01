# RFC-416 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`HAI` =
`TE/composition/crewstationAgentInvocation.ts`，`MDR` = `TE/composition/crewstationMcpDiagnosticRunner.ts`。行号以 RFC-415 落库后的源码
（`e90d6fc4f`）为准，实施时按源码定位。形状沿用 RFC-405～415：主体原样迁移，只做落位；装配留在 composition。

## 1. 文件

| 来源                                                                                                                                                                                              | 去向                                                                                                   | 说明                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HAI` 全部（`HostedAgentProfile`、`HostedAgentParticipants`、`createHostedAgentParticipants`、`createHostedAgentInvocationPreparation`，51–525 行）                                               | `TE/infrastructure/crewstation/agentInvocationPreparation.ts`                                          | 原样迁移，只改 import 的相对路径（同目录的 `nativeMaterial` / `materialObjectUploads` / `runtimeEvents` / `agentContext` / `processEffectProjection` / `execution` 改为 `./x`，application 改为 `../../application/x`） |
| `MDR` 的会话部分：`taskId` / `executionId` / `directory` / `workspaceReference` / `find` 命名约定，`workspaceExists`、`cleanup`、`hasExecution`、`settled`，以及 `run` 里的托管工作区与 `compile` | `TE/infrastructure/crewstation/mcpDiagnosticSessions.ts` 的 `createHostedMcpDiagnosticSessions(input)` | 原样迁移；`run` 中构造 `invocation` 的那段成为会话的 `invocation(turn, log)`，返回同一个 `SystemAgentCoreInvocation` 对象                                                                                               |
| `MDR` 的 `run` 编排（创建 logger、`runSystemAgentCore(...)` 的参数）                                                                                                                              | `MDR` 原地                                                                                             | 绑定：`{ ...会话（不含 invocation）, run }`；`run` 以 `invocation(request, log)` 取调用，参数与原文相同（`retainScratchOnSuccess: true`、`retainedRef` 取调用的工作区）                                                 |

`HAI` 删除；四个托管 run family（`crewstationSystemAgentRunFamily.ts` / `crewstationRuntimeManagement.ts` / `crewstationTaskRunSelection.ts` /
`MDR` 的会话）与两个用例（`rfc370-m1-agent-material`、`rfc370-m1-agent-invocation-lifecycle`）改从 infrastructure 取用。`MDR` 的导出名与入参
类型不变：bootstrap（`S/bootstrap/crewstation.ts`）与 resource-catalog 的 `createCrewStationMcpDiagnosticsEffects` 不动。

## 2. 接口

```ts
// infrastructure/crewstation/mcpDiagnosticSessions.ts
export type HostedMcpDiagnosticInput = Pick<
  Parameters<typeof createHostedAgentInvocationPreparation>[0],
  | 'db'
  | 'fence'
  | 'api'
  | 'executions'
  | 'profiles'
  | 'startupInventoryAvailable'
  | 'nativeConfigAvailable'
  | 'nativeModelMappingAvailable'
  | 'pluginFiles'
  | 'materialEnvironment'
> & {
  readonly helper: WorkspaceHelper
  readonly reference: (taskId: string, path: string) => string
  readonly workspaces: {
    ensure(taskId: string): Promise<{ readonly businessTaskId: string }>
    open(taskId: string): Promise<{ readonly businessTaskId: string } | null>
    close(taskId: string): Promise<boolean>
  }
}
export interface HostedMcpDiagnosticTurn {
  readonly sessionId: string
  readonly turnId: string
  readonly intent: Omit<AgentMaterialIntent, 'workspace' | 'runContent' | 'nodeRunId' | 'log'>
  readonly beforeStart: () => Promise<void>
  readonly acknowledgeStarted: () => Promise<void>
  readonly observe?: (startedAt: number) => Promise<SystemAgentObservationRun>
}
export function createHostedMcpDiagnosticSessions(input: HostedMcpDiagnosticInput): {
  workspaceReference(sessionId: string): string
  workspaceExists(sessionId: string): Promise<boolean>
  cleanup(sessionId: string): Promise<boolean>
  hasExecution(turn: Turn): Promise<boolean>
  settled(turn: Turn): Promise<boolean>
  invocation(turn: HostedMcpDiagnosticTurn, log: Logger): SystemAgentCoreInvocation
}
```

绑定的 `run(request: HostedMcpDiagnosticTurn & { policy; timeoutMs; maxEventTextBytes })`：

1. 创建 `createLogger('hosted-mcp-runtime-test')`；
2. 取 `invocation(request, log)`；
3. 返回 `runSystemAgentCore({ ...request.policy, retainScratchOnSuccess: true }, { log, timeoutMs, maxEventTextBytes, startedAt: Date.now(),
retainedRef: invocation.workspace.retainedRef, invocation })`。

`retainedRef` 就是原文的 `workspaceReference(sessionId)`（工作区对象上的同一个值）。

## 3. 依赖规则

- 两个 infrastructure 新文件不 import 本模块或他模块的 composition（RFC-294 design §3 矩阵）。
- `mcpDiagnosticSessions.ts` 不 import `application/systemAgentRun`：用例调用留在绑定。
- `agentInvocationPreparation.ts` 保留对 `application/processEffectObserver` 的调用（proposal §6.3 偏离项），以及对
  `@/services/runtime`、`@/services/execution/agentInjection` 的 import（RFC-317 R2 不围 infrastructure，见 proposal §6.2）。
- `MDR` 只剩绑定：不调用 CrewStation API（`listFiles` / `getSubtask`）、托管执行（`adopt` / `workspaceSettled`）或工作区 helper（`call`），
  也不直接引用 `createHostedAgentInvocationPreparation`。

## 4. 必须保持

| 不变量                                                                                                                                | 现有锁 / 用例                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| profile 选择与 `hosted-runtime-profile-unmapped`、能力门的阻断清单与错误文本、冻结执行不读当日能力                                    | `rfc370-m1-agent-material`、`rfc370-m2-system-agent`          |
| 技能文件暂存 / 内联与 `binary skills require materialObjectsVersion`、1 MiB 上限、材料请求键 `aw-material:<digest>`、声明与不可观测面 | `rfc370-m1-agent-material`                                    |
| 执行：一次绑定、participant 解析、节点上下文校验、effect 括号、启动回执与确认失败、事件下沉、结果 / 脱离 / 未知的映射                 | `rfc370-m1-agent-invocation-lifecycle`、RFC-328 effect 括号锁 |
| MCP 会话：命名与目录、暂停 parent 的探测、清理条件、恢复判定的五个条件与 adopt 结算、`system-workspace` 准备参数与 `operationId`      | `rfc370-m2-mcp-diagnostics`                                   |
| 运行时探测与冒烟（经同一调用准备）                                                                                                    | `rfc370-m2-runtime-management`、`rfc370-hosted-runtime-probe` |

## 5. 守卫与账本

- RFC-328 effect 括号锁（`T/rfc328-architecture-guards.test.ts` 中 `HAI` 的 `execute` 条目）与 RFC-328 执行账本（`T/architecture/rfc328TaskExecutionLedger.ts`
  中「托管进程」的路径判定）改指 infrastructure 新路径，判据不变。
- `T/rfc370-m1-agent-material.test.ts`、`T/rfc370-m1-agent-invocation-lifecycle.test.ts` 改 import 路径。
- guard-manifest 新增一条；Windows 两份 `paths:` 与 suite 按 RFC-413～415 的惯例补上新文件与新用例。
- RFC-376 / commons-debt / 跨 context 账本中没有点名 `HAI` / `MDR` 的条目（实施时按实测核对）。

## 6. 测试

- **新增结构锁** `T/architecture/rfc416-hosted-agent-invocation-infrastructure.test.ts`，各项都带负例：
  - 被迁符号与新会话符号的 owner 唯一；
  - `HAI` 不复活，也不被引用；
  - `MDR` 不含托管调用（§3 最后一条）；
  - 两个 infrastructure 新文件不 import composition；
  - 会话文件不 import 系统代理核心。
- **端口绑定用例** `T/rfc416-port-bindings.test.ts`：
  - 会话交出的调用：工作区引用、`prepare` 先跑 `beforeStart` 再以原参数调用 `system-workspace`、`acknowledgeStart`、`observe` 透传；
  - 绑定的 `run` 经系统代理核心跑完一轮：伪造会话依赖，让编译以哨兵错误失败，核对核心记录的失败与 `retainedRef`。
- 搬迁涉及的既有用例只改 import 与源码锚点。
