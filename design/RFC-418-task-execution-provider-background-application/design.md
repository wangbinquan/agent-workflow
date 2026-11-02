# RFC-418 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`PB` = `TE/composition/providerBackground.ts`。
行号以 RFC-417 落库后的源码（`ffde0e5f6`）为准。形状沿用 RFC-413～417：主体原样迁移，只做落位与端口替换；装配留在 composition。

## 1. 文件

| 来源                                                                                            | 去向                                                                                                | 说明                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PB` 的 `isPeriodicReconcileDue`、`createRestartableLoop`、`createProviderLoops` 与会话控制主体 | `TE/application/providerBackground.ts`（会话控制为 `createTaskExecutionProviderBackground(ports)`） | 原样迁移；变量名保留（`runtime` / `dependencies` / `loops`），只做下表的端口替换                                                                                 |
| 端口                                                                                            | `TE/application/ports/providerBackground.ts`                                                        | `ProviderBackgroundModule<TTicket>`、`TaskExecutionProviderBackgroundPorts<TTicket>`、`ProviderBackgroundStart`、`ProviderBackgroundControl`                     |
| `PB` 原地                                                                                       | 绑定                                                                                                | `composeTaskExecutionProviderBackground(runtime)` 构造端口，`start(dependencies)` 映射为 application 的启动入参；`TaskExecutionProviderBackground*` 两个类型保留 |

端口替换：

| 原文                                                                                          | application                                                                                               |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DAEMON_CADENCE.autoRepair` / `.autoKill` / `.orphanReconcileSupervisory`、`SCHEDULE_TICK_MS` | `runtime.cadence.autoRepairMs()` / `autoKillMs()` / `orphanReconcileSupervisoryMs()` / `scheduleTickMs()` |
| `runHeartbeatKillOnce({ operations: runtime.recovery, … findStalledRuns, killChild })`        | `runtime.sweeps.heartbeatKill({ breaker, heartbeatStallMs, occurredAt })`                                 |
| `reconcileDeadRunningRuns({ operations: runtime.recovery, taskHasDriver, graceMs: 60_000 })`  | `runtime.sweeps.orphanReconcile()`                                                                        |
| `runDueSchedulesOnce(dependencies.scheduled.operations, { … })`                               | `dependencies.scheduled.runDue({ maxFailures, defaultRuntime })`                                          |
| `createFileTaskBackgroundConfigurationQuery(dependencies.configPath)`                         | `runtime.fileConfiguration(dependencies.configPath)`                                                      |
| `TaskExecutionModule` / 其票据                                                                | `ProviderBackgroundModule<TTicket>`                                                                       |

## 2. 端口

```ts
export interface ProviderBackgroundModule<TTicket extends { readonly token: { readonly taskId: string } }> {
  pause(reason: string): Promise<readonly TTicket[]>
  resume(): void
  dispose(reason: string): Promise<readonly TTicket[]>
  awaitIdle(): Promise<void>
  readonly runtimeRegistry: { awaitStopped(ticket: TTicket): Promise<unknown> }
}
export interface TaskExecutionProviderBackgroundPorts<TTicket …> {
  readonly recoveryConsumer?: { tick(): Promise<void> }
  readonly module: ProviderBackgroundModule<TTicket>
  readonly lifecycleRepair: TaskLifecycleAutoRepairCommand
  readonly autoResume: TaskAutoResumeCommand
  readonly cadence: { autoRepairMs(): number; autoKillMs(): number; orphanReconcileSupervisoryMs(): number; scheduleTickMs(): number }
  readonly fileConfiguration: (configPath: string) => TaskBackgroundConfigurationQuery
  readonly sweeps: {
    heartbeatKill(input: { breaker: { maxPerWindow; windowMs }; heartbeatStallMs; occurredAt: number }): Promise<void>
    orphanReconcile(): Promise<void>
  }
}
export interface ProviderBackgroundStart {
  readonly configPath?: string
  readonly configuration?: TaskBackgroundConfigurationQuery
  readonly scheduled: {
    readonly loadConfig?: () => Config | Promise<Config>
    runDue(input: { maxFailures; defaultRuntime }): Promise<void>
  }
}
```

`ProviderBackgroundControl` 与原 `TaskExecutionProviderBackgroundControl` 的成员一致，只把 `start` 的入参换成 `ProviderBackgroundStart`。

## 3. 依赖规则

- `TE/application/providerBackground.ts` 与端口文件不 import infrastructure / composition，也不 import `@/services`（RFC-317 R2 围栏）。
- `PB` 只剩绑定：不再声明循环、定时器与会话状态（不出现 `setTimeout(`、`createRestartableLoop`、`isPeriodicReconcileDue`、`startupRun`）。

## 4. 必须保持

| 不变量                                                                           | 现有锁 / 用例                                                                 |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 五条循环的名字、节奏与读取时机；孤儿对账的固定监督拍与「醒来再判」；关闭位置不扫 | `rfc349-orphan-reconcile-hot-apply`、`rfc349-task-execution-provider-runtime` |
| 后台配置源的选择、`loadConfig` 兼容覆盖、启动读与自动续跑的排空边界、错误文本    | `rfc370-task-background-configuration`                                        |
| pause（先通知驱动再等循环）、resume、stop / close 的顺序与票据排空、串行化       | `rfc349-*` provider 会话用例                                                  |
| 自动修复调用形状 `await runtime.lifecycleRepair.run({`                           | `rfc244-alert-resolved-boot-wiring`                                           |

## 5. 守卫与账本

读 `PB` 源码的锁改读 `TE/application/providerBackground.ts`：

- `rfc349-task-execution-provider-runtime`：循环名、pause / stop 片段；
- `rfc349-orphan-reconcile-hot-apply`：睡眠片段改断言 `orphanReconcileSupervisoryMs()`，其余判据不变；
- `rfc244-alert-resolved-boot-wiring`。

`isPeriodicReconcileDue` 的 import 改指 application。guard-manifest 新增一条；Windows 两份 `paths:` 中的 `PB` 保留（仍是绑定文件），并补上新文件与新用例。

## 6. 测试

- **新增结构锁** `T/architecture/rfc418-provider-background-application.test.ts`，各项都带负例：
  - 符号 owner 唯一；
  - `PB` 不含 §3 的流程记号；
  - application 新文件不 import infrastructure / composition / `@/services`。
- **端口绑定用例** `T/rfc418-port-bindings.test.ts`：
  - 绑定把 `start` 映射为 application 入参：`loadConfig` 覆盖只在未给 `configuration` 时生效，`runDue` 携带 `SCHEDULE_MAX_IN_FLIGHT` 与
    `onAutoDisable`；
  - 节奏 getter 读 `DAEMON_CADENCE`；
  - 两个清扫以原参数调用 legacy 函数（伪造 recovery operations 观察）。
- 搬迁涉及的既有用例只改 import 与源码锚点。
