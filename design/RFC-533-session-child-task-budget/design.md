# RFC-533 技术设计

## 1. 现状（HEAD，源码实读）

`modules/task-execution/infrastructure/childBudget.ts`（366 行）：

- `class ChildTaskBudget`（计数、等待队列、放行与长等告警；`rebuildFromDb`、`onChildTaskStatus`、`onCapacityChanged`）本身无模块状态。
- 模块级状态与入口（架构报告的模块级可变单例清单里 8 条）：
  - `let singleton` / `let singletonSource`：`ensureChildTaskBudget(source, capacity)` 第一次被调时建、`rebuildFromDb`，换了查询对象就重建；
  - `const childness = new Map()`：`registerKnownChildTask` 写入，`notifyChildBudgetTaskStatus` 读写；
  - `let liveCapacity`：`setChildTaskBudgetCapacity` 写入并 `onCapacityChanged()`，`ensure` 在为空时以第一个调用者的 `capacity()` 播种；
  - `let liveMaxInvocationDepth`：`setMaxInvocationDepth` 写入，`currentMaxInvocationDepth(frozen)` 读 `live ?? frozen ?? 3`；
  - `resetChildTaskBudgetForTests`。
- 调用处：`composition/childCallNodeExecution.ts` 的 `budget` 端口（`maxInvocationDepth` / `ensureBudget` / `parentTaskId` /
  `registerKnownChildTask`）；`bootstrap/daemonSession.ts` 的已提交事件消费者 `notifyChildBudget`；`bootstrap/daemonHttpComposition.ts` 的并发热应用
  `apply(input)` 只调 `setChildTaskBudgetCapacity(input.maxActiveChildTasks)`。
- 缺陷：热应用输入 `ConfigConcurrencyHotApplyInput` 带 `maxInvocationDepth`（system-operations 的保存用例照常交出），但 `d38ada9ed`（2026-09-01）
  删掉了 `setMaxInvocationDepth(updated.maxInvocationDepth)`，此后 `setMaxInvocationDepth` 在生产里没有调用方，`liveMaxInvocationDepth` 恒为空。

执行许可登记表 `createExecutionPermitRegistry()` 已是每会话一份：`bootstrap/daemonModules/taskExecution.ts` 构造，经
`createTaskExecutionPersistence(..., { runtime: { executionPermits, processConcurrencyScope, … } })` 进运行期选项，provider 上也带一份给热应用。

## 2. 机制与落位

### D1 会话的子任务预算（task-execution infrastructure）

`childBudget.ts` 删去全部模块级状态，导出工厂：

```ts
export interface ChildTaskBudgetLimits {
  readonly maxActiveChildTasks: number
  readonly maxInvocationDepth: number
}
export interface ChildTaskBudgetRuntime {
  /** 会话的预算；第一次用到子调用时以调用方的容量播种并从库重建（不用子调用的任务零开销）。 */
  ensure(seedCapacity: () => number): Promise<ChildTaskBudget>
  /** 生命周期放行；预算未建时什么都不做。 */
  notifyStatus(taskId: string, to: TaskStatus): void
  registerKnownChild(taskId: string): void
  /** 保存设置的热应用：实时容量（并重扫等待队列）与实时调用链深度。 */
  applyLimits(limits: ChildTaskBudgetLimits): void
  /** 深度判据的唯一读点：保存过设置就取实时值，否则取冻结值，再否则 3。 */
  maxInvocationDepth(frozen: number | undefined): number
}
/** 入参与 `ChildTaskBudget` 的构造参数相同：查询对象，或用例沿用的 SQLite 句柄。 */
export function createChildTaskBudgetRuntime(
  source: ChildTaskBudgetQueries | LegacySqliteChildBudgetSource,
): ChildTaskBudgetRuntime
```

闭包里持有此前的四个模块变量与 `childness` 缓存，逻辑逐字搬入；“换查询对象就重建”随之没有了（一份运行期只服务一个会话的查询对象，
会话换库时整个 task-execution 装配重建）。

