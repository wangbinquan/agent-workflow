# RFC-413 技术设计

路径缩写：`S` = `packages/backend/src`，`TE` = `S/modules/task-execution`，`T` = `packages/backend/tests`，`WM` = `TE/composition/wrapperMechanics.ts`，
`EMR` = `TE/composition/executionMergeRecovery.ts`，`WRL` = `TE/composition/wrapperRunLifecycle.ts`。行号以 RFC-412 落库后的源码为准，实施时按源码定位。
形状沿用 RFC-405～412：主体原样迁移，只做落位与端口替换；装配在 composition。

## 1. 文件

| 来源                                                                                                                                                                                                                                                       | 去向                                                                                                                                                                                                                                                                                                                  | 说明                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `EMR` 全部机制（`replaySubmodulesMissing`、`abandonSupersededRuns`、`scopeBaseHeads`、`replayPendingMerge`、`completeInterruptedRun`、`completeFrameMerges`、`completeInterruptedMerge`、`replayConflictHumanResolutions` 与 `recoverBeforeScope` 的主体） | `TE/engine/kernel/mergeRecovery.ts`                                                                                                                                                                                                                                                                                   | 导出 `recoverMergesBeforeScope(ports, log)`、`completeFrameMerges(ports, frame, log)`、`completeInterruptedMerge(ports, run, log)` |
| `WM` 的 `createOrRebuildWrapperIso`、`mergeBackWrapperIso`                                                                                                                                                                                                 | `TE/engine/kernel/wrapperIsolation.ts`                                                                                                                                                                                                                                                                                | 原样迁移，`state` 换成隔离机制端口                                                                                                 |
| `WM` 的 `createWrapperMechanicsPorts` 里 `workspace` 端口的实现与场景表、`diffableRepos`；`captureHead`、`captureGitPreDirty` 与两个上限常量                                                                                                               | `TE/engine/wrapper/wrapperWorkspace.ts`                                                                                                                                                                                                                                                                               | `createWrapperWorkspace(ports, log)` 返回端口与场景解析函数                                                                        |
| `WRL` 的 `createWrapperRunLedger` 与 `isSupersedableTransitionError` / `supersedingWrapperOutcome` / `clearWrapperReuseDisabled` / `settleTerminal`                                                                                                        | `TE/engine/wrapper/wrapperRunLedger.ts`                                                                                                                                                                                                                                                                               | `createWrapperRunLedger(ports)`，经持久化端口执行                                                                                  |
| `WRL` 的 `createWrapperStatusPublisher`                                                                                                                                                                                                                    | `TE/composition/wrapperRuntime.ts`                                                                                                                                                                                                                                                                                    | 只转发 infrastructure 的状态广播                                                                                                   |
| 新端口                                                                                                                                                                                                                                                     | `TE/application/ports/isolationMechanics.ts`（`IsolationMechanicsPorts`）；`wrapperWorkspace.ts` 增 `WrapperWorkspaceEnginePorts` / `WrapperWorkspaceScenes`；`wrapperRunLedger.ts` 增 `WrapperRunLedgerPorts`                                                                                                        | 只依赖本模块 domain / ports、platform contracts 与 shared                                                                          |
| 绑定                                                                                                                                                                                                                                                       | `TE/composition/isolationMechanicsBinding.ts`：`createIsolationMechanicsPorts(state)`、`composeExecutionMergeRecovery(state, log)`；`WM` 只剩 `createWrapperMechanicsPorts`（data / scopeDriver 转发、工作区与 fanout 端口构造）与 `fanoutInnerAgentKey`；`wrapperRuntime.ts` 增 `createWrapperRunLedgerPorts(state)` | 端口一律用 getter 读当前状态                                                                                                       |

`EMR`、`WRL` 删除。`agentNodeExecution.ts` 的 `completeInterruptedMerge` 改为
`completeInterruptedMerge(createIsolationMechanicsPorts(state), run, log)`；`runtimeAssembly.ts` 与
`infrastructure/taskExecutionRuntimeParticipants.ts` 改从绑定文件取 `composeExecutionMergeRecovery`。

## 2. 端口

```ts
// application/ports/isolationMechanics.ts
export type IsolationScope = Awaited<ReturnType<ExecutionWorkspaceSession['scope']>>
export type IsolationRestoreRequest = Omit<
  Parameters<ExecutionWorkspaceSession['restore']>[0],
  'submodules'
> & {
  /** 持久化的子模块拓扑（domain `parseIsoSubmodules` 的形状）；绑定按原文用 `restoredSubmodules` 转换。 */
  readonly submodules?: IsoSubmoduleTopology
}
export interface IsolationMechanicsPorts {
  readonly taskId: string
  readonly appHome: string
  readonly repos: TaskRepositoryMount[]
  readonly execution: TaskExecutionContextRef | undefined
  readonly writeSem: Semaphore
  readonly log: Logger // 执行状态的 log（建立 / 清理用，与原文同）
  readonly binding: IsolatedAgentRunBinding // 每次读取新建，同原文逐处 isolatedRunBinding(state)
  readonly cleanup: IsolationCleanupBinding // 每次读取新建，同原文逐处 bindIsolationCleanup()
  readonly persistence: {
    readonly nodeExecution: Pick<NodeExecutionPersistence, 'read' | 'list'>
    readonly mergeStates: Pick<MergeStateLifecyclePersistence, 'transition' | 'tryTransition'>
    readonly artifactPaths: Pick<TaskArtifactPathQueries, 'forcedPaths'>
  }
  readonly workspace: {
    scope(): Promise<IsolationScope>
    restore(request: IsolationRestoreRequest): Promise<IsoHandle>
  }
  readonly conflicts: MergeConflictResolver // 冲突时才构造合并 agent 端口，同原文
  completeHumanConflict(
    handle: IsoHandle,
    nodeTrees: Record<string, string>,
    log: Logger,
  ): Promise<HumanConflictOutcome>
}
```

