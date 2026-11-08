# RFC-468 技术设计

记号：`S/` = `packages/backend/src/`，`T/` = `packages/backend/tests/`，`RM/` = `S/modules/runtime-management/`，
`TE/` = `S/modules/task-execution/`。

## 0. 架构落位（RFC-294 第 8 条）

- RFC-294 plan §4.6 W9-D：`services/` 实现文件按 owner 归位。`services/nodeRunMint.ts` 的四块各归其主：冻结运行时归 runtime-management
  （唯一的生产调用方是它的任务运行时绑定），铸行入口与澄清血缘判定归 task-execution（node_runs 的 owner），转出与副本删除。
- 依赖倒置（RFC-465 先例）：冻结算法读写 node_run 运行时列的持久化端口由它的调用方 runtime-management 拥有，task-execution 实现它。端口
  有事务内会话回调，不经 public 导出（§6.1），task-execution 的现有实现按结构满足它。
- 不新增 context 边：task-execution 组合层把持久化交给 runtime-management 组合层的那一对文件已在跨 context 文件对清单里；`services/task.ts`
  改取 task-execution 的 `public/operations` 与 `public/queries`（合同入口）；其余改动都在各自 context 内部。

## 1. 冻结运行时归 runtime-management

`RM/application/ports/taskRuntimeFreezePersistence.ts`（新）：

```ts
import type { RuntimeConfigDirProfile } from '@agent-workflow/shared'
import type { RuntimeKind, RuntimeObservationIdentity, RuntimeProfile } from '../../public/types'

/** The frozen runtime columns of a node run, as the freeze reads them back. */
export interface FrozenTaskRuntimeRecord {
  readonly runtime: string | null
  readonly runtimeBinary: string | null
  readonly runtimeParamsJson: string | null
}

/** A runtime freshly selected for a node run's first dispatch. */
export interface SelectedTaskRuntime {
  readonly protocol: RuntimeKind
  readonly binary: string | null
  readonly params: RuntimeProfile
  readonly configDir: RuntimeConfigDirProfile
  readonly observationIdentity?: RuntimeObservationIdentity
}

export interface TaskRuntimeFreezeSession {
  load(): Promise<FrozenTaskRuntimeRecord | null>
  select(
    agentRuntime: string | null | undefined,
    defaultRuntime: string | null | undefined,
  ): Promise<SelectedTaskRuntime>
  freeze(input: {
    readonly nodeRunId: string
    readonly runtime: RuntimeKind
    readonly runtimeBinary: string | null
    readonly runtimeParamsJson: string
  }): Promise<void>
}

/** What the freeze needs from the node run's owner: one fenced selection session, and the read-back by native session. */
export interface TaskRuntimeFreezePersistence {
  withSelection<T>(
    nodeRunId: string,
    body: (session: TaskRuntimeFreezeSession) => Promise<T>,
  ): Promise<T>
  findBySessionId(sessionId: string): Promise<FrozenTaskRuntimeRecord | null>
}
```

字段与 task-execution `application/ports/nodeRunRuntimePersistence.ts` 的 `FrozenNodeRunRuntimeRecord`（`NodeRunConfigView` 的三列）、
`FrozenNodeRunRuntime`、`NodeRunRuntimeSelectionSession` 逐一相同；task-execution 的端口另有 `load` / `freeze` 两个方法（它自己的组合层与运行时
参与者在用），冻结算法不用。RFC-468 用例在编译期锁住：task-execution 的端口可赋给这个窄端口，两边的行记录类型双向相等。

`RM/infrastructure/local/frozenTaskRuntime.ts`（新）：`services/nodeRunMint.ts` 第 249～478 行原样迁入——`FrozenRuntime`、
`parseObservationIdentity`、`parseFrozenParams`、`parseFrozenConfigDir`、`configBackedBinary`、`resolveFrozenRuntimeWith`、
`frozenRuntimeOfSessionWith` 及其注释；两个入口的 `persistence` 参数类型由 task-execution 的端口改为上面的窄端口。import：`@/services/runtime`
（`RuntimeKind`、`tryGetRuntimeDriver`、`isKnownRuntimeKind`，infrastructure 层可取，不记 `R2`）、shared 的 `DEFAULT_CONFIG_DIR_PROFILE` 与
`RuntimeConfigDirProfile`、本 context 的 `public/types`、`util/log`（日志名 `nodeRunMint` 与事件名不变）。

`RM/infrastructure/local/taskAgentRuntimeBindings.ts`：两个入口与 `FrozenRuntime` 改取同目录的 `./frozenTaskRuntime`，工厂入参的
`persistence` 改为窄端口；不再取 task-execution。task-execution 组合层（`composition/localTaskAgentRunFamily.ts`）照旧把自己的持久化交给
runtime-management 组合层的 `composeLocalTaskAgentRuntimeBindings`，由编译器按结构检查。

## 2. 铸行入口归 task-execution

`TE/infrastructure/legacyNodeRunMint.ts`（新）：

```ts
export async function mintNodeRun(
  db: LegacySqliteNodeRunDatabase,
  args: NodeRunMintInput,
): Promise<string> {
  return await createLegacySqliteNodeRunOperations(db).lifecycle.mint(args)
}
```

函数体与原来逐字相同；参数类型由 `MintNodeRunArgs` 改为端口的 `NodeRunMintInput`（原来就是把参数原样交给 `lifecycle.mint`，后者收的正是
`NodeRunMintInput`；`MintNodeRunArgs` 的每个字段在 `NodeRunMintInput` 里同名同型，`MintInheritSource` 与 `NodeRunMintInheritance` 字段相同）。
文件名不带 provider 字样，`public/operations` 的转出不进 RFC-349 provider 切换的债务匹配。