### D2 交入与读取

- `bootstrap/daemonModules/taskExecution.ts`：在执行许可登记表旁构造 `createChildTaskBudgetRuntime(persistence.childBudget)`（持久化的查询对象
  建好之后），与 `executionPermits` 一样经运行期依赖进 `BoundRunTaskOptions.childTaskBudget`，provider 上也带一份。
- `composition/childCallNodeExecution.ts` 的 `budget` 端口改读 `state.opts.childTaskBudget`。
- `bootstrap/daemonSession.ts` 的 `notifyChildBudget` 调会话的 `childTaskBudget.notifyStatus(taskId, status)`。
- `bootstrap/daemonHttpComposition.ts` 的热应用：`childTaskBudget.applyLimits({ maxActiveChildTasks, maxInvocationDepth })`（G2：深度一并推入）。
- `composition.ts` 删去 `setChildTaskBudgetCapacity`、`notifyChildBudgetTaskStatus` 的转出，导出工厂与类型。

### D3 用例与锁

- 新增 `tests/rfc533-session-child-task-budget-boundary.test.ts`，登记 guard-manifest：① `childBudget.ts` 顶层没有 `let`，没有导出的
  `set*` / `register*` / `reset*`；生产代码不再引用删去的名字；② 行为：两份运行期互不相通；未建时放行什么都不做；`applyLimits` 改容量后
  已排队的等待者立刻按新容量放行、改深度后 `maxInvocationDepth` 取新值；③ 回归：daemon 的热应用把深度推给会话的预算（源码锁钉
  `applyLimits` 的实参）；带负对照。
- 读旧形状的锁与用例随改：用 `setChildTaskBudgetCapacity` / `resetChildTaskBudgetForTests` 的用例改用会话的运行期或新建一份；构造原始运行期选项的
  用例补 `childTaskBudget`；钉热应用源码的 `rfc266-concurrency-hot-apply` 随改。

## 3. 清单（退出门）

| 名字                                                                                                               | 之后                                  |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `singleton` / `singletonSource` / `liveCapacity` / `liveMaxInvocationDepth`                                        | `createChildTaskBudgetRuntime` 的闭包 |
| `registerKnownChildTask` / `setChildTaskBudgetCapacity` / `setMaxInvocationDepth` / `resetChildTaskBudgetForTests` | 删去（运行期的方法）                  |
| 热应用只推容量                                                                                                     | 容量与深度一并推给会话的预算          |

## 4. 用例

- ① ～ ③ 见 D3；既有用例覆盖子任务配额的准入与放行（`rfc243-*`、`rfc287-*`）、热应用（`rfc266-concurrency-hot-apply`）与子调用节点。

## 5. 失败模式

- **预算跨会话串扰**：每个会话一份，生命周期放行与热应用都调本会话的那份；RFC-533 用例钉两份互不相通。
- **懒建语义变了**：`ensure` 照旧第一次用到才建并从库重建、以调用方的容量播种；未建时放行照旧什么都不做。
- **深度热应用改变已在跑的链**：判据只在派生的那一刻读，已在跑的子任务不受影响（与界面文案一致）。

## 6. 取舍（可推翻）

1. **预算挂在运行期选项上，与执行许可登记表同路**：两者都是会话级的准入状态，热应用也在同一处；不另开通道。
2. **深度的实时值放进预算**：深度判据与配额同属子调用的准入，同一个线性化点热应用。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层不变（只改读取处）。**C11**：各模块 public 不变。**C12**：RFC-533 用例覆盖。**C13**：计数不升，模块级可变单例 79 → 71。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第一步（task-execution 的子任务预算，8 条），顺带恢复深度热应用。
- **留下**：其余 71 条（`process-registrations` 的两条策略登记、执行看门、按对象挂的侧表、platform / util 的进程级缓存；后者需要保留的由后继
  design 提出、经用户确认后修订 §14 口径）。
