# RFC-537 技术设计

## 1. 现状（HEAD `3f45fff30`，源码实读）

- **运行时**（`platform/events/committed/runtime.ts`）：模块级 `let activePump: AfterCommitEventPump | null`；
  `registerAfterCommitEventPump(pump | null)` 覆盖它；`releaseAfterCommitEventPump(pump)` 只在当前就是这个泵时清掉；
  `publishCommittedEventsAfterCommit(eventRefs)`——空批次返回“是否有泵”，没有泵返回 `false`，否则 `await pump.publishNow(eventRefs)`，抛错只记
  告警（持久投递会重试）并返回 `true`。
- **登记**：daemon 会话（`bootstrap/daemonSession.ts`）的 `after-commit-event-pump` 句柄工厂在 `start()` 里登记本会话的泵、`stop()` 里登记 `null`，
  `drain()` 等泵已接受的尝试结束。
- **写方**：25 处、17 个文件在事务提交后调它——collaboration 6 个（`taskQuestionDispatch`、`clarify/seal`、`clarify/autoDispatch`、`review`、
  `humanGateTerminalSweep`、`manualQuestionOpenWriter`），task-execution 11 个（`rootTaskAdmission`、`humanGateTaskLifecyclePersistence`、
  `taskLifecycle`、`fusionEngineTaskOperations`、`childExecutionLaunchOperations`、`taskRuntimeLifecyclePersistence`、`taskRouteOperations`、
  `repositoryPreparationRetryCommand`、`childTaskLifecycleParticipant`、`sourceTerminationParticipant`、`taskExecutionShutdownOperations`）。每处所在的
  函数都持有它提交所用的库（`db`、`args.db`、`this.db`、`dependencies.db` 等，经 `databaseSessionFor(…)`、`withSerializableTaskExecution(…)` 等入口
  开事务；有的在上方数百行处）。
- **句柄上下文**（`platform/persistence/sessionTables.ts`）：provider 构造库时 `bindDatabaseHandle(handle, tables, engine)` 给句柄挂一份冻结的上下文
  （身份、表集、引擎能力），句柄的原生会话客户端共用同一份，`inheritDatabaseHandle` 让派生句柄（事务等）也指向它；`databaseHandleContext(handle)`
  取回。
- **用例**：18 个用例文件经测试助手（`tests/helpers/taskLifecycleCommittedEvents.ts` 的 `installTaskLifecycleAfterCommitTestPump(db, …)` 等）登记
  进程级的泵。

## 2. 机制与落位

### D1 泵挂在句柄上下文上

- `DatabaseHandleContext` 加一格 `afterCommit`（一个可变的槽，`bindDatabaseHandle` 建上下文时一并建，派生句柄共用）。
- `runtime.ts` 删去模块级变量与两个登记函数，改为：
  - `attachAfterCommitEventPump(handle, pump): () => void`——把泵放进该句柄上下文的槽里，返回的摘除函数只在槽里还是这个泵时清空（与此前的
    `releaseAfterCommitEventPump` 同义）；
  - `publishCommittedEventsAfterCommit(handle, eventRefs)`——从该句柄上下文的槽取泵，其余逐字不变。

### D2 写方按提交所用的句柄投递

- 25 处调用补上句柄实参：都是所在函数提交所用的那个库（`args.db`、`db`、`this.db`、`dependencies.db` 等），逐处核对、不新增依赖。

### D3 daemon 会话挂在自己的库上

- `after-commit-event-pump` 句柄的 `start()` 改为 `release = attachAfterCommitEventPump(input.db, committedEventPump)`，`stop()` 调 `release()`；`drain()`
  不变。

### D4 用例与锁

- 新增 `tests/rfc537-database-after-commit-pump-boundary.test.ts`，登记 guard-manifest：① `runtime.ts` 顶层没有 `let` 与集合，架构报告的模块级
  可变单例判据为空；生产代码不再引用删去的名字；每处 `publishCommittedEventsAfterCommit` 调用都带句柄实参；daemon 会话把泵挂在 `input.db` 上
  （语料下限 3,000）；② 行为：两个库各投各的；事务句柄取到客户端的泵；空批次返回是否挂着泵、没有泵返回 `false`、泵抛错只记告警；摘除只摘
  自己挂的；带负对照。
- 读旧形状的用例随改：测试助手的泵改为挂在用例自己的库上（卸载即摘除）；直接调登记函数的用例改用挂接函数。

## 3. 清单（退出门）

| 名字                                                                          | 之后                                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `activePump` / `registerAfterCommitEventPump` / `releaseAfterCommitEventPump` | 删去；`attachAfterCommitEventPump(handle, pump)`            |
| `publishCommittedEventsAfterCommit(eventRefs)`                                | 改为 `publishCommittedEventsAfterCommit(handle, eventRefs)` |

## 4. 用例

- ① ～ ② 见 D4；既有用例覆盖提交后的即时投影与唤醒（任务生命周期、协作、评审、反问的 WS 投影与持久投递用例）。

## 5. 失败模式

- **写方拿错句柄**：句柄上下文按客户端共用，事务句柄与原生会话客户端都指向同一份；RFC-537 用例钉每处调用带句柄实参，并以事务句柄取泵的
  行为用例兜底；逐处核对实参是提交所用的那个库。没有挂泵的句柄照旧返回 `false`，持久投递照样送到（只少了即时性）。
- **会话停止后仍投递**：摘除后槽为空，结局同此前的“没有泵”。

## 6. 取舍（可推翻）

1. **挂在句柄上下文而不是 `databaseSessionFor` 的会话对象**：会话对象按句柄对象缓存，事务句柄会得到另一份；句柄上下文本来就让客户端、事务与
   原生会话共用，投递取到的一定是客户端挂的那个泵。
2. **写方显式带句柄而不是改成依赖注入**：25 处所在的函数都持有提交所用的库，带一个实参比把投递端口穿过两个模块的全部构造函数小得多，也让
   “投到提交所在的库”成为调用处可见的事实。

## 7. 对 RFC-294 刷新后规则的对账

- **C10**：组合层只把依赖往下交（daemon 会话挂泵）。**C11**：各模块 public 不变。**C12**：RFC-537 用例覆盖。**C13**：计数不升，模块级可变单例
  58 → 56。

## 8. 本步承担的演进与留下的债

- **承担**：S12 第 4 项第五步（已提交事件的即时投递泵，2 条）。
- **留下**：其余 56 条（见 RFC-536 plan 末尾的三类；进程级缓存与计数器须经用户确认是否保留并修订 §14 口径）。