`TE/public/operations.ts` 加一行 `export { mintNodeRun } from '../infrastructure/legacyNodeRunMint'`（RFC-344：operations 入口只查文件名与导出
形状）。`services/task.ts`：`mintNodeRun` 并入它已有的 `@/modules/task-execution/public/operations` import，`nextRetryIndex` 并入已有的
`@/modules/task-execution/public/queries` import（task-execution `public/queries` 已转出它，collaboration 在用）。

## 3. 判定归位，副本与死代码删除

| 原导出                                                                                     | 去处                                                                                   |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `continuesClarifyLineage`                                                                  | `TE/domain/clarifyRules.ts`（原样迁入，取 shared 的 `isClarifyRerunCause`）            |
| `isClarifyRerunCause` / `CLARIFY_RERUN_CAUSES`（shared 的转出）                            | 调用方改取 `@agent-workflow/shared`                                                    |
| `nextRetryIndex`（task-execution 的转出）                                                  | `services/task.ts` 改取 `TE/public/queries`                                            |
| `schedulerMintCause`（副本）                                                               | 删除；`TE/application/resolveSchedulerRunRow.ts` 的生产那份加 `export`，单元用例改测它 |
| `buildMintNodeRunValues`（只剩用例）                                                       | 删除；用例改取 `TE/application/buildNodeRunMintRecord`（它就是原函数体调的那一个）     |
| `loadRunEnvelopeNonce`、`mintNodeRunWith`                                                  | 删除（零调用方）                                                                       |
| `resolveSchedulerRunRow` 旧包装与 `SchedulerRunRowCandidate` 等三个类型                    | 删除（零调用方；生产四线走 `TE/application/resolveSchedulerRunRow`）                   |
| `MintableNodeRunStatus` / `MintInheritSource` / `MintNodeRunOverrides` / `MintNodeRunArgs` | 删除（端口 `NodeRunMintInput` 一族的可变副本）                                         |

`TE/composition/agentNodeExecution.ts`：`continuesClarifyLineage` 并入已有的 `../domain/clarifyRules` import，`isClarifyRerunCause` 并入已有的
shared import。最后 `services/nodeRunMint.ts` 删除。

## 4. 精确清单与账本

- RFC-294 preflight 与 RFC-376 结构守卫的跨 context 内部文件对精确清单删去
  `runtime-management/infrastructure/local/taskAgentRuntimeBindings.ts -> task-execution/application/ports/nodeRunRuntimePersistence.ts`（47 → 46）。
- RFC-349 provider 切换的 `PROVIDER_SPECIFIC_BUSINESS_DEPENDENCY_DEBT` 销账 `services/nodeRunMint.ts -> …/legacySqliteNodeRunOperations` 一条（铸行
  入口进了 task-execution infrastructure，按定义是机制边界）。
- RFC-328 架构守卫的 `WORKER_MUTATION_FILES` / `CANONICAL_MUTATION_SYMBOLS` 去掉 `services/nodeRunMint.ts`（它从无直接写，`mintNodeRunTx` 早已
  退役）。架构报告 legacy owner 表去掉这一行。
- `architecture/commons-manifest.json`：`mintnoderun-buildmintnoderunvalues-resolveschedulerr` 内核的文件改为 `TE/application/buildNodeRunMintRecord.ts`
  与 `TE/application/resolveSchedulerRunRow.ts`（它声明的两个单一事实源本来就在这两处），冻结运行时另立 runtime-management 内核
  `frozen-task-runtime`（`RM/infrastructure/local/frozenTaskRuntime.ts`）。
- `architecture/commons-debt.json` 的 `R1` 按实测销账（预期 79 → 71）；guard-manifest 刷新改到的守卫文件行数。

## 5. 用例

- **新用例** `T/rfc468-node-run-mint-split.test.ts`：`services/nodeRunMint.ts` 不在，src / 用例 / 脚本零 import 它（census AST，别名与相对路径都认，
  带负对照）；runtime-management 的绑定与冻结算法零取 task-execution、取自己的窄端口；编译期锁 task-execution 端口可赋给窄端口、两边行记录类型
  双向相等；`mintNodeRun` 由 `public/operations` 转出且就是 infrastructure 那一个，`services/task.ts` 经两个 public 入口取 `mintNodeRun` /
  `nextRetryIndex`；`continuesClarifyLineage` 在 `domain/clarifyRules.ts`、`agentNodeExecution` 从那里取；全仓只有一个 `schedulerMintCause` 定义。
- 受影响用例改 import 或改读新位置：铸行（`node-run-mint`、`rfc326` 等十个取 `mintNodeRun` 的）、冻结运行时（`rfc370-task-operation-configuration`、
  helper `nodeRunRuntime`、`rfc143` / `rfc349-runtime-registry-provider` 的源码锚点）、澄清（`rfc098-rerun-cause-gates`、`rfc183`、两个 `rfc187`、
  `rfc405-port-bindings`）、`rfc223-pr3a`（`buildNodeRunMintRecord`）、`rfc144-merge-state` 的工厂侧锁（改读 `buildNodeRunMintRecord.ts`）。断言不动。

## 6. 留下的债

- `services/task.ts` 的 9 条 `R1` 与它整体的去处。
- task-execution 与 runtime-management 各有一份运行时选择会话的形状（前者完整、后者窄）；收成一份要先让 public 合同能表达事务内回调，不在本 RFC。

## 7. 测试策略

受影响用例全部复跑（SQLite 全量 + PostgreSQL 受影响面）；新用例见 §5；P0 变异 lane 两引擎各 17 阶段。