- `IsoSubmoduleTopology` 是 `domain/isoSubmodules.ts` 给 `parseIsoSubmodules` 返回值起的类型名（只加类型名，不改函数）。
- `ExecutionIsolationWorkspace.snapshotIsolatedWorkspace` 的端口类型补上实现早已接受的可选 `forcedPaths`，wrapper 合回经
  `binding.workspace.snapshotIsolatedWorkspace(handle, log, forced)` / `mergeIsolatedWorkspace(handle, trees, log)` 调用——绑定里这两个
  就是原文直接 import 的同一对 infrastructure 函数。
- `WrapperWorkspaceEnginePorts = { isolation: IsolationMechanicsPorts; scopeOf(handle): WrapperGitScope }`，`WrapperGitScope` 取
  `IsolationScope` 的 `head` / `changedFiles` / `blobHashes`；`scopeOf` 绑定为 `workspaceRecord(handle).scope`。
- `WrapperWorkspaceScenes = { port: WrapperWorkspacePort; resolve(scene): { handle: IsoHandle; kind: WrapperNodeKind } }`：场景表归 engine，
  composition 的 scope driver 用 `resolve` 组装 nested 执行状态。
- `WrapperRunLedgerPorts`：`taskId`、`definition`、`containerOf`、`execution`、`log`（原文的 `createLogger('scheduler')`）、
  `persistence.{wrapperRuns, nodeRuns, nodeExecution}` 的 Pick、`consumedInputs(record)`（绑定为 infrastructure 的 `prepareConsumedInputs`）。

## 3. 依赖规则

- `TE/engine/kernel/` 新文件遵守 RFC-402 规则：只 import 本模块 `domain/`、`application/ports/`、`engine/kernel/`、`platform/contracts/`、shared 与
  node 内建；RFC-402 锁的 kernel 文件数 7 → 9。
- `TE/engine/wrapper/` 新文件只 import 本模块 `domain/`、`application/`、`engine/`、`platform/contracts/` 与 shared；不 import composition /
  infrastructure / `@/services` / `@/util`。
- composition 的绑定只构造端口；不再含隔离 / 合回 / 恢复 / 账本的流程。

## 4. 必须保持

| 不变量                                                                                                                                     | 现有锁 / 用例                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 恢复顺序：先收 `pending-merge` 被取代旧代，再补完顶层帧（`pending-merge` 再 `isolating`+`done`），最后人工冲突；wrapper 体在驱动前补完本帧 | RFC-339 cutover、RFC-144 / 369 / 370 用例 |
| 物理隔离键：`recoverKey(持久路径, 行 id)`；wrapper 再入前先读行（CAS 会清路径列）                                                          | RFC-356 T15、RFC-144 回归                 |
| 写锁窗口：wrapper 建立 / 合回、人工冲突完成、git 入口采集与改动扣减各在原锁内                                                              | RFC-188 / 208 / 287 用例                  |
| 合并状态转移事件、`via`、日志文本与告警字段                                                                                                | RFC-130 / 144 / 210 / 287 用例            |
| preDirty：4096 条 / 256 KiB 上限、超限与失败降级为空集、续跑不重采                                                                         | `scheduler-audit-s04`、RFC-098 用例       |
| 账本：可续跑代按帧 + 轮查找、再入 `allowedFrom` 与 reason、闭包按环境链解析后排序、容器铸造字段、park / 中断 / 终态与外部终态取代          | RFC-230 / 354 / 370 用例                  |

## 5. 守卫与账本

| 守卫 / 账本                                                                                                                                                                                                            | 处理                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| RFC-402 kernel 锁的文件数                                                                                                                                                                                              | 7 → 9                                  |
| 按旧路径取语料的锁（`executionMechanismSources.ts` 的 `WRAPPER_MECHANICS_SOURCE`、RFC-339 cutover、RFC-144 / 188 / 210 / 287 系列、RFC-395 checkpoint / 选择语义账本、shared `wrapper-kind-single-source` 等约 45 个） | 改读新 owner；守卫文件在文件内读 owner |
| commons-debt、跨 context 内部文件对、RFC-287 T1 清单                                                                                                                                                                   | 按实测更新，只降不升                   |
| guard-manifest、Windows 两份 `paths:` 与 suite、`architectureReport.ts`                                                                                                                                                | 按实测更新                             |

## 6. 测试

- 新增结构锁 `T/architecture/rfc413-wrapper-workspace-merge-recovery.test.ts`：被迁符号 owner 唯一；`EMR` / `WRL` 不复活、不被引用；
  `WM` 不再声明隔离 / 合回 / 采集函数；kernel 与 wrapper 新文件的 import 层级；每项带纯伪造输入的负例。
- 端口绑定用例 `T/rfc413-port-bindings.test.ts`：绑定按原文逐项转发（getter 读当前状态、`binding` / `cleanup` 每次新建、子模块拓扑转换、
  冲突端口延迟构造）；用伪造端口驱动 `completeFrameMerges` 的跳过 / 顺序与 git 入口采集的上限降级。
- 搬迁涉及的既有用例只改 import、构造与源码锚点。
